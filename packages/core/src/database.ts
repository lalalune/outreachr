import initSqlJs, {
  type BindParams,
  type Database,
  type SqlJsConfig,
  type SqlJsStatic,
  type SqlValue,
} from 'sql.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

export type Row = Record<string, SqlValue>;

export interface OpenVaultOptions {
  readonly bytes?: Uint8Array;
  readonly appliedAt?: string;
}

export class CoreVault {
  readonly sqlite: SqlJsStatic;
  readonly db: Database;
  #transactionDepth = 0;
  #savepointSequence = 0;

  constructor(sqlite: SqlJsStatic, options: OpenVaultOptions = {}) {
    this.sqlite = sqlite;
    this.db = options.bytes ? new sqlite.Database(options.bytes) : new sqlite.Database();
    this.#applyConnectionPragmas();
    migrate(this.db, options.appliedAt ?? new Date().toISOString());
  }

  #applyConnectionPragmas(): void {
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA recursive_triggers = OFF');
  }

  get schemaVersion(): number {
    return SCHEMA_VERSION;
  }

  run(sql: string, params: BindParams = []): void {
    this.db.run(sql, params);
  }

  all<T = Row>(sql: string, params: BindParams = []): T[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  one<T = Row>(sql: string, params: BindParams = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  scalar(sql: string, params: BindParams = []): SqlValue | null {
    const row = this.one(sql, params);
    if (!row) return null;
    const value = Object.values(row)[0];
    return value ?? null;
  }

  transaction<T>(operation: () => T): T {
    const root = this.#transactionDepth === 0;
    const savepoint = `outreachr_nested_${++this.#savepointSequence}`;
    this.db.run(root ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const result = operation();
      this.db.run(root ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (root) {
        this.db.run('ROLLBACK');
      } else {
        this.db.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.run(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  export(): Uint8Array {
    const bytes = this.db.export();
    // sql.js closes and reopens the underlying connection inside export(), which
    // resets connection-scoped pragmas to their SQLite defaults. Without this the
    // vault silently loses foreign-key enforcement after its first persist, so
    // ON DELETE CASCADE stops firing and deletes leave orphaned rows behind.
    this.#applyConnectionPragmas();
    return bytes;
  }

  integrityCheck(): { ok: boolean; messages: string[] } {
    const messages = this.all<{ integrity_check: SqlValue }>('PRAGMA integrity_check').map((row) =>
      String(row.integrity_check),
    );
    const foreignKeyRows = this.all('PRAGMA foreign_key_check');
    return {
      ok: messages.length === 1 && messages[0] === 'ok' && foreignKeyRows.length === 0,
      messages: [...messages, ...foreignKeyRows.map((row) => JSON.stringify(row))],
    };
  }

  close(): void {
    this.db.close();
  }
}

export async function initializeSqlite(config: SqlJsConfig = {}): Promise<SqlJsStatic> {
  return initSqlJs(config);
}

export async function openVault(
  config: SqlJsConfig = {},
  options: OpenVaultOptions = {},
): Promise<CoreVault> {
  const sqlite = await initializeSqlite(config);
  return new CoreVault(sqlite, options);
}
