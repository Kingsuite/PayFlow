# Contract Event Mapping to Database Schema

This document maps contract events (from `contract/src/events.rs`) to the indexer database schema (`scripts/indexer.ts`).

## Database Schema

The indexer stores events in SQLite:

```sql
CREATE TABLE events (
  id         TEXT    PRIMARY KEY,      -- Stable dedup key: <tx_hash>:<op_index>:<event_index>
  event_name TEXT    NOT NULL,         -- Topic[0] from contract event
  address    TEXT    NOT NULL,         -- Topic[1] (subscriber/actor address)
  amount     TEXT,                     -- Extracted from event value (gross, amount, net, fee)
  ledger     INTEGER NOT NULL,         -- Ledger sequence
  timestamp  INTEGER NOT NULL,         -- Unix seconds from ledgerClosedAt
  tx_hash    TEXT    NOT NULL,         -- Transaction hash for dedup
  raw_data   TEXT    NOT NULL,         -- Full JSON event value
  merchant   TEXT,                     -- Extracted from event value
  fee_amount TEXT,                     -- Extracted from event value
  token      TEXT,                     -- Extracted from event value (token, asset)
  result_code TEXT                     -- Extracted from event value (result_code, error, status)
);
```

## Contract Events → Indexer Rows

### Subscription Lifecycle

| Event | Topic[0] | Topic[1] | Example Row |
|-------|----------|----------|-------------|
| subscribe | `subscribed` | user_address | `event_name='subscribed', address=user, merchant=merchant, amount=subscription_amount` |
| cancel | `cancelled` | user_address | `event_name='cancelled', address=user` |
| cancel (refund) | `cancelled_with_refund` | user_address | `event_name='cancelled_with_refund', address=user, amount=refund_amount` |
| pause | `paused` / `subscription_paused` | user_address | `event_name='paused', address=user` |
| resume | `resumed` / `subscription_auto_resumed` | user_address | `event_name='resumed', address=user` |
| transfer | `subscription_transferred` | from_user | `event_name='subscription_transferred', address=from_user, raw_data={to_user, ...}` |

**Note:** The `cancelled` event is emitted by all cancellation paths (single cancel, batch_cancel). The `batch_cancel` function returns a `CancelResult` enum (discriminants 0-4) describing the outcome per user, but does not emit per-user events beyond the standard `cancelled` event.
**Note:** As of the latest contract version, `batch_cancel` distinguishes between
routine cancels (`Cancelled`), paused subscription cancels (`PausedCancelled`),
and merchant-frozen cancels (`MerchantFrozen`). All three emit the same `cancelled`
event; the distinction is in the return value discriminant. See `docs/cancel-results.md`.

### Charging & Pay-Per-Use

| Event | Topic[0] | Topic[1] | Example Row | Alerting Relevance |
|-------|----------|----------|-------------|-------------------|
| charge success | `charged` | user_address | `event_name='charged', address=user, amount=gross, fee_amount=fee, merchant=merchant, raw_data={..., paid_to: fee_recipient}` | ✓ Confirms successful charge |
| batch summary | `batch_charge_skips` | (none) | `event_name='batch_charge_skips', raw_data={total, charged, allowance_insufficient, ...}` | **✓ CHARGE FAILURE SIGNAL** |
| pay-per-use | `pay_per_use` | user_address | `event_name='pay_per_use', address=user, amount=amount, merchant=merchant` | Instant payment (not batch) |

> **Note on `charged` fee auditability (`paid_to`)**: `ChargeEventData` carries `paid_to: Option<Address>` as its trailing field, recording the fee recipient address (`MerchantFeeRecipient` if configured, otherwise the global `FeeCollector`, or `null` if no fee was transferred). This field is captured in SQLite in the `raw_data` JSON column for auditability and compliance reporting.

### Grace Period & Trial

| Event | Topic[0] | Topic[1] | Example Row |
|-------|----------|----------|-------------|
| grace period proposed | `grace_period_proposed` | (none) | `event_name='grace_period_proposed', raw_data={seconds}` |
| grace period committed | `grace_period_committed` | (none) | `event_name='grace_period_committed', raw_data={seconds}` |
| trial extended | `trial_extended` | user_address | `event_name='trial_extended', address=user, raw_data={additional_seconds, ...}` |
| daily window started | `daily_window_started` | user_address | `event_name='daily_window_started', address=user` |

### Admin & Policy

| Event | Topic[0] | Topic[1] | Example Row |
|-------|----------|----------|-------------|
| merchant added | `merchant_added` | merchant | `event_name='merchant_added', address=merchant` |
| merchant frozen | `merchant_frozen` | merchant | `event_name='merchant_frozen', address=merchant` |
| contract paused | `contract_paused` | (none) | `event_name='contract_paused'` |
| contract unpaused | `contract_unpaused` | (none) | `event_name='contract_unpaused'` |
| upgrade proposed | `upg_proposed` | (none) | `event_name='upg_proposed', raw_data={wasm_hash}` |
| upgrade cancelled | `upg_cancelled` | (none) | `event_name='upg_cancelled'` |
| max whitelist batch size | `max_wl_batch_size_set` | (none) | `event_name='max_wl_batch_size_set', raw_data={old, new}` |
| merchant history cleared | `merch_hist_cleared` | merchant | `event_name='merch_hist_cleared', address=merchant` |
| upgrade completed | `upgrade` | (none) | `event_name='upgrade'` |

## Charge Failure Alerting

### The Signal: `batch_charge_skips`

When `batch_charge()` is called, the contract publishes one `batch_charge_skips` event per batch if *any* interesting outcome occurred (not all charged, not all skipped due to interval). The event includes:

```typescript
pub struct BatchChargeSkipsEventData {
    pub total: u32,                    // Addresses submitted
    pub charged: u32,                  // Succeeded
    pub not_due: u32,                  // Interval not elapsed
    pub no_subscription: u32,          // User has no subscription
    pub inactive: u32,                 // Subscription cancelled
    pub paused: u32,                   // Subscription paused
    pub grace_elapsed: u32,            // Grace period expired (will retry)
    pub allowance_insufficient: u32,   // <-- ALERTING CASE: subscriber's allowance < gross
    pub ledger_sequence: u32,
}
```

### Query for Failed Charges

```sql
SELECT raw_data FROM events
WHERE event_name = 'batch_charge_skips'
  AND timestamp >= ?
ORDER BY timestamp DESC
```

Then parse `raw_data` JSON:
- If `allowance_insufficient > 0`: Subscriptions are ready to charge but blocked by insufficient allowance
  - Action: Send alert to merchant/subscriber to re-approve allowance
- If `allowance_insufficient == 0`: All non-charged outcomes are due to subscription state (paused, cancelled, no subscription)
  - Action: No alert needed (handled by subscriber/keeper directly)

### Alert Payload

See `scripts/alert-failed-charges.ts` for the webhook structure:

```typescript
interface AlertPayload {
  generated_at: string;     // ISO timestamp
  total_failed: number;     // Count of allowance_insufficient outcomes
  failed_charges: Array<{
    user_address: string;   // "batch_summary" or per-user if enriched
    reason: string;         // "allowance_insufficient"
    subscription_amount: number;
  }>;
}
```

## Integration Points

### Indexer
- `scripts/indexer.ts` — Polls RPC, parses contract events, upserts to SQLite
- Deduplication: Stable key `<tx_hash>:<op_index>:<event_index>`
- Last ledger tracked in `meta` table for resumption

### Alert Script
- `scripts/alert-failed-charges.ts` — Queries `batch_charge_skips` events
- Filters for `allowance_insufficient > 0`
- POSTs webhook if failures found
- Can accept `--since <unix-ts>` to query recent events

### Keeper Bot
- `scripts/keeper.ts` — Calls `batch_charge()` on contract
- Observes return value directly (not event-driven)
- Events are for off-chain subscribers (alert scripts, dashboards)

### Monitoring Dashboards
- `scripts/subscriber-health-dashboard.ts` — Can query events to show subscription state changes
- `scripts/watch-events.ts` — Real-time event stream for debugging

## Return Value Enums

### ChargeResult

The `batch_charge()` function returns a `Vec<ChargeResult>` with one outcome per user address:

| Discriminant | Variant | Meaning |
|--------------|---------|---------|
| 0 | Charged | Funds transferred successfully |
| 1 | Skipped | Interval not elapsed yet |
| 2 | NoSubscription | No subscription found |
| 3 | Inactive | Subscription cancelled |
| 4 | Paused | Subscription paused |
| 5 | GracePeriodElapsed | Grace period expired |
| 6 | AllowanceInsufficient | Allowance < gross amount |

See `docs/charge-results.md` for wire encoding details.

### CancelResult

The `batch_cancel()` function returns a `Vec<CancelResult>` with one outcome per user address:

| Discriminant | Variant | Meaning |
|--------------|---------|---------|
| 0 | Cancelled | Subscription cancelled successfully (normal case) |
| 1 | NoSubscription | No subscription entry found |
| 2 | AlreadyCancelled | Subscription was already inactive |
| 3 | PausedCancelled | A paused (but active) subscription was cancelled |
| 4 | MerchantFrozen | Subscription belongs to a frozen merchant and was cancelled |

**Append-only invariant:** New variants must be appended at the end to preserve backward compatibility with off-chain parsers. See `docs/cancel-results.md` for complete wire encoding specification.

**Usage:** Admins operating batch cancellations can use `PausedCancelled` and `MerchantFrozen` to identify unusual states that warrant review.
## Permanent abbreviated topics

These four `event_name` / topic[0] strings are **permanent public names**. Do not expand them to match helper names or sibling topics. A rename would break indexer rows, query scripts, replay, alerts, and watchers unless every consumer is migrated together.

| Topic | Meaning | Permanent? | Rationale |
| --- | --- | --- | --- |
| `max_wl_batch_size_set` | Max whitelist batch size updated | Yes | Short form beside `max_batch_size_set`; keep the emitted spelling. |
| `merch_hist_cleared` | Merchant revenue history wiped | Yes | Original abbreviated topic; not interchangeable with a long name. |
| `upg_proposed` | Two-step WASM upgrade proposed | Yes | Already consumed as `upg_proposed` in this mapping and ops docs. |
| `upg_cancelled` | Pending WASM upgrade cancelled | Yes | Same `upg_` prefix as propose; that is the wire name. |
