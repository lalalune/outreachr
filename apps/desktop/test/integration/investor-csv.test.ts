import { writeFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VaultService } from '../../src/main/vault-service';
import {
  initializedVault,
  onboard,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../helpers/vault';

describe('private investor CSV import', () => {
  const directories: string[] = [];
  const services: VaultService[] = [];
  async function fixture(text: string) {
    const directory = await temporaryDirectory('csv-import');
    directories.push(directory);
    const service = await initializedVault(directory);
    services.push(service);
    await onboard(service);
    const path = join(directory, 'investors.csv');
    await writeFile(path, text);
    return { service, path, directory };
  }
  afterEach(async () => {
    for (const service of services.splice(0)) service.vault.close();
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });
  const validCsv =
    'name,type,person_name,work_email,is_public\nCSV Capital,angel,Partner One,one@csv.test,true\nCSV Capital,angel,Partner Two,two@csv.test,true\nCSV Capital,angel,Partner One,one@csv.test,true';

  it('previews without writes, imports private contactable records, and skips repeated imports', async () => {
    const { service, path, directory } = await fixture(validCsv);
    const before = service.vault.scalar('SELECT COUNT(*) FROM firms');
    const preview = await service.previewInvestorCsv(path);
    expect(preview).toMatchObject({
      totalRows: 3,
      newInvestors: 1,
      newPeople: 2,
      skippedRows: 1,
      errors: [],
      ignoredColumns: ['is_public'],
    });
    expect(service.vault.scalar('SELECT COUNT(*) FROM firms')).toBe(before);
    expect(await service.importInvestorCsv(path, preview.sha256)).toEqual({
      importedInvestors: 1,
      importedPeople: 2,
      skippedRows: 1,
    });
    const firm = (await service.bootstrap()).investors.find((item) => item.name === 'CSV Capital')!;
    expect((await service.investorDetail(firm.id)).people).toHaveLength(2);
    expect(
      (await service.investorDetail(firm.id)).people.every((person) => person.canSendInitial),
    ).toBe(true);
    expect(
      service.vault.one('SELECT is_public,contribution_eligible FROM firms WHERE id=?', [firm.id]),
    ).toEqual({ is_public: 0, contribution_eligible: 0 });
    expect(
      service.vault.scalar(
        'SELECT COUNT(*) FROM people WHERE firm_id=? AND (is_public=1 OR contribution_eligible=1)',
        [firm.id],
      ),
    ).toBe(0);
    expect(await service.importInvestorCsv(path, preview.sha256)).toEqual({
      importedInvestors: 0,
      importedPeople: 0,
      skippedRows: 3,
    });
    const reopened = await initializedVault(directory);
    services.push(reopened);
    expect(reopened.integrityCheck().ok).toBe(true);
    expect(reopened.auditIntegrity().ok).toBe(true);
    expect((await reopened.investorDetail(firm.id)).people).toHaveLength(2);
  });

  it('rejects a changed file and rechecks contact ownership when committing a preview', async () => {
    const { service, path } = await fixture(validCsv);
    const preview = await service.previewInvestorCsv(path);
    await writeFile(path, validCsv + '\nChanged,angel,,,false');
    await expect(service.importInvestorCsv(path, preview.sha256)).rejects.toThrow(
      'changed after preview',
    );
    await writeFile(path, validCsv);
    const firm = await service.createInvestor({ name: 'Existing Owner Capital', kind: 'angel' });
    await service.createPerson({
      firmId: firm.id,
      name: 'Existing Owner',
      workEmail: 'one@csv.test',
    });
    await expect(service.importInvestorCsv(path, preview.sha256)).rejects.toThrow('invalid rows');
    expect(service.vault.scalar('SELECT COUNT(*) FROM firms WHERE name=?', ['CSV Capital'])).toBe(
      0,
    );
  });

  it('preserves existing investor metadata and blocks partial writes for invalid rows', async () => {
    const { service, path } = await fixture(
      'name,type,website\nExisting Capital,angel,https://new.test\nInvalid Capital,unknown,',
    );
    const firm = await service.createInvestor({
      name: 'Existing Capital',
      kind: 'micro_vc',
      website: 'https://original.test',
    });
    const preview = await service.previewInvestorCsv(path);
    expect(preview.errors).toHaveLength(1);
    await expect(service.importInvestorCsv(path, preview.sha256)).rejects.toThrow('invalid rows');
    expect(
      service.vault.one('SELECT investor_type,website FROM firms WHERE id=?', [firm.id]),
    ).toEqual({ investor_type: 'micro_vc', website: 'https://original.test' });
    expect(
      service.vault.scalar('SELECT COUNT(*) FROM firms WHERE name=?', ['Invalid Capital']),
    ).toBe(0);
  });

  it('combines complementary new investor details and rejects contradictory rows', async () => {
    const { service, path } = await fixture(
      'name,type,website,headquarters\nCombined Capital,angel,,NYC\nCombined Capital,angel,https://combined.test,',
    );
    const preview = await service.previewInvestorCsv(path);
    expect(preview.errors).toEqual([]);
    await service.importInvestorCsv(path, preview.sha256);
    expect(
      service.vault.one("SELECT website,headquarters FROM firms WHERE name='Combined Capital'"),
    ).toEqual({ website: 'https://combined.test', headquarters: 'NYC' });
    await writeFile(
      path,
      'name,type,website\nConflict Capital,angel,https://one.test\nConflict Capital,angel,https://two.test',
    );
    const conflicting = await service.previewInvestorCsv(path);
    expect(conflicting.errors[0]?.message).toContain('Conflicting details');
    await expect(service.importInvestorCsv(path, conflicting.sha256)).rejects.toThrow(
      'invalid rows',
    );
    expect(service.vault.scalar("SELECT COUNT(*) FROM firms WHERE name='Conflict Capital'")).toBe(
      0,
    );
  });

  it('rolls back new firms if a database constraint rejects a person', async () => {
    const { service, path } = await fixture(validCsv);
    const preview = await service.previewInvestorCsv(path);
    service.vault.run(
      "CREATE TRIGGER reject_csv_person BEFORE INSERT ON people WHEN NEW.full_name='Partner Two' BEGIN SELECT RAISE(ABORT,'fixture person constraint'); END",
    );
    await expect(service.importInvestorCsv(path, preview.sha256)).rejects.toThrow(
      'fixture person constraint',
    );
    expect(service.vault.scalar("SELECT COUNT(*) FROM firms WHERE name='CSV Capital'")).toBe(0);
    expect(
      service.vault.scalar("SELECT COUNT(*) FROM contact_methods WHERE value='one@csv.test'"),
    ).toBe(0);
    expect(service.integrityCheck().ok).toBe(true);
  });

  it('rejects oversized and non-UTF-8 selected files', async () => {
    const { service, path } = await fixture('name\nExample');
    await truncate(path, 5 * 1024 * 1024 + 1);
    await expect(service.previewInvestorCsv(path)).rejects.toThrow('5 MiB');
    await writeFile(path, new Uint8Array([0xff, 0xff]));
    await expect(service.previewInvestorCsv(path)).rejects.toThrow('UTF-8');
  });
});
