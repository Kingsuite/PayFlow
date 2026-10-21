# FlowPay Scripts — Environment Variable Reference

> **Source of truth:** [`scripts/config.ts`](../scripts/config.ts) — the canonical variables are validated by the Zod schema in that file. Keep them in sync.
>
> **The example file:** [`scripts/.env.example`](../scripts/.env.example) documents *every* variable read by a script under `scripts/`, including the ones that are not part of the Zod schema. It is the file `smoke-config.ts` and `validate-config.ts` check.

## Env file lookup

`scripts/validate-config.ts` looks for an env file in this order:

1. `scripts/.env.local`
2. `scripts/.env`
3. `<repo root>/.env.local`
4. `<repo root>/.env`
5. `scripts/.env.example` (fallback, so the shipped example can be checked in CI)

`--env-file <path>` validates an explicit file instead. The repository-root
`.env.example` documents the root tooling's variables only.

## Canonical Variables

| Variable | Required | Type | Constraints / Default | Used By | Purpose |
| --- | --- | --- | --- | --- | --- |
| `CONTRACT_ID` | Yes | string | Non-empty; starts with `C`; 56-char base32 | All scripts | Deployed FlowPay contract ID |
| `RPC_URL` | Yes | string | Valid http/https URL | All scripts | Soroban RPC endpoint |
| `SECRET_KEY` | Yes* | string | Stellar secret key: starts with `S`, 56 chars | keeper | Keeper signing key (live mode) |
| `KEEPER_PUBLIC_KEY` | Yes | string | Stellar public key: starts with `G`, 56 chars | keeper | Source account public key |
| `BATCH_SIZE` | No | integer (coerce) | 1–200; default `50` | keeper | Subscribers per `batch_charge` call. The 200 ceiling mirrors the contract’s `MAX_BATCH_SIZE_CEILING` (`contract/src/caps.rs`) |
| `INTERVAL_SECONDS` | No | integer (coerce) | ≥ 60; default `3600` | keeper | Seconds between charge cycles |
| `WEBHOOK_URL` | No | string | Valid http/https URL | alert-expiring-allowances, alert-failed-charges | Webhook POST target |
| `WEBHOOK_SECRET` | No | string | Non-empty if provided | alert-expiring-allowances, alert-failed-charges | HMAC-SHA256 signing key for webhooks |
| `WEBHOOK_DLQ_FILE` | No | string | File path | alert-expiring-allowances, alert-failed-charges | Dead-letter queue for failed webhooks |
| `NETWORK_PASSPHRASE` | No | string | Default: `Test SDF Network ; September 2015` | keeper, check-allowances | Stellar network passphrase |
| `DRY_RUN` | No | boolean | `"true"` enables; default `false` | keeper | Simulation mode (no live submissions) |
| `KEEPER_USE_LEGACY_PAGING` | No | boolean | `"true"` enables; default `false` | keeper | Use legacy sequential paging |
| `LOG_LEVEL` | No | string | `debug` \| `info` \| `warn` \| `error`; default `info` | keeper, indexer, health-check, alert-failed-charges | Log verbosity |
| `LOG_FORMAT` | No | string | `"json"` for JSON lines | keeper, indexer, health-check, alert-failed-charges | Log output format |
| `DATA_DIR` | No | string | Default `data` | indexer, query-events | SQLite database directory |
| `DB_FILE` | No | string | Default `DATA_DIR/events.db` | indexer, query-events | SQLite database path override |
| `POLL_INTERVAL_MS` | No | integer | Default `10000` | indexer | Event polling interval (ms) |
| `START_LEDGER` | No | integer | Unset → latest ledger | indexer | First-run start ledger |
| `METRICS_PORT` | No | integer | Default `9090` | metrics-server | HTTP listen port for `/metrics` |
| `REPORT_DIR` | No | string | Default `<script_dir>/data/benchmarks` | keeper | Dry-run reports & live-cycle pointer |
| `ALERT_WINDOW_LEDGERS` | No | integer | Default `17280` (~24h) | alert-expiring-allowances | Expiry alert threshold (ledgers) |
| `SOROBAN_SOURCE_ACCOUNT` | No | string | Stellar public key | deploy-pipeline, top-merchants | Source account for read-only RPC queries |

\* `SECRET_KEY` is required only in live mode (`DRY_RUN` not `"true"`).

## Additional Variables (not part of the Zod schema)

These are read by individual scripts. They are documented with their
defaults in [`scripts/.env.example`](../scripts/.env.example).

| Variable | Type | Default | Used By | Purpose |
| --- | --- | --- | --- | --- |
| `ADMIN_SECRET_KEY` | string | — | soroban-admin, onboard-merchant | Admin signing key. Secret |
| `KEEPER_SECRET_KEY` | string | falls back to `SECRET_KEY` | keeper-benchmark | Benchmark signing key. Secret |
| `USER_SECRET` | string | — | topup-allowance | Subscriber signing key. Secret |
| `RPC_URLS` | string (CSV) | `RPC_URL` | rpc-client | Failover list of RPC endpoints |
| `DLQ_FILE` | string | `dlq/failed-batches.jsonl` | keeper, replay-dlq | Dead-letter queue path |
| `KEEPER_MAX_RETRIES` | integer | `3` | replay-dlq | Retry attempts per DLQ entry |
| `KEEPER_RETRY_BASE_MS` | integer | `1000` | replay-dlq | Base retry delay (ms) |
| `MAX_BATCH_SIZE` | integer | on-chain value, else `50` | batch-optimizer | Batch-size override (clamped to 200) |
| `MAX_CYCLE_USERS` | integer | unlimited | batch-optimizer | Ready subscribers scheduled per cycle |
| `PAGE_SIZE` | integer | `50` (max 50) | batch-optimizer, subscriber-health-dashboard | Subscriber page size |
| `TOKEN_ADDRESS` | string | — | topup-allowance | SAC token whose allowance is topped up |
| `USER_ADDRESS` | string | — | topup-allowance | Allowance owner |
| `AMOUNT` | string | — | topup-allowance | Allowance amount in stroops |
| `EXPIRY_LEDGERS` | integer | `17280` | topup-allowance | Ledgers the new allowance stays valid |
| `CONCURRENCY` | integer | `5` | alert-expiring-allowances, check-allowances | Parallel checks |
| `MAX_RETRIES` | integer | `3` | alert-expiring-allowances, check-allowances | Retry attempts |
| `RETRY_BASE_MS` | integer | `300` | alert-expiring-allowances, check-allowances | Base retry delay (ms) |
| `INDEXER_DB` | string | `indexer.db` | alert-failed-charges, churn-analysis | Indexer database path |
| `INDEXER_DB_PATH` | string | `data/events.db` | backup-indexer-db, churn-analysis, export-merchant-report | Indexer database path |
| `BACKUP_DIR` | string | `data/backups` | backup-indexer-db | Backup destination |
| `EVENT_DEDUP_TTL_MS` | integer | `0` | indexer, watch-events | Event dedup cache TTL (ms) |
| `EVENT_DEDUP_CACHE_SIZE` | integer | `10000` | event-dedup | Event dedup cache size |
| `EXPIRING_TTL_LEDGERS` | integer | `500000` | subscriber-health-dashboard | TTL considered `expiring` |
| `LEDGER_ENTRY_BATCH` | integer | `100` | subscriber-health-dashboard | Ledger entries per page |
| `GRACE_ALERT_THRESHOLD_PCT` | integer | `25` | grace-period-monitor | Grace-alert threshold (%) |
| `KEEPER_HEARTBEAT_PATH` | string | `<scripts>/data/keeper-heartbeat.json` | grace-period-monitor | Keeper heartbeat file |
| `ALERT_WEBHOOK_URL` | string | `WEBHOOK_URL` | grace-period-monitor | Grace-period alert target |
| `MERCHANT_ONBOARD_WEBHOOK_URL` | string | — | onboard-merchant | Onboarding result target |
| `SLACK_WEBHOOK_URL` | string | — | daily-revenue-summary | Daily revenue summary target |
| `FRIENDBOT_URL` | string | `https://friendbot.stellar.org` | testnet-setup | Testnet account funding |
| `NETWORK` | string | `testnet` | health-check | `mainnet` switches the passphrase |
| `HEALTH_DEEP` | boolean | `false` | health-check | Run the deep health checks |
| `DEBUG` | string | unset | watch-events | Verbose watch-events output |
| `PROGRESS` | string | unset | subscriber-health-dashboard | `0` disables progress output |
| `VITE_CONTRACT_ID` / `VITE_RPC_URL` / `VITE_NETWORK_PASSPHRASE` / `VITE_DEFAULT_TOKEN` | string | — | several | Frontend-style fallbacks |

## Deprecated Aliases (with fallback + warning)

| Deprecated Alias | Canonical Name | Status | Notes |
| --- | --- | --- | --- |
| `KEEPER_SECRET` | `SECRET_KEY` | Deprecated | Emits deprecation warning; canonical takes precedence if both set |
| `NETWORK_PASSTHRASE` | `NETWORK_PASSPHRASE` | Deprecated (typo) | Emits deprecation warning; canonical takes precedence if both set |

## Stale / Unread Variables (present in older examples, not read by current code)

| Variable | Status | Notes |
| --- | --- | --- |
| `CHARGE_INTERVAL_MS` | Stale | Listed in old `.env.example`; **not read** by current `keeper.ts` |
| `PAGE_SIZE` | Not stale | Read by `batch-optimizer.ts` and `subscriber-health-dashboard.ts` (page size, default 50) |
| `MAX_RETRIES` | Not stale | Read by `alert-expiring-allowances.ts` and `check-allowances.ts` (retry attempts, default 3) |
| `BACKFILL_START_LEDGER` | Stale | Removed from the root `.env.example`; the backfill facility only exists in the dead root `indexer.ts` stub |
| `BACKFILL_END_LEDGER` | Stale | Removed from the root `.env.example`; same as above |
| `BACKFILL_RATE_LIMIT` | Stale | Removed from the root `.env.example`; same as above |
| `BACKFILL_CHECKPOINT_FILE` | Stale | Removed from the root `.env.example`; same as above |

## Script-to-Variable Matrix

| Script | Reads These Variables |
| --- | --- |
| `keeper.ts` | `CONTRACT_ID`, `RPC_URL`, `RPC_URLS`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY`, `DRY_RUN`, `BATCH_SIZE`, `INTERVAL_SECONDS`, `KEEPER_USE_LEGACY_PAGING`, `NETWORK_PASSPHRASE`/`NETWORK_PASSTHRASE`, `LOG_LEVEL`, `LOG_FORMAT`, `REPORT_DIR`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_DLQ_FILE`, `ALERT_WINDOW_LEDGERS` |
| `indexer.ts` | `CONTRACT_ID`, `RPC_URL`, `RPC_URLS`, `DATA_DIR`, `DB_FILE`, `POLL_INTERVAL_MS`, `START_LEDGER`, `LOG_LEVEL`, `LOG_FORMAT` |
| `metrics-server.ts` | `METRICS_PORT` |
| `deploy-pipeline.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT`, `NETWORK_PASSPHRASE` |
| `pre-upgrade-check.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT`, `NETWORK_PASSPHRASE` |
| `top-merchants.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT`, `NETWORK_PASSPHRASE` |
| `check-allowances.ts` | `CONTRACT_ID`, `RPC_URL`, `NETWORK_PASSPHRASE`, `KEEPER_PUBLIC_KEY` |
| `alert-expiring-allowances.ts` | `CONTRACT_ID`, `RPC_URL`, `NETWORK_PASSPHRASE`, `KEEPER_PUBLIC_KEY`, `WEBHOOK_URL`, `WEBHOOK_SECRET`, `ALERT_WINDOW_LEDGERS` |
| `health-check.ts` | `CONTRACT_ID`, `RPC_URL`, `NETWORK_PASSPHRASE`, `HEALTH_DEEP` |
| `subscription-snapshot.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `daily-revenue-summary.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT`, `WEBHOOK_URL`, `SLACK_WEBHOOK_URL` |
| `export-merchant-report.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `watch-events.ts` | `CONTRACT_ID`, `RPC_URL`, `NETWORK_PASSPHRASE` |
| `query-events.ts` | `CONTRACT_ID`, `DATA_DIR`, `DB_FILE` |
| `backup-indexer-db.ts` | `DATA_DIR`, `DB_FILE`, `BACKUP_DIR` |
| `replay-dlq.ts` | `CONTRACT_ID`, `RPC_URL`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY`, `DLQ_FILE` |
| `replay-events.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT`, `START_LEDGER` |
| `rotate-fee-collector.ts` | `CONTRACT_ID`, `RPC_URL`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY` |
| `migrate-contract.ts` | `CONTRACT_ID`, `RPC_URL`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY` |
| `onboard-merchant.ts` | `CONTRACT_ID`, `RPC_URL`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY` |
| `grace-period-monitor.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `alert-failed-charges.ts` | `CONTRACT_ID`, `RPC_URL`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY`, `WEBHOOK_URL`, `WEBHOOK_SECRET` |
| `batch-optimizer.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `churn-analysis.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `merchant-analytics.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `subscriber-churn-report.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `subscriber-health-dashboard.ts` | `CONTRACT_ID`, `RPC_URL`, `NETWORK_PASSPHRASE`, `PAGE_SIZE`, `LEDGER_ENTRY_BATCH`, `EXPIRING_TTL_LEDGERS`, `PROGRESS` |
| `topup-allowance.ts` | `CONTRACT_ID`, `RPC_URL`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY` |
| `fee-revenue-report.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `audit-trail.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `snapshot-diff.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `renewal-forecast.ts` | `CONTRACT_ID`, `RPC_URL`, `SOROBAN_SOURCE_ACCOUNT` |
| `testnet-setup.ts` | `CONTRACT_ID`, `RPC_URL`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY` |
| `validate-config.ts` | All canonical variables (validates `.env`) |
| `soroban-admin.ts` | `CONTRACT_ID`, `RPC_URL`, `SECRET_KEY`/`KEEPER_SECRET`, `KEEPER_PUBLIC_KEY` |

## Validation Test

A parity test exists at [`scripts/config.test.ts`](../scripts/config.test.ts) that validates:
- Canonical names take precedence over deprecated aliases
- Deprecation warnings are emitted when aliases are used
- The Zod schema accepts valid values and rejects invalid ones

Run it with:
```bash
cd scripts && npm test -- --reporter=verbose config.test.ts
```