#!/usr/bin/env node
/**
 * emit-caps-table.mjs — Verify or emit the contract-limits documentation table.
 *
 * Usage:
 *   node scripts/emit-caps-table.mjs            # print the table to stdout
 *   node scripts/emit-caps-table.mjs --check    # compare against docs/limits.md; exit 1 on drift
 *
 * The source of truth is scripts/lib/contract-limits.ts (compiled/imported via
 * a lightweight inline parse so this script has no build step dependency).
 *
 * The --check flag is used as a CI gate to ensure docs/limits.md stays in
 * sync with the script module and (transitively) with contract/src/*.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECK_MODE = process.argv.includes("--check");

// ── Parse contract-limits.ts ──────────────────────────────────────────────────
// We parse the TypeScript source directly (no tsc step) to extract
// `export const NAME = VALUE` declarations.  This is intentionally simple —
// the file only contains numeric/bigint literals and arithmetic expressions.

const limitsPath = resolve(__dirname, "lib", "contract-limits.ts");
const limitsSource = readFileSync(limitsPath, "utf-8");

/** @type {Map<string, bigint|number>} */
const constants = new Map();

// Match: export const NAME = VALUE[n];
// Handles decimals, bigint suffix (n), and simple expressions like LEDGERS_PER_DAY
// Note: we do NOT strip underscores globally — only from numeric literals.
const CONST_RE = /^export const (\w+)\s*=\s*([^;]+);/gm;
let m;
while ((m = CONST_RE.exec(limitsSource)) !== null) {
  const name = m[1];
  const raw = m[2].trim();
  // Strip trailing n (bigint literal) before evaluation
  const isBigInt = /^\d[\d_]*n$/.test(raw) || /^\d[\d_]*\*\*\d+n?$/.test(raw);

  // Replace already-parsed constant references with their numeric values
  let expr = raw;
  for (const [k, v] of constants) {
    expr = expr.replace(new RegExp(`\\b${k}\\b`, "g"), String(v));
  }
  // Strip numeric underscore separators from the expression (e.g. 10_000_000 → 10000000)
  // Only strip underscores between digits, not in identifier names
  expr = expr.replace(/(\d)_(\d)/g, "$1$2");
  // Remove trailing bigint n suffix
  expr = expr.replace(/(\d)n\b/g, "$1");

  let value;
  try {
    value = Function(`"use strict"; return (${expr});`)();
  } catch {
    continue; // skip non-numeric exports
  }
  if (typeof value === "number" || typeof value === "bigint") {
    constants.set(name, isBigInt ? BigInt(value) : value);
  }
}

// ── Build the expected markdown table ────────────────────────────────────────

function row(name, desc) {
  const v = constants.get(name);
  if (v === undefined) throw new Error(`Constant ${name} not found in contract-limits.ts`);
  return `| \`${name}\` | ${v} | ${desc} |`;
}

const TABLE = `# PayFlow Contract Limits

> **Auto-generated table** -- do not edit by hand.
> Run \`node scripts/emit-caps-table.mjs --check\` to verify this file is in sync
> with \`contract/src/\` and \`scripts/lib/contract-limits.ts\`.

This table is the operator-facing reference for every hard cap enforced by the
deployed contract.  The authoritative values live in:

- **Contract (Rust):** \`contract/src/batch.rs\`, \`contract/src/lib.rs\`,
  \`contract/src/migration.rs\`, \`contract/src/spending_limit.rs\`,
  \`contract/src/upgrade.rs\`
- **Scripts (TypeScript):** \`scripts/lib/contract-limits.ts\`

## Batch sizes

| Constant | Value | Description |
|---|---|---|
${row("MAX_BATCH_SIZE",         "Default maximum users per `batch_charge` call")}
${row("MAX_BATCH_SIZE_CEILING", "Hard ceiling on `set_max_batch_size`")}
${row("MAX_BATCH_PAUSE",        "Maximum subscriptions per batch pause call")}
${row("MAX_WHITELIST_BATCH",    "Maximum addresses per whitelist batch operation")}

## Schema version

| Constant | Value | Description |
|---|---|---|
${row("CURRENT_SCHEMA_VERSION", "Current on-chain storage schema version")}

## Ledger-time constants

| Constant | Value | Description |
|---|---|---|
${row("LEDGERS_PER_DAY",           "Approximate ledgers per day (~5 s/ledger)")}
${row("UPGRADE_TTL_LEDGERS",       "TTL for pending WASM upgrade proposals")}
${row("SUBSCRIPTION_TTL_LEDGERS",  "Subscription entry TTL (~1 year)")}

## Amount limits (token base units)

| Constant | Value | Description |
|---|---|---|
${row("MAX_AMOUNT",               "Maximum single pay-per-use amount")}
${row("MAX_SUBSCRIPTION_AMOUNT",  "Maximum subscription charge amount")}
${row("GLOBAL_MAX_VOLUME_PER_HOUR", "Global max volume per hour (all merchants)")}

## Token decimals

| Constant | Value | Description |
|---|---|---|
${row("XLM_DECIMALS",   "XLM decimal places (1 XLM = 10^7 stroops)")}
${row("STROOPS_PER_XLM", "Stroops per XLM")}

> ⚠️ **Multi-token note:** \`XLM_DECIMALS\` and \`STROOPS_PER_XLM\` apply only to
> XLM and XLM-derived SAC tokens. Non-XLM SEP-41 tokens may use different decimal
> counts — always query the token's \`decimals()\` entry-point rather than
> hard-coding these values for arbitrary tokens.

## Other constants

| Constant | Value | Description |
|---|---|---|
${row("HOUR_IN_SECONDS", "Seconds per hour")}
`;

// ── Output or check ───────────────────────────────────────────────────────────

if (!CHECK_MODE) {
  process.stdout.write(TABLE);
  process.exit(0);
}

// --check: compare against docs/limits.md
const docsPath = resolve(__dirname, "..", "docs", "limits.md");
let existing;
try {
  existing = readFileSync(docsPath, "utf-8");
} catch {
  console.error(`docs/limits.md not found at ${docsPath}. Run without --check to generate it.`);
  process.exit(1);
}

if (existing.trimEnd() === TABLE.trimEnd()) {
  console.log("✓ docs/limits.md is in sync with scripts/lib/contract-limits.ts");
  process.exit(0);
} else {
  console.error("✗ docs/limits.md is OUT OF SYNC with scripts/lib/contract-limits.ts");
  console.error("");
  console.error("Run:  node scripts/emit-caps-table.mjs > docs/limits.md");
  console.error("to regenerate the file, then commit the result.");
  process.exit(1);
}
