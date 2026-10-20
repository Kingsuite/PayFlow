#!/usr/bin/env tsx
/**
 * deploy-pipeline.ts — Pre-deployment validation pipeline for FlowPay.
 *
 * Runs a sequence of safety gates before a WASM upgrade is committed:
 *
 *   1. Schema-version gate  — on-chain version matches the expected value.
 *   2. WASM-hash gate       — on-chain WASM hash matches the local build artifact.
 *
 * If either gate fails the process exits non-zero, blocking the deployment.
 * Gates that cannot be determined fail **closed** (i.e. they block, not warn).
 *
 * Usage:
 *   CONTRACT_ID=C... RPC_URL=https://... tsx scripts/deploy-pipeline.ts [--help]
 *   CONTRACT_ID=C... tsx scripts/deploy-pipeline.ts --expected-wasm-hash <hex>
 *
 * Environment:
 *   CONTRACT_ID         Required. Deployed FlowPay contract address.
 *   RPC_URL             Optional. Soroban RPC endpoint (default: testnet).
 *   NETWORK_PASSPHRASE  Optional. Network passphrase (default: testnet).
 *   EXPECTED_SCHEMA_VERSION  Optional. Schema version to assert (default: 2).
 *
 * Exit codes:
 *   0 — all gates passed
 *   1 — at least one gate failed or an unrecoverable error occurred
 */

import {
  Contract,
  Networks,
  TransactionBuilder,
  Account,
  BASE_FEE,
  Address,
  xdr,
} from "@stellar/stellar-sdk";
import { Server } from "@stellar/stellar-sdk/rpc";

// ── Configuration ────────────────────────────────────────────────────────────

const CONTRACT_ID = process.env.CONTRACT_ID ?? "";
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const EXPECTED_SCHEMA_VERSION = parseInt(
  process.env.EXPECTED_SCHEMA_VERSION ?? "2",
  10
);

/** Latest schema version baked into the scripts (mirrors contract/src/migration.rs). */
const LATEST_SCHEMA_VERSION = 2;

// Dummy source used only for read-only simulation (no auth required).
const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// ── Helpers ──────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
deploy-pipeline.ts — FlowPay pre-deployment validation pipeline

Usage:
  CONTRACT_ID=<id> tsx scripts/deploy-pipeline.ts [--expected-wasm-hash <hex>] [--help]

Options:
  --expected-wasm-hash <hex>   64-char hex WASM hash to compare against on-chain value.
                               If omitted the WASM-hash gate is skipped.
  --help, -h                   Show this message.

Environment:
  CONTRACT_ID              Required.
  RPC_URL                  Optional (default: testnet).
  NETWORK_PASSPHRASE       Optional (default: testnet).
  EXPECTED_SCHEMA_VERSION  Optional (default: ${LATEST_SCHEMA_VERSION}).
`);
  process.exit(0);
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const server = new Server(RPC_URL);

// ── Read-only simulation ──────────────────────────────────────────────────────

async function simulateReadOnly(
  method: string,
  ...args: xdr.ScVal[]
): Promise<xdr.ScVal> {
  const contract = new Contract(CONTRACT_ID);
  const sourceAccount = new Account(SIM_SOURCE, "0");

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const result = await server.simulateTransaction(tx);
  if ("error" in result) {
    throw new Error(`Simulation error for ${method}: ${result.error}`);
  }
  if (!result.result?.retval) {
    throw new Error(`No return value from ${method}`);
  }
  return result.result.retval;
}

// ── fetchOnChainWasmHash ──────────────────────────────────────────────────────

/**
 * Reads the WASM hash of the currently deployed contract instance directly
 * from ledger storage using `getLedgerEntries`.
 *
 * The fix vs. the previous broken implementation:
 *  - Previously an empty key array `([] as any[])` was passed, so the RPC
 *    call could never return anything and the function always returned `null`.
 *  - The `(server as any)` cast has been removed; `server.getLedgerEntries`
 *    accepts typed `xdr.LedgerKey` arguments.
 *  - The gate now fails **closed**: if the hash cannot be determined the
 *    caller receives an explicit error rather than a silent `null` / warn.
 *
 * How the key is built:
 *   The contract's executable (WASM) is referenced via the contract-instance
 *   entry, stored as ContractData with:
 *     • contract  = the contract's ScAddress
 *     • key       = ScVal::scvLedgerKeyContractInstance
 *     • durability = persistent
 *
 *   The returned LedgerEntryData.contractData().val() is an ScVal containing
 *   the ScContractInstance, whose `.executable().wasmHash()` is the hash we
 *   need.
 *
 * @throws {Error}  If the ledger entry cannot be fetched or parsed.
 */
export async function fetchOnChainWasmHash(): Promise<string> {
  const contractAddress = Address.fromString(CONTRACT_ID);

  // Build the correctly typed LedgerKey for the contract instance entry.
  const instanceLedgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contractAddress.toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );

  // Use the properly typed overload — no (server as any) cast needed.
  const response = await server.getLedgerEntries(instanceLedgerKey);

  if (!response.entries || response.entries.length === 0) {
    throw new Error(
      `No ledger entry found for contract ${CONTRACT_ID}. ` +
        "The contract may not be deployed on this network, or the RPC node may be out of sync."
    );
  }

  const entry = response.entries[0];
  if (!entry) {
    throw new Error("getLedgerEntries returned an empty entry.");
  }

  // entry.val is xdr.LedgerEntryData; navigate to the WASM hash.
  const entryData = entry.val.contractData();
  const instance = entryData.val().instance();
  const executable = instance.executable();

  // Fail closed if the contract is a Stellar-asset contract (no WASM hash).
  if (executable.switch().name !== "contractExecutableWasm") {
    throw new Error(
      `Contract ${CONTRACT_ID} is not a WASM contract ` +
        `(executable type: ${executable.switch().name}). Cannot determine WASM hash.`
    );
  }

  const wasmHashBytes: Buffer = executable.wasmHash() as unknown as Buffer;
  return wasmHashBytes.toString("hex");
}

// ── Gate: schema version ──────────────────────────────────────────────────────

interface GateResult {
  name: string;
  passed: boolean;
  message: string;
}

async function runSchemaVersionGate(): Promise<GateResult> {
  const name = "schema-version";
  try {
    const retval = await simulateReadOnly("get_schema_version");
    const onChainVersion = retval.u32();

    if (onChainVersion !== EXPECTED_SCHEMA_VERSION) {
      return {
        name,
        passed: false,
        message:
          `On-chain schema version is ${onChainVersion}, ` +
          `expected ${EXPECTED_SCHEMA_VERSION}. ` +
          "Run migrate() before deploying, or update EXPECTED_SCHEMA_VERSION.",
      };
    }

    return {
      name,
      passed: true,
      message: `Schema version ${onChainVersion} matches expected ${EXPECTED_SCHEMA_VERSION}.`,
    };
  } catch (err) {
    // Fail closed — we cannot proceed safely if the version is unknown.
    return {
      name,
      passed: false,
      message: `Could not read on-chain schema version: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Gate: WASM hash ───────────────────────────────────────────────────────────

async function runWasmHashGate(expectedHash: string): Promise<GateResult> {
  const name = "wasm-hash";
  try {
    const onChainHash = await fetchOnChainWasmHash();

    if (onChainHash.toLowerCase() !== expectedHash.toLowerCase()) {
      return {
        name,
        passed: false,
        message:
          `On-chain WASM hash (${onChainHash}) does not match ` +
          `the expected hash (${expectedHash}). ` +
          "Ensure you are deploying the correct build artifact.",
      };
    }

    return {
      name,
      passed: true,
      message: `WASM hash matches: ${onChainHash}`,
    };
  } catch (err) {
    // Fail closed — a gate that cannot verify must block, not warn.
    return {
      name,
      passed: false,
      message:
        `WASM hash gate failed closed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Resolve the issue or skip the gate explicitly with operator sign-off.",
    };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    showHelp();
  }

  if (!CONTRACT_ID) {
    console.error("Error: CONTRACT_ID environment variable is required.");
    process.exit(1);
  }

  const expectedWasmHash = getArg("--expected-wasm-hash");

  console.log("=== FlowPay Deploy Pipeline ===");
  console.log(`Contract : ${CONTRACT_ID}`);
  console.log(`RPC URL  : ${RPC_URL}`);
  console.log(`Network  : ${NETWORK_PASSPHRASE}`);
  console.log("");

  const gates: GateResult[] = [];

  // Gate 1 — schema version
  console.log("[1/2] Running schema-version gate…");
  gates.push(await runSchemaVersionGate());

  // Gate 2 — WASM hash (skipped if --expected-wasm-hash not provided)
  if (expectedWasmHash) {
    console.log("[2/2] Running wasm-hash gate…");
    gates.push(await runWasmHashGate(expectedWasmHash));
  } else {
    console.log("[2/2] WASM-hash gate skipped (--expected-wasm-hash not provided).");
  }

  // Report
  console.log("\n── Gate results ──");
  let allPassed = true;
  for (const gate of gates) {
    const icon = gate.passed ? "✓" : "✗";
    console.log(`  ${icon}  [${gate.name}] ${gate.message}`);
    if (!gate.passed) allPassed = false;
  }

  console.log("");
  if (allPassed) {
    console.log("All gates passed. Safe to proceed with deployment.");
    process.exit(0);
  } else {
    console.error("One or more gates FAILED. Deployment blocked.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    "Deploy pipeline crashed:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
