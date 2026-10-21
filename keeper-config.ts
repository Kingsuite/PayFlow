export const PUBLIC_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';
export const TEST_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

export interface KeeperConfig {
  secret: string;
  publicKey?: string;
  networkPassphrase: string;
  allowMainnet: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KeeperConfig {
  // Lazy-require dotenv and stellar-sdk so that the pure helpers in this module
  // (formatConfig, redactSecret) are testable without those packages installed.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv');
  dotenv.config();

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Keypair } = require('stellar-sdk') as typeof import('stellar-sdk');

  const secret = env.KEEPER_SECRET;
  if (!secret) {
    throw new Error('KEEPER_SECRET must be set');
  }

  const networkPassphrase = env.NETWORK_PASSPHRASE || TEST_NETWORK_PASSPHRASE;
  const allowMainnet = env.ALLOW_MAINNET === 'true';

  if (networkPassphrase === PUBLIC_NETWORK_PASSPHRASE && !allowMainnet) {
    throw new Error(
      'Mainnet network passphrase detected. Set ALLOW_MAINNET=true to confirm you want to use Mainnet.'
    );
  }

  const publicKey = env.KEEPER_PUBLIC_KEY;
  if (publicKey) {
    const derived = Keypair.fromSecret(secret).publicKey();
    if (derived !== publicKey) {
      throw new Error('KEEPER_PUBLIC_KEY does not match KEEPER_SECRET');
    }
  }

  return {
    secret,
    publicKey,
    networkPassphrase,
    allowMainnet,
  };
}

/**
 * Redact a Stellar secret key from a string.
 *
 * Stellar secret keys are base32-encoded and use only the alphabet [A-Z2-7].
 * They start with 'S' and are 56 characters long.  The original regex used
 * [A-Z0-9] which includes the characters 0, 1, 8 and 9 that are NOT part of
 * base32 — so it could never match a real key.  The corrected regex uses the
 * exact base32 alphabet [A-Z2-7].
 *
 * Prefer formatConfig() over this function for structured output; redactSecret
 * is exported for ad-hoc string sanitisation only.
 */
export function redactSecret(value: string): string {
  return value.replace(/S[A-Z2-7]{55}/g, (match) => {
    return 'S' + '*'.repeat(8) + match.slice(-4);
  });
}

/**
 * Serialise a KeeperConfig for logging.
 *
 * Uses explicit field allow-listing so that any secret-bearing field added to
 * KeeperConfig in the future is excluded from the output by default.  Contrast
 * this with the previous spread-then-patch approach, which would have leaked
 * new secret fields automatically.
 *
 * Included fields: networkPassphrase, allowMainnet, publicKey.
 * Excluded fields: secret (and any future fields not explicitly listed).
 */
export function formatConfig(config: KeeperConfig): string {
  const safe: Record<string, unknown> = {
    networkPassphrase: config.networkPassphrase,
    allowMainnet: config.allowMainnet,
  };
  if (config.publicKey !== undefined) {
    safe.publicKey = config.publicKey;
  }
  return JSON.stringify(safe, null, 2);
}
