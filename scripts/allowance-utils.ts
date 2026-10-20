/**
 * allowance-utils.ts — Shared allowance helpers and rate-limit / retry defaults.
 *
 * Exported constants
 * ──────────────────
 * All default values for RPC rate-limiting and retry behaviour live here so
 * that tuning a single constant propagates to every consumer automatically.
 * Previously the same three values were duplicated in:
 *   - allowance-utils.ts header comment (not exported, could drift)
 *   - check-allowances.ts:59-64
 *   - alert-expiring-allowances.ts:58-63
 *
 * LEDGERS_PER_DAY
 * ───────────────
 * Stellar closes approximately one ledger every 5 seconds.
 *   17 280 = 86 400 s/day ÷ 5 s/ledger
 *
 * This matches:
 *   - contract/src/spending_limit.rs:7  (LEDGERS_PER_DAY = 17_280)
 *   - contract/src/upgrade.rs:5        (TTL = 17_280)
 *
 * NOTE: The ~5 s/ledger assumption should be validated against the live
 * network periodically.  The Stellar network targets 5 s but actual close
 * times vary.  Use server.getLatestLedger() to derive an empirical value
 * when precision matters.
 */

// ── Ledger-time constants ─────────────────────────────────────────────────────

/**
 * Approximate number of ledgers closed in one day on Stellar.
 * Mirrors contract/src/spending_limit.rs:7 and contract/src/upgrade.rs:5.
 *
 * NOTE: Based on the ~5 s/ledger assumption — validate against the live
 * network if precision matters.
 */
export const LEDGERS_PER_DAY = 17_280;

// ── RPC rate-limit defaults ───────────────────────────────────────────────────

/**
 * Default number of RPC requests allowed per second before throttling.
 * Tuning this value propagates to check-allowances.ts and
 * alert-expiring-allowances.ts automatically.
 */
export const DEFAULT_REQUESTS_PER_SECOND = 5;

/**
 * Default burst capacity: how many requests may be issued above the
 * per-second rate limit before throttling kicks in.
 */
export const DEFAULT_BURST = 10;

/**
 * Default sliding-window duration (in milliseconds) used for rate-limit
 * accounting.
 */
export const DEFAULT_WINDOW_MS = 1_000;

// ── Retry defaults ────────────────────────────────────────────────────────────

/**
 * Default maximum number of retry attempts for a failing RPC call.
 */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Default initial back-off delay in milliseconds (doubles on each retry).
 */
export const DEFAULT_RETRY_DELAY_MS = 500;

// ── Rate-limiter helper ───────────────────────────────────────────────────────

/**
 * Minimal token-bucket rate limiter for RPC calls.
 *
 * @param requestsPerSecond  Maximum steady-state RPS (default: DEFAULT_REQUESTS_PER_SECOND).
 * @param burst              Extra capacity above the steady rate (default: DEFAULT_BURST).
 * @param windowMs           Accounting window in ms (default: DEFAULT_WINDOW_MS).
 */
export interface RateLimiterOptions {
  requestsPerSecond?: number;
  burst?: number;
  windowMs?: number;
}

export class RateLimiter {
  private readonly requestsPerSecond: number;
  private readonly burst: number;
  private readonly windowMs: number;
  private tokens: number;
  private lastRefill: number;

  constructor(opts: RateLimiterOptions = {}) {
    this.requestsPerSecond = opts.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    this.burst = opts.burst ?? DEFAULT_BURST;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  /** Waits until a token is available, then consumes one. */
  async throttle(): Promise<void> {
    while (true) {
      const now = Date.now();
      const elapsed = now - this.lastRefill;
      const refill = (elapsed / this.windowMs) * this.requestsPerSecond;
      this.tokens = Math.min(this.burst, this.tokens + refill);
      this.lastRefill = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      // Wait until enough tokens accumulate for one request
      const waitMs = ((1 - this.tokens) / this.requestsPerSecond) * this.windowMs;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
    }
  }
}

// ── Retry helper ──────────────────────────────────────────────────────────────

/**
 * Retries `fn` up to `maxRetries` times with exponential back-off.
 *
 * @param fn          Async function to call.
 * @param maxRetries  Maximum attempts (default: DEFAULT_MAX_RETRIES).
 * @param delayMs     Initial back-off delay in ms (default: DEFAULT_RETRY_DELAY_MS).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  delayMs: number = DEFAULT_RETRY_DELAY_MS
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const backoff = delayMs * Math.pow(2, attempt - 1);
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastError;
}

// ── Allowance parsing helpers ─────────────────────────────────────────────────

/**
 * Converts a stroop value (smallest XLM unit) to a human-readable decimal
 * string using the token's decimal places.
 *
 * For XLM (7 decimals): 10_000_000 stroops = 1.0000000 XLM.
 * For other SAC tokens pass the appropriate `decimals` value — do NOT
 * hard-code 7 for non-XLM tokens.
 *
 * @param stroops   Raw token amount as a string or bigint.
 * @param decimals  Number of decimal places for the token (default: 7 for XLM).
 */
export function formatTokenAmount(
  stroops: string | bigint,
  decimals = 7
): string {
  const value = typeof stroops === "bigint" ? stroops : BigInt(stroops);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = value / divisor;
  const frac = value % divisor;
  const fracStr = frac.toString().padStart(decimals, "0");
  return `${whole}.${fracStr}`;
}

/**
 * Returns `true` when `allowance` (in token base units) is insufficient
 * to cover `required`.
 *
 * @param allowance   Current approved allowance.
 * @param required    Amount required for the next charge.
 */
export function isAllowanceAtRisk(allowance: bigint, required: bigint): boolean {
  return allowance < required;
}

/**
 * Calculates the shortfall between `required` and `allowance`.
 * Returns 0n if the allowance is sufficient.
 *
 * @param allowance   Current approved allowance.
 * @param required    Amount required for the next charge.
 */
export function allowanceGap(allowance: bigint, required: bigint): bigint {
  return required > allowance ? required - allowance : 0n;
}
