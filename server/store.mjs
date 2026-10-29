import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class Store {
  constructor(filename) {
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  put(kind, value) {
    const item = {
      ...value,
      id: value.id || randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO records VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at WHERE records.kind=excluded.kind",
      )
      .run(item.id, kind, JSON.stringify(item), item.updatedAt);
    return item;
  }
  get(kind, id) {
    const row = this.db
      .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.payload) : undefined;
  }
  list(kind) {
    return this.db
      .prepare(
        "SELECT payload FROM records WHERE kind=? ORDER BY updated_at DESC",
      )
      .all(kind)
      .map((r) => JSON.parse(r.payload));
  }
  setting(key, value) {
    if (value !== undefined)
      this.db
        .prepare(
          "INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, JSON.stringify(value));
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(row.value) : undefined;
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
