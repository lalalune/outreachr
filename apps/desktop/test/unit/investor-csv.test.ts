import { describe, expect, it } from 'vitest';
import { MAX_CSV_ROWS, parseInvestorCsv } from '../../src/main/investor-csv';

describe('investor CSV parsing', () => {
  it('reads UTF-8 BOM, quoted commas, quotes and multiline cells', () => {
    const result = parseInvestorCsv(
      '\uFEFFname,type,description,person_name,work_email\r\n"Example, Capital",angel,"Line one\r\n""quoted"" line two",Ada Partner,ada@example.test\r\n',
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      row: 2,
      name: 'Example, Capital',
      kind: 'angel',
      description: 'Line one\r\n"quoted" line two',
      personName: 'Ada Partner',
      workEmail: 'ada@example.test',
    });
  });
  it('supports common headers and reports ignored fields without importing rights flags', () => {
    const result = parseInvestorCsv(
      'firm_name,contact_name,email,is_public\nExample,Partner,partner@example.test,true',
    );
    expect(result.rows[0]).toMatchObject({
      name: 'Example',
      kind: 'venture_capital',
      personName: 'Partner',
    });
    expect(result.rows[0]).not.toHaveProperty('is_public');
    expect(result.ignoredColumns).toEqual(['is_public']);
  });
  it.each([
    ['name\n"unterminated', 'quoted field'],
    ['name\n"closed"extra', 'closing quote'],
    ['name\nnot"quoted', 'Unexpected quote'],
    ['name,firm_name\nA,A', 'ambiguous'],
    ['website\nhttps://example.test', 'requires a name'],
    ['name', 'at least one'],
    ['name\nA\0', 'NUL'],
  ])('rejects malformed CSV: %s', (input, message) => {
    expect(() => parseInvestorCsv(input)).toThrow(message);
  });
  it('reports invalid rows with row numbers and rejects unsafe websites and unnamed contacts', () => {
    const result = parseInvestorCsv(
      'name,type,website,work_email\nA,invalid,,\nB,angel,https://user:pass@example.test,\nC,angel,,c@example.test\nD,angel',
    );
    expect(result.rows).toEqual([]);
    expect(result.errors.map((error) => error.row)).toEqual([2, 3, 4, 5]);
  });
  it('bounds records and columns', () => {
    expect(() => parseInvestorCsv('name\n' + 'A\n'.repeat(MAX_CSV_ROWS + 1))).toThrow('data rows');
    expect(() =>
      parseInvestorCsv(
        Array.from({ length: 65 }, (_, index) => `column${index}`).join(',') + '\nA',
      ),
    ).toThrow('64 columns');
  });

  it('keeps error row numbers accurate after empty spreadsheet rows', () => {
    const result = parseInvestorCsv('name,type\n\nExample,invalid\n');
    expect(result.totalRows).toBe(1);
    expect(result.errors[0]?.row).toBe(3);
  });
});
