/**
 * tests/keeper-config.test.ts
 *
 * Unit tests for keeper-config.ts.
 *
 * Key invariants verified:
 * 1. formatConfig never emits the raw secret key — not even a substring of it.
 * 2. formatConfig never emits the "secret" JSON key in its output.
 * 3. Non-sensitive fields (networkPassphrase, allowMainnet, publicKey) are
 *    present in the output so callers still have useful context.
 * 4. New fields added to KeeperConfig are excluded by default (allow-list
 *    semantics: omit unless explicitly included).
 * 5. redactSecret now correctly identifies valid Stellar secret keys using the
 *    base32 alphabet [A-Z2-7] and replaces them with a masked value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatConfig,
  redactSecret,
  TEST_NETWORK_PASSPHRASE,
  type KeeperConfig,
} from '../keeper-config';

// ── Realistic Stellar secret keys for testing ────────────────────────────────
// Stellar secret keys are 56 characters: 'S' + 55 chars from [A-Z2-7].
// These are synthetic keys that match the structural pattern exactly.
// They are NOT real funded accounts.

const STELLAR_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Generate a deterministic fake Stellar secret key for testing.
 * The key follows the structural invariant: starts with 'S', 56 chars total,
 * characters from the base32 alphabet [A-Z2-7].
 */
function fakeStellarSecret(seed: number): string {
  let result = 'S';
  let n = seed;
  for (let i = 0; i < 55; i++) {
    result += STELLAR_BASE32[n % 32];
    n = (n * 1664525 + 1013904223) & 0x7fffffff; // LCG to vary chars
  }
  return result;
}

// A handful of pre-generated test keys to use across tests.
const TEST_KEYS = Array.from({ length: 25 }, (_, i) => fakeStellarSecret(i * 7919 + 42));

// Spot-check our generator: all keys should be 56 chars from the right alphabet.
for (const key of TEST_KEYS) {
  if (key.length !== 56) throw new Error(`Key length mismatch: ${key}`);
  if (!/^S[A-Z2-7]{55}$/.test(key)) throw new Error(`Key has invalid chars: ${key}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseConfig(override: Partial<KeeperConfig & { [k: string]: unknown }> = {}): KeeperConfig {
  return {
    secret: TEST_KEYS[0],
    publicKey: 'GBGSAMPLEKEYFORPUBLICKEYTESTINGXYZPAYFLOWNOTREAL12345',
    networkPassphrase: TEST_NETWORK_PASSPHRASE,
    allowMainnet: false,
    ...override,
  };
}

// ── formatConfig: secret redaction ──────────────────────────────────────────

describe('formatConfig — secret redaction', () => {
  it('does not emit the raw secret key', () => {
    const config = baseConfig({ secret: TEST_KEYS[1] });
    const output = formatConfig(config);
    assert.ok(
      !output.includes(config.secret),
      `formatConfig output must not contain the raw secret key.\nSecret: ${config.secret}\nOutput:\n${output}`,
    );
  });

  it('does not emit the "secret" JSON key', () => {
    const config = baseConfig({ secret: TEST_KEYS[2] });
    const output = formatConfig(config);
    const parsed = JSON.parse(output);
    assert.ok(
      !('secret' in parsed),
      `Parsed formatConfig output must not have a "secret" property. Got keys: ${Object.keys(parsed).join(', ')}`,
    );
  });

  it('does not emit the secret even when publicKey is absent', () => {
    const config = baseConfig({ secret: TEST_KEYS[3], publicKey: undefined });
    const output = formatConfig(config);
    assert.ok(
      !output.includes(config.secret),
      `formatConfig output must not contain the raw secret key when publicKey is absent.\nSecret: ${config.secret}\nOutput:\n${output}`,
    );
  });

  it('does not emit the secret for all 20 test keys', () => {
    for (let i = 0; i < 20; i++) {
      const config = baseConfig({ secret: TEST_KEYS[i] });
      const output = formatConfig(config);
      assert.ok(
        !output.includes(config.secret),
        `formatConfig leaked the secret for key index ${i}.\nSecret: ${config.secret}\nOutput:\n${output}`,
      );
    }
  });
});

// ── formatConfig: allow-listed fields are present ───────────────────────────

describe('formatConfig — allow-listed fields', () => {
  it('includes networkPassphrase', () => {
    const config = baseConfig();
    const parsed = JSON.parse(formatConfig(config));
    assert.equal(parsed.networkPassphrase, config.networkPassphrase);
  });

  it('includes allowMainnet', () => {
    const config = baseConfig({ allowMainnet: true });
    const parsed = JSON.parse(formatConfig(config));
    assert.equal(parsed.allowMainnet, true);
  });

  it('includes publicKey when set', () => {
    const config = baseConfig();
    const parsed = JSON.parse(formatConfig(config));
    assert.equal(parsed.publicKey, config.publicKey);
  });

  it('omits publicKey when not set', () => {
    const config = baseConfig({ publicKey: undefined });
    const parsed = JSON.parse(formatConfig(config));
    assert.ok(
      !('publicKey' in parsed),
      `publicKey should be absent when not set. Got: ${JSON.stringify(parsed)}`,
    );
  });
});

// ── formatConfig: allow-list semantics for unknown future fields ─────────────

describe('formatConfig — allow-list default-exclude semantics', () => {
  it('excludes an unrecognised field added to the config object', () => {
    // Simulate a future developer adding a new field to KeeperConfig that
    // carries sensitive material.  The allow-list must keep it out of the
    // serialised output automatically — no explicit suppression required.
    const config = baseConfig() as KeeperConfig & { futureSecret?: string };
    config.futureSecret = 'SENSITIVE_FUTURE_VALUE';

    const output = formatConfig(config);
    assert.ok(
      !output.includes('SENSITIVE_FUTURE_VALUE'),
      `formatConfig must not emit unknown/future fields. Output:\n${output}`,
    );
    const parsed = JSON.parse(output);
    assert.ok(
      !('futureSecret' in parsed),
      `"futureSecret" must not appear in the parsed output.`,
    );
  });
});

// ── redactSecret: regex correctness ─────────────────────────────────────────

describe('redactSecret — base32 regex', () => {
  it('redacts a realistic Stellar secret key embedded in a string', () => {
    const secret = TEST_KEYS[4];
    const input = `keeper starting with secret=${secret} end`;
    const result = redactSecret(input);
    assert.ok(
      !result.includes(secret),
      `redactSecret must mask the key.\nInput:  ${input}\nResult: ${result}`,
    );
    // The masked form should start with S followed by asterisks.
    assert.match(result, /S\*{8}/);
  });

  it('does not alter strings that contain no Stellar secret key', () => {
    const input = 'no secret here, just a normal log line';
    assert.equal(redactSecret(input), input);
  });

  it('preserves the last 4 characters of the key in the redacted form', () => {
    const secret = TEST_KEYS[5];
    const result = redactSecret(secret);
    const suffix = secret.slice(-4);
    assert.ok(
      result.endsWith(suffix),
      `Redacted form must end with the last 4 chars ("${suffix}"). Got: ${result}`,
    );
  });

  it('does not match strings that contain invalid base32 chars (0, 1, 8, 9)', () => {
    // The corrected regex uses [A-Z2-7].  Strings using characters outside
    // that set must NOT be redacted because they are structurally impossible
    // Stellar keys.  This was the root cause of the original bug: the old
    // [A-Z0-9] regex accepted 0, 1, 8, 9 which real keys never contain.
    const fakeWith0 = 'S' + '0'.repeat(55); // 0 is not in base32
    const fakeWith1 = 'S' + '1'.repeat(55); // 1 is not in base32
    const fakeWith8 = 'S' + '8'.repeat(55); // 8 is not in base32
    const fakeWith9 = 'S' + '9'.repeat(55); // 9 is not in base32

    for (const fake of [fakeWith0, fakeWith1, fakeWith8, fakeWith9]) {
      assert.equal(
        redactSecret(fake),
        fake,
        `A string with invalid base32 char must not be redacted: ${fake[1]}`,
      );
    }
  });

  it('redacts all 20 test keys', () => {
    for (let i = 0; i < 20; i++) {
      const secret = TEST_KEYS[i];
      const result = redactSecret(secret);
      assert.ok(
        !result.includes(secret),
        `redactSecret failed to mask key index ${i}: ${secret}`,
      );
    }
  });

  it('produces a masked value with the correct structure (S + 8 asterisks + 4 suffix chars)', () => {
    const secret = TEST_KEYS[6]; // S + 55 base32 chars
    const result = redactSecret(secret);
    // Expected: "S" + "********" + last-4-chars = 13 chars total
    assert.equal(result.length, 13, `Expected masked length 13, got ${result.length}: ${result}`);
    assert.equal(result[0], 'S');
    assert.equal(result.slice(1, 9), '********');
    assert.equal(result.slice(9), secret.slice(-4));
  });
});
