/**
 * Sealed secrets: storing a credential Sunrise must read back later, so that
 * a database dump or a backup does not hand it over (§137 t-1043).
 *
 * A webhook signing secret can sit in plaintext beside its destination,
 * because it only ever signs our own requests. A key or token we present to
 * someone else's API is a different risk: whoever holds it can spend on, or
 * act in, another account. Values like that are sealed here before they are
 * written, and opened at the moment they are used.
 *
 * Lifted from ConQuest's `secret-box.ts`, with the one thing it lacked before
 * every app came to depend on it: each envelope names the key that sealed it,
 * so the master key can rotate without anyone resealing values by hand.
 *
 * ## Guarantees
 *
 * - **AES-256-GCM**, a fresh 12-byte IV per value, a 16-byte tag.
 * - **Bound to a purpose.** The caller's `purpose` is authenticated data, so
 *   a value sealed for one purpose does not open as another. Use one purpose
 *   per kind of value and include its owner where it has one
 *   (`org-provider-key:<orgId>:<providerId>`), so a value copied to another
 *   row does not open there either.
 * - **Fails closed.** No keyring, an envelope under a key that is no longer
 *   configured, the wrong purpose, or one changed byte: a typed error. Nothing
 *   here returns, or lets a caller store, plaintext instead.
 * - **Never logs.** Nothing in this module writes a log line, and no error it
 *   throws contains a plaintext, a key or an envelope.
 *
 * ## The envelope
 *
 *     v2.<keyId>.<iv>.<tag>.<ciphertext>      (iv, tag, ciphertext: base64url)
 *
 * The key id and the format are authenticated along with the purpose, so
 * neither can be edited without the value failing to open. The first format,
 * `v1.<iv>.<tag>.<ciphertext>`, is ConQuest's: it names no key and binds only
 * the purpose. It still opens, under the key `SEALED_SECRET_LEGACY_KEY`
 * names, and is never written.
 *
 * ## Rotating the master key
 *
 * Add the new key to `SEALED_SECRET_KEYS` and point
 * `SEALED_SECRET_ACTIVE_KEY` at it. New values seal under it, and old ones
 * keep opening under theirs. To retire the old key, run `npm run
 * secrets:reseal`, which moves every registered store onto the active key
 * (`sealed-stores.ts`), then remove it. Removed too early, the values still
 * under it refuse to open (`unknown_key`) rather than open wrongly.
 *
 * ## Why it is async
 *
 * The keys come from the environment today, which needs no waiting. A
 * managed key service would: the key provider below is the one place that
 * changes when one is added, and keeping the public functions async now means
 * adding it changes no caller. The provider is internal on purpose. It
 * becomes a fork seam when a fork needs one, not before.
 *
 * Server-only: it reads the environment and uses Node's `crypto`.
 *
 * @see lib/security/sealed-secret-keys.ts — the keyring's variables
 * @see lib/security/sealed-stores.ts — resealing every stored value
 * @see .context/security/sealed-secrets.md
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

import { env } from '@/lib/env';
import { readSealedSecretKeyring } from '@/lib/security/sealed-secret-keys';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** No keyring is configured, so nothing can be sealed or opened. */
export class SealedSecretKeyMissingError extends Error {
  constructor() {
    super(
      'No sealed-secret keyring is configured (SEALED_SECRET_KEYS, SEALED_SECRET_ACTIVE_KEY), so stored secrets cannot be sealed or opened'
    );
    this.name = 'SealedSecretKeyMissingError';
  }
}

/**
 * Why a value did not open.
 *
 * - `format`: it is not an envelope this module wrote.
 * - `unknown_key`: it names a key that is not configured, or it is in the
 *   first format and no legacy key is configured. Usually a key retired before
 *   its values were resealed.
 * - `mismatch`: the key, the purpose or the value does not match. Which one
 *   is not something a caller is told: they fail the tag check the same way.
 */
export type SealedSecretOpenFailure = 'format' | 'unknown_key' | 'mismatch';

/** A value that could not be opened. Carries no part of the value. */
export class SealedSecretOpenError extends Error {
  readonly reason: SealedSecretOpenFailure;

  constructor(reason: SealedSecretOpenFailure) {
    super(`A sealed secret could not be opened: ${OPEN_FAILURE_TEXT[reason]}`);
    this.name = 'SealedSecretOpenError';
    this.reason = reason;
  }
}

const OPEN_FAILURE_TEXT: Record<SealedSecretOpenFailure, string> = {
  format: 'it is not a sealed secret',
  unknown_key: 'the key it was sealed under is not configured',
  mismatch: 'the key, the purpose or the value does not match',
};

/**
 * Where keys come from. One implementation today, the environment; a managed
 * key service would be a second. Internal: see the module header.
 */
interface SealingKeys {
  /** The id new values are sealed under. */
  activeKeyId: string;
  /** The id first-format values open under, if any. */
  legacyKeyId: string | undefined;
  /** The 32-byte key for `id`, or `undefined` when no such key is configured. */
  key(id: string): Promise<Buffer | undefined>;
}

/**
 * The keyring from the environment, or `null` when none is configured.
 *
 * Read on every call rather than cached: the environment does not change
 * after boot, the work is one SHA-256 of a short string, and holding no state
 * means a test that changes the environment needs no reset.
 */
function environmentKeys(): SealingKeys | null {
  const read = readSealedSecretKeyring({
    SEALED_SECRET_KEYS: env.SEALED_SECRET_KEYS,
    SEALED_SECRET_ACTIVE_KEY: env.SEALED_SECRET_ACTIVE_KEY,
    SEALED_SECRET_LEGACY_KEY: env.SEALED_SECRET_LEGACY_KEY,
  });
  // `lib/env.ts` refuses to boot on a keyring with problems, so `ok: false`
  // is reachable only when the environment was bypassed (a mocked `env`). It
  // is treated as no keyring: refusing, never guessing.
  if (!read.ok || read.keyring === null) return null;
  const { keys, activeKeyId, legacyKeyId } = read.keyring;
  return {
    activeKeyId,
    legacyKeyId,
    key: (id) => {
      const secret = keys.get(id);
      return Promise.resolve(
        secret === undefined ? undefined : createHash('sha256').update(secret, 'utf8').digest()
      );
    },
  };
}

function requireKeys(): SealingKeys {
  const keys = environmentKeys();
  if (!keys) throw new SealedSecretKeyMissingError();
  return keys;
}

/** Whether a keyring is configured, so values can be sealed and opened. */
export function isSealedSecretKeyConfigured(): boolean {
  return environmentKeys() !== null;
}

/**
 * The id of the key new values are sealed under. Not secret: it is in every
 * envelope.
 *
 * @throws SealedSecretKeyMissingError when no keyring is configured.
 */
export function activeSealedSecretKeyId(): string {
  return requireKeys().activeKeyId;
}

function assertPurpose(purpose: string): void {
  if (typeof purpose !== 'string' || purpose.length === 0) {
    // A programming error, not a runtime condition: every value has a purpose.
    throw new TypeError('A sealed secret needs a non-empty purpose');
  }
}

/** The authenticated data for a v2 envelope: format, key id and purpose. */
function v2AuthenticatedData(keyId: string, purpose: string): Buffer {
  // A key id cannot contain NUL (SEALED_SECRET_KEY_ID_PATTERN), so the
  // purpose after the second separator is unambiguous whatever it contains.
  return Buffer.from(`sealed-secret/v2\0${keyId}\0${purpose}`, 'utf8');
}

/**
 * Seal `plaintext` for `purpose` under the active key.
 *
 * @throws SealedSecretKeyMissingError when no keyring is configured.
 */
export async function sealSecret(plaintext: string, purpose: string): Promise<string> {
  assertPurpose(purpose);
  const keys = requireKeys();
  const keyId = keys.activeKeyId;
  const key = await keys.key(keyId);
  // The keyring guarantees the active id is a configured key; a provider that
  // broke that would otherwise seal under `undefined`.
  if (!key) throw new SealedSecretKeyMissingError();

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(v2AuthenticatedData(keyId, purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v2',
    keyId,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** An envelope's parts, from its header alone. Nothing here is authenticated yet. */
type ParsedEnvelope =
  | { format: 'v2'; keyId: string; iv: Buffer; tag: Buffer; body: Buffer }
  | { format: 'v1'; iv: Buffer; tag: Buffer; body: Buffer };

function parseEnvelope(sealed: string): ParsedEnvelope | null {
  if (typeof sealed !== 'string') return null;
  const parts = sealed.split('.');
  let format: 'v1' | 'v2';
  let keyId = '';
  let encoded: string[];
  if (parts[0] === 'v2' && parts.length === 5) {
    format = 'v2';
    keyId = parts[1];
    encoded = parts.slice(2);
  } else if (parts[0] === 'v1' && parts.length === 4) {
    format = 'v1';
    encoded = parts.slice(1);
  } else {
    return null;
  }
  if (!encoded.every((part) => BASE64URL.test(part))) return null;
  const [iv, tag, body] = encoded.map((part) => Buffer.from(part, 'base64url'));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  return format === 'v2' ? { format, keyId, iv, tag, body } : { format, iv, tag, body };
}

/**
 * Open a value {@link sealSecret} sealed for the same `purpose` (or that
 * ConQuest's helper sealed, in the first format).
 *
 * @throws SealedSecretKeyMissingError when no keyring is configured.
 * @throws SealedSecretOpenError when the value is not an envelope, names a key
 *   that is not configured, or does not match its key, purpose or contents.
 */
export async function openSecret(sealed: string, purpose: string): Promise<string> {
  assertPurpose(purpose);
  const keys = requireKeys();
  const envelope = parseEnvelope(sealed);
  if (!envelope) throw new SealedSecretOpenError('format');

  const keyId = envelope.format === 'v2' ? envelope.keyId : keys.legacyKeyId;
  const key = keyId === undefined ? undefined : await keys.key(keyId);
  if (!key || keyId === undefined) throw new SealedSecretOpenError('unknown_key');

  try {
    const decipher = createDecipheriv(ALGORITHM, key, envelope.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(
      envelope.format === 'v2'
        ? v2AuthenticatedData(keyId, purpose)
        : // ConQuest's format binds the purpose alone. Kept byte-for-byte, so its
          // values open without being resealed.
          Buffer.from(purpose, 'utf8')
    );
    decipher.setAuthTag(envelope.tag);
    return Buffer.concat([decipher.update(envelope.body), decipher.final()]).toString('utf8');
  } catch {
    throw new SealedSecretOpenError('mismatch');
  }
}

/**
 * Whether `sealed` should be resealed: it is not a current-format value under
 * the active key. Reads the header only, so it says nothing about whether the
 * value opens. Something that is not an envelope at all answers `true`, and
 * the reseal then reports it as unopenable.
 *
 * @throws SealedSecretKeyMissingError when no keyring is configured.
 */
export function needsReseal(sealed: string): boolean {
  const keys = requireKeys();
  const envelope = parseEnvelope(sealed);
  return !(envelope?.format === 'v2' && envelope.keyId === keys.activeKeyId);
}
