#!/usr/bin/env tsx
/**
 * test-allowance-utils.ts — Tests for allowance-utils.ts constants and helpers.
 *
 * Covers:
 *  - LEDGERS_PER_DAY value matches contract/src/spending_limit.rs
 *  - Rate-limit defaults are exported with correct values
 *  - formatTokenAmount handles XLM and non-XLM tokens correctly
 *  - isAllowanceAtRisk / allowanceGap logic
 *  - RateLimiter throttles and token-bucket refills
 *  - withRetry retries the correct number of times and propagates last error
 *
 * Run:
 *   cd scripts && npx tsx test-allowance-utils.ts
 */

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
  allowanceGap,
} from "./allowance-utils.js";

// ── Minimal test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓  ${message}`);
    passed++;
  } else {
    console.error(`  ✗  ${message}`);
    failed++;
  }
}

async function assertThrows(
  fn: () => Promise<unknown>,
  message: string
): Promise<void> {
  try {
    await fn();
    console.error(`  ✗  ${message} (expected throw but none occurred)`);
    failed++;
  } catch {
    console.log(`  ✓  ${message}`);
    passed++;
  }
}

// ── LEDGERS_PER_DAY ───────────────────────────────────────────────────────────

console.log("\n=== LEDGERS_PER_DAY ===");

// The contract value is 17_280 (contract/src/spending_limit.rs:7).
// Scripts must stay in sync with it.
assert(
  LEDGERS_PER_DAY === 17_280,
  `LEDGERS_PER_DAY is 17 280 (mirrors contract/src/spending_limit.rs:7)`
);

// Sanity: 86_400 s/day ÷ 5 s/ledger = 17_280
assert(
  LEDGERS_PER_DAY === Math.round(86_400 / 5),
  "LEDGERS_PER_DAY derivation: 86 400 ÷ 5 = 17 280"
);

// ── Rate-limit defaults ───────────────────────────────────────────────────────

console.log("\n=== Rate-limit defaults ===");

assert(typeof DEFAULT_REQUESTS_PER_SECOND === "number" && DEFAULT_REQUESTS_PER_SECOND > 0,
  "DEFAULT_REQUESTS_PER_SECOND is a positive number");
assert(typeof DEFAULT_BURST === "number" && DEFAULT_BURST >= DEFAULT_REQUESTS_PER_SECOND,
  "DEFAULT_BURST >= DEFAULT_REQUESTS_PER_SECOND");
assert(typeof DEFAULT_WINDOW_MS === "number" && DEFAULT_WINDOW_MS > 0,
  "DEFAULT_WINDOW_MS is a positive number");
assert(typeof DEFAULT_MAX_RETRIES === "number" && DEFAULT_MAX_RETRIES >= 1,
  "DEFAULT_MAX_RETRIES is at least 1");
assert(typeof DEFAULT_RETRY_DELAY_MS === "number" && DEFAULT_RETRY_DELAY_MS > 0,
  "DEFAULT_RETRY_DELAY_MS is a positive number");

// ── formatTokenAmount ─────────────────────────────────────────────────────────

console.log("\n=== formatTokenAmount ===");

// XLM: 1 XLM = 10_000_000 stroops (7 decimals)
assert(
  formatTokenAmount(10_000_000n) === "1.0000000",
  "formatTokenAmount: 10_000_000 stroops → 1.0000000 XLM"
);
assert(
  formatTokenAmount("0") === "0.0000000",
  "formatTokenAmount: 0 stroops → 0.0000000"
);
assert(
  formatTokenAmount(1n) === "0.0000001",
  "formatTokenAmount: 1 stroop → 0.0000001"
);
assert(
  formatTokenAmount(123_456_789n) === "12.3456789",
  "formatTokenAmount: 123_456_789 → 12.3456789"
);

// Non-XLM token with 6 decimals (e.g. USDC)
assert(
  formatTokenAmount(1_000_000n, 6) === "1.000000",
  "formatTokenAmount: 1_000_000 units (6 decimals) → 1.000000"
);
assert(
  formatTokenAmount(500n, 6) === "0.000500",
  "formatTokenAmount: 500 units (6 decimals) → 0.000500"
);

// ── isAllowanceAtRisk / allowanceGap ─────────────────────────────────────────

console.log("\n=== isAllowanceAtRisk / allowanceGap ===");

assert(
  isAllowanceAtRisk(500n, 1000n) === true,
  "isAllowanceAtRisk: 500 < 1000 → at risk"
);
assert(
  isAllowanceAtRisk(1000n, 1000n) === false,
  "isAllowanceAtRisk: 1000 == 1000 → not at risk"
);
assert(
  isAllowanceAtRisk(2000n, 1000n) === false,
  "isAllowanceAtRisk: 2000 > 1000 → not at risk"
);

assert(
  allowanceGap(500n, 1000n) === 500n,
  "allowanceGap: 1000 required, 500 available → gap 500"
);
assert(
  allowanceGap(1000n, 1000n) === 0n,
  "allowanceGap: exactly covered → gap 0"
);
assert(
  allowanceGap(2000n, 1000n) === 0n,
  "allowanceGap: surplus → gap 0"
);

// ── withRetry ─────────────────────────────────────────────────────────────────

console.log("\n=== withRetry ===");

// Succeeds on first attempt
await (async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 42;
  }, 3, 1);
  assert(result === 42, "withRetry: returns value on first success");
  assert(calls === 1, "withRetry: calls fn exactly once on immediate success");
})();

// Succeeds on third attempt
await (async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    },
    3,
    1
  );
  assert(result === "ok", "withRetry: returns value after transient failures");
  assert(calls === 3, "withRetry: retries up to maxRetries times");
})();

// Exhausts retries and rethrows last error
await assertThrows(async () => {
  await withRetry(async () => { throw new Error("permanent"); }, 2, 1);
}, "withRetry: throws after exhausting all retries");

// Propagates the last error message
await (async () => {
  let caught: Error | null = null;
  try {
    await withRetry(async () => { throw new Error("last-error"); }, 2, 1);
  } catch (err) {
    caught = err as Error;
  }
  assert(
    caught?.message === "last-error",
    "withRetry: propagates the last thrown error"
  );
})();

// ── RateLimiter ───────────────────────────────────────────────────────────────

console.log("\n=== RateLimiter ===");

// With high burst, first N calls should be immediate
await (async () => {
  const limiter = new RateLimiter({ requestsPerSecond: 100, burst: 5, windowMs: 1000 });
  const start = Date.now();
  for (let i = 0; i < 5; i++) {
    await limiter.throttle();
  }
  const elapsed = Date.now() - start;
  // 5 burst calls should complete in well under 200 ms
  assert(elapsed < 200, `RateLimiter: burst of 5 completes quickly (${elapsed} ms < 200 ms)`);
})();

// With 0 burst and very low RPS, subsequent call should be delayed
await (async () => {
  // 10 rps, burst=1 (one free token then must wait ~100ms per token)
  const limiter = new RateLimiter({ requestsPerSecond: 10, burst: 1, windowMs: 1000 });
  await limiter.throttle(); // consume the burst token
  const start = Date.now();
  await limiter.throttle(); // this one must wait ~100 ms
  const elapsed = Date.now() - start;
  assert(
    elapsed >= 80,
    `RateLimiter: second call after burst is throttled (${elapsed} ms ≥ 80 ms)`
  );
})();

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);

if (failed > 0) {
  process.exit(1);
}
