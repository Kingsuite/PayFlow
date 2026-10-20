import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = fileURLToPath(new URL("..", import.meta.url));
const validEnv = {
  CONTRACT_ID: `C${"A".repeat(55)}`,
  RPC_URL: "https://example.com",
  KEEPER_PUBLIC_KEY: "G",
  SECRET_KEY: "",
  KEEPER_SECRET: "",
};

function runKeeper(env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "keeper.ts", "--once"],
    {
      cwd: scriptsDir,
      encoding: "utf8",
      env: { ...process.env, ...validEnv, ...env },
    },
  );
}

describe("keeper environment validation", () => {
  it("rejects an interval below 60 seconds before starting a cycle", () => {
    const result = runKeeper({ DRY_RUN: "true", INTERVAL_SECONDS: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INTERVAL_SECONDS");
    expect(result.stderr).toContain("at least 60");
  });

  it("rejects a malformed KEEPER_SECRET with an actionable message", () => {
    const result = runKeeper({
      DRY_RUN: "false",
      INTERVAL_SECONDS: "3600",
      KEEPER_SECRET: "not-a-stellar-secret",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SECRET_KEY (or KEEPER_SECRET)");
    expect(result.stderr).toContain("valid Stellar secret key");
  });
});