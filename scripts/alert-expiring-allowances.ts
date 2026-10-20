#!/usr/bin/env tsx
/**
 * alert-expiring-allowances.ts
 *
 * Scans active subscriptions and alerts on any whose token allowance will
 * expire within the next LEDGERS_PER_DAY ledgers (~24 h).
 *
 * Rate-limit and retry defaults are imported from allowance-utils.ts so that
 * tuning a single constant propagates everywhere — previously each script
 * re-declared the same three values independently.
 *
 * Usage:
 *   CONTRACT_ID=C... WEBHOOK_URL=https://... tsx scripts/alert-expiring-allowances.ts \
 *     [--db <path>] [--dry-run]
 *
 * Environment:
 *   CONTRACT_ID   Required. Deployed FlowPay contract address.
 *   RPC_URL       Optional. Soroban RPC endpoint (default: testnet).
 *   WEBHOOK_URL   Optional. If set, POST a JSON alert payload to this URL.
 */

import { DatabaseSync } from "node:sqlite";
import { Server } from "@stellar/stellar-sdk/rpc";
import {
  Contract,
  Networks,
  TransactionBuilder,
  Account,
  BASE_FEE,
  Address,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  LEDGERS_PER_DAY,
  DEFAULT_REQUESTS_PER_SECOND,
  DEFAULT_BURST,
  DEFAULT_WINDOW_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  RateLimiter,
  withRetry,
  formatTokenAmount,
  isAllowanceAtRisk,
} from "./allowance-utils.js";
import { fetchWithTimeout } from "./utils/fetchWithTimeout.js";

// ── Configuration ─────────────────────────────────────────────────────────────

const CONTRACT_ID = process.env.CONTRACT_ID ?? "";
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";

// Rate-limit and retry settings — imported from allowance-utils.ts.
// Previously these three values were re-declared inline in this file.
const REQUESTS_PER_SECOND = DEFAULT_REQUESTS_PER_SECOND;
const BURST = DEFAULT_BURST;
const WINDOW_MS = DEFAULT_WINDOW_MS;
const MAX_RETRIES = DEFAULT_MAX_RETRIES;
const RETRY_DELAY_MS = DEFAULT_RETRY_DELAY_MS;

/**
 * How far ahead (in ledgers) to look for expiring allowances.
 * Named constant mirrors spending_limit.rs:LEDGERS_PER_DAY and
 * is used instead of the previous bare 17280 magic number.
 */
const EXPIRY_LOOKAHEAD_LEDGERS = LEDGERS_PER_DAY; // ~24 h

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubscriptionRow {
  user_address: string;
  token_id: string;
  amount: string;
}

interface ExpiryAlert {
  user_address: string;
  token_id: string;
  subscription_amount: string;
  current_allowance: string;
  ledgers_until_expiry: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

// ── Stellar helpers ───────────────────────────────────────────────────────────

const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

function addressVal(addr: string): xdr.ScVal {
  return nativeToScVal(Address.fromString(addr), { type: "address" });
}

/**
 * Fetches the token allowance that `owner` has granted to the FlowPay contract.
 * Uses the shared RateLimiter and withRetry from allowance-utils.ts.
 */
async function getAllowance(
  server: Server,
  owner: string,
  tokenId: string,
  limiter: RateLimiter
): Promise<bigint> {
  await limiter.throttle();
  return withRetry(async () => {
    try {
      const tokenContract = new Contract(tokenId);
      const flowPayAddress = Address.fromString(CONTRACT_ID);
      const sourceAccount = new Account(SIM_SOURCE, "0");

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          tokenContract.call(
            "allowance",
            addressVal(owner),
            nativeToScVal(flowPayAddress, { type: "address" })
          )
        )
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);
      if ("error" in result) return 0n;

      const retval = (result as { result?: { retval?: xdr.ScVal } }).result?.retval;
      if (!retval || retval.switch().name === "scvVoid") return 0n;

      return BigInt(retval.i128().toString());
    } catch {
      return 0n;
    }
  }, MAX_RETRIES, RETRY_DELAY_MS);
}

/**
 * Fetches the allowance expiry ledger for `owner` → FlowPay contract.
 * Returns the ledger sequence at which the allowance expires, or null if unknown.
 */
async function getAllowanceExpiry(
  server: Server,
  owner: string,
  tokenId: string,
  limiter: RateLimiter
): Promise<number | null> {
  await limiter.throttle();
  return withRetry(async () => {
    try {
      const tokenContract = new Contract(tokenId);
      const flowPayAddress = Address.fromString(CONTRACT_ID);
      const sourceAccount = new Account(SIM_SOURCE, "0");

      // SEP-41 tokens expose an expiration_ledger on the allowance entry.
      // We read it via get_allowance which returns { amount, expiration_ledger }.
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          tokenContract.call(
            "get_allowance",
            addressVal(owner),
            nativeToScVal(flowPayAddress, { type: "address" })
          )
        )
        .setTimeout(30)
        .build();

      const result = await server.simulateTransaction(tx);
      if ("error" in result) return null;

      const retval = (result as { result?: { retval?: xdr.ScVal } }).result?.retval;
      if (!retval || retval.switch().name === "scvVoid") return null;

      // Extract expiration_ledger from the map
      for (const entry of retval.map() ?? []) {
        if (entry.key().sym().toString() === "expiration_ledger") {
          return Number(entry.val().u32());
        }
      }
      return null;
    } catch {
      return null;
    }
  }, MAX_RETRIES, RETRY_DELAY_MS);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!CONTRACT_ID) {
    console.error("Error: CONTRACT_ID environment variable is required.");
    process.exit(1);
  }

  const dbPath = getArg("--db") ?? process.env.INDEXER_DB ?? "indexer.db";
  const dryRun = process.argv.includes("--dry-run");

  // Load active subscriptions from the indexer DB
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath, { open: true });
  } catch (err) {
    console.error(`Failed to open database at ${dbPath}: ${err}`);
    process.exit(1);
  }

  const rows = db
    .prepare(
      `SELECT user_address, token_id, amount
       FROM subscriptions
       WHERE active = 1`
    )
    .all() as unknown as SubscriptionRow[];
  db.close();

  if (rows.length === 0) {
    console.log("No active subscriptions found.");
    return;
  }

  console.log(`Checking ${rows.length} active subscription(s)…`);

  const server = new Server(RPC_URL);
  const limiter = new RateLimiter({
    requestsPerSecond: REQUESTS_PER_SECOND,
    burst: BURST,
    windowMs: WINDOW_MS,
  });

  // Fetch latest ledger sequence for lookahead comparison
  const latest = await server.getLatestLedger();
  const currentLedger = latest.sequence;

  const alerts: ExpiryAlert[] = [];

  for (const row of rows) {
    const allowance = await getAllowance(server, row.user_address, row.token_id, limiter);
    const expiryLedger = await getAllowanceExpiry(server, row.user_address, row.token_id, limiter);

    const required = BigInt(row.amount);
    const atRisk = isAllowanceAtRisk(allowance, required);
    const ledgersUntilExpiry =
      expiryLedger !== null ? expiryLedger - currentLedger : Infinity;
    const expiringSoon =
      expiryLedger !== null && ledgersUntilExpiry <= EXPIRY_LOOKAHEAD_LEDGERS;

    if (atRisk || expiringSoon) {
      alerts.push({
        user_address: row.user_address,
        token_id: row.token_id,
        subscription_amount: formatTokenAmount(required),
        current_allowance: formatTokenAmount(allowance),
        ledgers_until_expiry: expiryLedger !== null ? ledgersUntilExpiry : -1,
      });
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    current_ledger: currentLedger,
    expiry_lookahead_ledgers: EXPIRY_LOOKAHEAD_LEDGERS,
    total_alerts: alerts.length,
    alerts,
  };

  console.log(JSON.stringify(payload, null, 2));

  if (alerts.length === 0) {
    console.log("No expiring allowances detected.");
    return;
  }

  if (!dryRun && WEBHOOK_URL) {
    try {
      const resp = await fetchWithTimeout(
        WEBHOOK_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
        10_000
      );
      if (resp.ok) {
        console.log(`Alert webhook delivered (HTTP ${resp.status}).`);
      } else {
        console.error(`Alert webhook responded with HTTP ${resp.status}.`);
      }
    } catch (err) {
      console.error(`Alert webhook delivery failed: ${err}`);
    }
  } else if (dryRun) {
    console.log("[dry-run] Webhook delivery skipped.");
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
