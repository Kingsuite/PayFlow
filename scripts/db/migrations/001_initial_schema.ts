/**
 * Migration 001 — initial indexer schema.
 *
 * Forward-only. Idempotent: every statement uses IF NOT EXISTS so a re-run
 * after a partial failure is safe. The runner wraps this in a transaction.
 */
import type { Database } from "better-sqlite3";

export const version = 1;

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL,
      ledger INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_contract ON events (contract_id);
    CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);

    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
