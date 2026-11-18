/**
 * The master keys sealed secrets are sealed under: reading the keyring from
 * its three environment variables.
 *
 * Pure: it takes the variables as arguments and imports nothing that reads
 * the environment, because `lib/env.ts` validates the keyring with it at boot
 * and `sealed-secrets.ts` reads it at every seal and open.
 *
 * ## The variables
 *
 * - `SEALED_SECRET_KEYS`: every key that may still open a value, as
 *   comma-separated `id:secret` pairs, e.g. `k2026:…,k2025:…`. An id is
 *   lowercase letters, digits and hyphens, at most 32 characters, starting
 *   with a letter or digit. A secret is any string of at least 32 characters
 *   without a comma (`openssl rand -base64 32` gives 44).
 * - `SEALED_SECRET_ACTIVE_KEY`: the id new values are sealed under. Required
 *   whenever `SEALED_SECRET_KEYS` is set, even with one key: which key seals
 *   is a decision, and inferring it from order would make reordering the list
 *   a silent rotation.
 * - `SEALED_SECRET_LEGACY_KEY`: optional. The id that values sealed in the
 *   first envelope format (`v1.`, which names no key) open under. An app
 *   whose values were sealed before key ids existed sets this to the id it
 *   gave its old key; nothing is resealed.
 *
 * All three unset means no keyring: sealing and opening refuse, which is the
 * shipped state. Any one set without `SEALED_SECRET_KEYS` is a mistake and is
 * refused, as is an empty value, rather than read as "unset".
 *
 * **No message here ever contains a secret.** Problems name the variable and
 * the key id, never the value, because they are printed at boot.
 *
 * @see lib/security/sealed-secrets.ts — what the keyring is for
 * @see .context/security/sealed-secrets.md
 */

/** What a key id may look like: it is written into every envelope, so it has no `.`. */
export const SEALED_SECRET_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The shortest secret accepted. Hashed to the 32 bytes AES-256 needs. */
export const SEALED_SECRET_MIN_LENGTH = 32;

/** The keyring's environment variables, as the environment holds them. */
export interface SealedSecretKeyringVariables {
  SEALED_SECRET_KEYS?: string | undefined;
  SEALED_SECRET_ACTIVE_KEY?: string | undefined;
  SEALED_SECRET_LEGACY_KEY?: string | undefined;
}

export type SealedSecretKeyringVariable = keyof SealedSecretKeyringVariables;

/** A keyring read from its variables. */
export interface SealedSecretKeyring {
  /** Every configured key: id → secret. */
  keys: ReadonlyMap<string, string>;
  /** The id new values are sealed under. Always a key in `keys`. */
  activeKeyId: string;
  /** The id first-format values open under, when one is configured. Always a key in `keys`. */
  legacyKeyId: string | undefined;
}

/** One thing wrong with the keyring's variables. */
export interface SealedSecretKeyringProblem {
  variable: SealedSecretKeyringVariable;
  message: string;
}

export type SealedSecretKeyringRead =
  /** `keyring` is `null` when none of the variables is set. */
  | { ok: true; keyring: SealedSecretKeyring | null }
  | { ok: false; problems: SealedSecretKeyringProblem[] };

/**
 * Read the keyring from its variables, or say everything that is wrong with
 * them. Never throws, and never puts a secret in a problem.
 */
export function readSealedSecretKeyring(
  variables: SealedSecretKeyringVariables
): SealedSecretKeyringRead {
  const {
    SEALED_SECRET_KEYS: rawKeys,
    SEALED_SECRET_ACTIVE_KEY: active,
    SEALED_SECRET_LEGACY_KEY: legacy,
  } = variables;

  if (rawKeys === undefined && active === undefined && legacy === undefined) {
    return { ok: true, keyring: null };
  }

  const problems: SealedSecretKeyringProblem[] = [];
  const keys = new Map<string, string>();

  if (rawKeys === undefined) {
    problems.push({
      variable: 'SEALED_SECRET_KEYS',
      message:
        'SEALED_SECRET_KEYS is not set, but SEALED_SECRET_ACTIVE_KEY or SEALED_SECRET_LEGACY_KEY is. Set it to the keys, as comma-separated id:secret pairs.',
    });
  } else {
    const entries = rawKeys.split(',').map((entry) => entry.trim());
    entries.forEach((entry, index) => {
      const position = `entry ${index + 1}`;
      const separator = entry.indexOf(':');
      if (separator === -1) {
        problems.push({
          variable: 'SEALED_SECRET_KEYS',
          message: `SEALED_SECRET_KEYS ${position} is not an id:secret pair.`,
        });
        return;
      }
      const id = entry.slice(0, separator);
      const secret = entry.slice(separator + 1);
      if (!SEALED_SECRET_KEY_ID_PATTERN.test(id)) {
        // The id is not echoed either: a malformed entry may be a pasted secret.
        problems.push({
          variable: 'SEALED_SECRET_KEYS',
          message: `SEALED_SECRET_KEYS ${position} has an invalid id: use lowercase letters, digits and hyphens, at most 32 characters.`,
        });
        return;
      }
      if (secret.length < SEALED_SECRET_MIN_LENGTH) {
        problems.push({
          variable: 'SEALED_SECRET_KEYS',
          message: `SEALED_SECRET_KEYS key "${id}" is shorter than ${SEALED_SECRET_MIN_LENGTH} characters. Generate one with: openssl rand -base64 32`,
        });
        return;
      }
      if (keys.has(id)) {
        problems.push({
          variable: 'SEALED_SECRET_KEYS',
          message: `SEALED_SECRET_KEYS names key "${id}" twice.`,
        });
        return;
      }
      keys.set(id, secret);
    });
  }

  if (active === undefined) {
    if (rawKeys !== undefined) {
      problems.push({
        variable: 'SEALED_SECRET_ACTIVE_KEY',
        message:
          'SEALED_SECRET_ACTIVE_KEY is not set. Set it to the id of the key new values are sealed under.',
      });
    }
  } else if (!keys.has(active)) {
    problems.push({
      variable: 'SEALED_SECRET_ACTIVE_KEY',
      message: describeMissingId('SEALED_SECRET_ACTIVE_KEY', active),
    });
  }

  if (legacy !== undefined && !keys.has(legacy)) {
    problems.push({
      variable: 'SEALED_SECRET_LEGACY_KEY',
      message: describeMissingId('SEALED_SECRET_LEGACY_KEY', legacy),
    });
  }

  if (problems.length > 0 || active === undefined) return { ok: false, problems };
  return { ok: true, keyring: { keys, activeKeyId: active, legacyKeyId: legacy } };
}

function describeMissingId(variable: SealedSecretKeyringVariable, id: string): string {
  // Echo the id only when it is shaped like one: a value pasted into the wrong
  // variable would otherwise be printed at boot.
  const named = SEALED_SECRET_KEY_ID_PATTERN.test(id) ? `"${id}"` : 'its value';
  return `${variable} names ${named}, which is not a key in SEALED_SECRET_KEYS.`;
}
