import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { CoreVault } from '../src/index.js';

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs();
});

const foreignKeysEnabled = (vault: CoreVault): boolean =>
  Number(vault.db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0]) === 1;

describe('vault connection pragmas', () => {
  it('enables foreign keys on a new vault', () => {
    expect(foreignKeysEnabled(new CoreVault(SQL))).toBe(true);
  });

  it('keeps foreign keys enabled across export()', () => {
    // sql.js closes and reopens the connection inside export(), which resets
    // connection-scoped pragmas. The vault persists by exporting after every
    // mutation, so losing the pragma here disables enforcement for the rest of
    // the session.
    const vault = new CoreVault(SQL);
    vault.export();
    expect(foreignKeysEnabled(vault)).toBe(true);
    vault.export();
    expect(foreignKeysEnabled(vault)).toBe(true);
  });

  it('still cascades deletes after a persist cycle', () => {
    const vault = new CoreVault(SQL);
    vault.run('CREATE TABLE parent (id TEXT PRIMARY KEY)');
    vault.run(
      'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE)',
    );
    vault.run("INSERT INTO parent VALUES ('p1')");
    vault.run("INSERT INTO child VALUES ('c1', 'p1')");

    vault.export();
    vault.run("DELETE FROM parent WHERE id = 'p1'");

    expect(vault.db.exec('SELECT count(*) FROM child')[0]?.values[0]?.[0]).toBe(0);
    expect(vault.db.exec('PRAGMA foreign_key_check')[0]).toBeUndefined();
  });
});
