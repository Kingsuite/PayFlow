# PayFlow Contract Limits

> **Auto-generated table** -- do not edit by hand.
> Run `node scripts/emit-caps-table.mjs --check` to verify this file is in sync
> with `contract/src/` and `scripts/lib/contract-limits.ts`.

This table is the operator-facing reference for every hard cap enforced by the
deployed contract.  The authoritative values live in:

- **Contract (Rust):** `contract/src/batch.rs`, `contract/src/lib.rs`,
  `contract/src/migration.rs`, `contract/src/spending_limit.rs`,
  `contract/src/upgrade.rs`
- **Scripts (TypeScript):** `scripts/lib/contract-limits.ts`

## Batch sizes

| Constant | Value | Description |
|---|---|---|
| `MAX_BATCH_SIZE` | 50 | Default maximum users per `batch_charge` call |
| `MAX_BATCH_SIZE_CEILING` | 200 | Hard ceiling on `set_max_batch_size` |
| `MAX_BATCH_PAUSE` | 25 | Maximum subscriptions per batch pause call |
| `MAX_WHITELIST_BATCH` | 50 | Maximum addresses per whitelist batch operation |

## Schema version

| Constant | Value | Description |
|---|---|---|
| `CURRENT_SCHEMA_VERSION` | 2 | Current on-chain storage schema version |

## Ledger-time constants

| Constant | Value | Description |
|---|---|---|
| `LEDGERS_PER_DAY` | 17280 | Approximate ledgers per day (~5 s/ledger) |
| `UPGRADE_TTL_LEDGERS` | 17280 | TTL for pending WASM upgrade proposals |
| `SUBSCRIPTION_TTL_LEDGERS` | 6307200 | Subscription entry TTL (~1 year) |

## Amount limits (token base units)

| Constant | Value | Description |
|---|---|---|
| `MAX_AMOUNT` | 100000000000 | Maximum single pay-per-use amount |
| `MAX_SUBSCRIPTION_AMOUNT` | 100000000000000 | Maximum subscription charge amount |
| `GLOBAL_MAX_VOLUME_PER_HOUR` | 50000000000000 | Global max volume per hour (all merchants) |

## Token decimals

| Constant | Value | Description |
|---|---|---|
| `XLM_DECIMALS` | 7 | XLM decimal places (1 XLM = 10^7 stroops) |
| `STROOPS_PER_XLM` | 10000000 | Stroops per XLM |

> ⚠️ **Multi-token note:** `XLM_DECIMALS` and `STROOPS_PER_XLM` apply only to
> XLM and XLM-derived SAC tokens. Non-XLM SEP-41 tokens may use different decimal
> counts — always query the token's `decimals()` entry-point rather than
> hard-coding these values for arbitrary tokens.

## Other constants

| Constant | Value | Description |
|---|---|---|
| `HOUR_IN_SECONDS` | 3600 | Seconds per hour |
