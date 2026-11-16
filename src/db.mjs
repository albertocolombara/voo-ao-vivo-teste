// Banco em memória com o SQLite que já vem no Node 22, na mesma interface do Cloudflare D1
// usada por src/index.js (prepare/bind/first/all/run e batch).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const clean = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));
const plain = (row) => (row ? { ...row } : null);

export function openDb(schemaPath) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(schemaPath, 'utf8'));
  class Stmt {
    constructor(sql) {
      this.sql = sql;
      this.args = [];
    }
    bind(...a) {
      this.args = clean(a);
      return this;
    }
    async first(col) {
      const r = plain(sqlite.prepare(this.sql).get(...this.args));
      return col ? r?.[col] ?? null : r;
    }
    async all() {
      return { results: sqlite.prepare(this.sql).all(...this.args).map(plain) };
    }
    async run() {
      sqlite.prepare(this.sql).run(...this.args);
      return { success: true };
    }
  }
  const DB = {
    prepare: (sql) => new Stmt(sql),
    batch: async (stmts) => {
      for (const s of stmts) await s.run();
      return [];
    },
  };
  function insert(table, row) {
    const cols = Object.keys(row);
    sqlite.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...clean(cols.map((c) => row[c])));
  }
  const all = (sql, ...args) => sqlite.prepare(sql).all(...clean(args)).map(plain);
  return { DB, insert, all };
}
