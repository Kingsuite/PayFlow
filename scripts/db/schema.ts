/**
 * db/schema.ts — Public entry point for the indexer SQLite schema.
 *
 * This module owns the schema version constant and the migration runner.
 * Migrations live as numbered, forward-only files under `db/migrations/`
 * and are applied in order inside a transaction, so a crash mid-migration
 * cannot leave a partially-migrated database.
 *
 * The remaining DB helpers (openDatabase, getMeta, setMeta, upsertEvents,
 * parseEvent, stableEventKey, indexEvents) are re-exported from indexer.ts
 * for a stable import path.
 */

import type { Database } from "better-sqlite3";

/**
 * The single source of truth for the schema version.
 * Bump this when adding a new numbered migration file.
 */
export const SCHEMA_VERSION = 2;

export interface Migration {
  /** Monotonically increasing version this migration brings the DB to. */
  version: number;
  /** Human-readable name, used for logging. */
  name: string;
  /** Apply the migration. Must be idempotent. */
  up: (db: Database) => void;
}

/**
 * Numbered, forward-only migrations. Each entry upgrades the DB from
 * `version - 1` to `version`. Migrations must be idempotent so that a
 * re-run after a partial failure does not fail (e.g. `duplicate column name`).
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          contract_id TEXT NOT NULL,
          ledger INTEGER NOT NULL,
          type TEXT NOT NULL,
          topics TEXT NOT NULL,
          value TEXT NOT NULL,
          tx_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_contract ON events (contract_id);
        CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
      `);
    },
  },
  {
    version: 2,
    name: "add_merchant_column",
    up: (db) => {
      const columns = db
        .prepare(`PRAGMA table_info(events)`)
        .all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "merchant")) {
        db.exec(`ALTER TABLE events ADD COLUMN merchant TEXT;`);
      }
    },
  },
];

/**
 * Apply all pending migrations up to SCHEMA_VERSION.
 *
 * Each migration runs inside its own transaction; the schema_version meta
 * row is updated in the same transaction so a crash rolls back both the
 * schema change and the version bump together.
 */
export function runMigrations(db: Database): void {
  const row = db
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  const current = row ? parseInt(row.value, 10) : 0;

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    if (migration.version > SCHEMA_VERSION) break;

    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(migration.version));
    });
    apply();
  }
}

export {
  openDatabase,
  initSchema,
  getMeta,
  setMeta,
  upsertEvents,
  parseEvent,
  stableEventKey,
  indexEvents,
  type DedupIndexResult,
} from "../indexer.js";
