/**
 * Local Filesystem Storage Provider
 *
 * Implements the StorageProvider interface for local filesystem storage.
 * Designed for development only - not suitable for production.
 *
 * Two roots, chosen by `upload({ public })`:
 *
 * - **public** (default) → `public/uploads/`, served statically by Next at
 *   `/uploads/<key>`.
 * - **private** (`public: false`) → `.storage/private/`, outside anything
 *   Next serves. Readable only through `download()` or the signed route at
 *   `/api/v1/storage/<key>`.
 *
 * A key is unique across the pair: `upload()` removes any copy from the
 * opposite root after writing, so re-uploading a key with the other
 * visibility cannot leave a stale — possibly world-readable — twin behind.
 *
 * Which root holds a key is not recorded anywhere, though, so every read and
 * delete checks private first and then public. Deletes span both roots;
 * missing that is how `eraseUser()` would leave a user's private files on
 * disk after erasure.
 *
 * @see .context/storage/overview.md for configuration documentation
 */

import { writeFile, unlink, mkdir, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import type {
  StorageProvider,
  StorageCapabilities,
  StorageObject,
  UploadOptions,
  UploadResult,
  DeleteResult,
} from '@/lib/storage/providers/types';
import { validateStorageKey } from '@/lib/storage/providers/validate-key';
import { buildStorageAccessUrl } from '@/lib/storage/access-tokens';
import { logger } from '@/lib/logging';

/** Where private objects live when not configured otherwise. Gitignored. */
export const DEFAULT_PRIVATE_DIR = '.storage/private';

/**
 * Local Provider Configuration
 */
export interface LocalProviderConfig {
  /** Base directory for public file storage (default: public/uploads) */
  baseDir?: string;
  /** Base URL for serving public files (default: /uploads) */
  baseUrl?: string;
  /**
   * Directory for private objects — anything uploaded with `public: false`
   * (default: `.storage/private`).
   *
   * Must sit outside `public/`, or Next serves it statically and the
   * `public: false` contract is broken again.
   */
  privateDir?: string;
}

/**
 * Local Filesystem Storage Provider
 *
 * Stores files in the public directory for static serving.
 * Only use in development - files are not persisted across deploys.
 */
export class LocalProvider implements StorageProvider {
  readonly name = 'local';
  private baseDir: string;
  private baseUrl: string;
  private privateDir: string;

  /**
   * `signedUrls` is served by `/api/v1/storage/<key>` with an HMAC token
   * from `lib/storage/access-tokens.ts` — not by the filesystem, which has
   * no notion of a URL.
   */
  readonly capabilities: Partial<StorageCapabilities> = {
    privateObjects: true,
    signedUrls: true,
    download: true,
  };

  constructor(config: LocalProviderConfig = {}) {
    this.baseDir = config.baseDir || join(process.cwd(), 'public', 'uploads');
    this.baseUrl = config.baseUrl || '/uploads';
    this.privateDir = config.privateDir || join(process.cwd(), DEFAULT_PRIVATE_DIR);

    logger.debug('Local storage provider initialized', {
      baseDir: this.baseDir,
      baseUrl: this.baseUrl,
      privateDir: this.privateDir,
    });
  }

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    const { key } = options;
    validateStorageKey(key);

    const isPrivate = options.public === false;
    const root = isPrivate ? this.privateDir : this.baseDir;
    const filePath = resolveWithin(root, key);
    const fileDir = dirname(filePath);

    // Ensure directory exists
    if (!existsSync(fileDir)) {
      await mkdir(fileDir, { recursive: true });
    }

    // Write file
    await writeFile(filePath, file);

    // Enforce one-key-one-root. Re-uploading an existing key with the opposite
    // visibility would otherwise leave the old copy in place, and since
    // `download()` checks the private root first, flipping a key from public to
    // private would return the private bytes while the original stayed
    // world-readable at `/uploads/<key>` forever. Removal happens after the
    // write succeeds, so a failed upload never destroys the existing object.
    const staleRoot = isPrivate ? this.baseDir : this.privateDir;
    const stalePath = resolveWithin(staleRoot, key);
    try {
      // Unlink unconditionally and treat "wasn't there" as the success it is,
      // rather than testing with `existsSync` first — the same TOCTOU reasoning
      // as `download()`, and here the check would also be a wasted syscall on
      // every upload.
      await unlink(stalePath);
      logger.info('Removed stale copy of key from the other storage root', {
        key,
        stalePath,
        newVisibility: isPrivate ? 'private' : 'public',
      });
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        logger.error('Failed to remove stale copy from the other storage root', error, {
          key,
          stalePath,
        });
        // Fail the upload even though the write succeeded. Returning success
        // here would tell the caller the object is private while the old copy
        // is still served at `/uploads/<key>` — exactly the silent failure this
        // branch exists to remove. Retrying the upload is safe and idempotent.
        throw new Error(
          `Uploaded ${key} but could not remove the existing copy in the ` +
            `${isPrivate ? 'public' : 'private'} root — the object may still be readable there`
        );
      }
    }

    // A private object has no static URL by construction. Point at the
    // signed read route: the path alone won't serve the file — the route
    // requires a token from `getSignedUrl()` — but it is the object's
    // address, and it is not a URL that quietly works for everyone.
    //
    // Encoded per segment so a key with a space or `#` produces a valid URL,
    // matching what `buildStorageAccessUrl()` emits for the same key. The
    // public branch is left alone: it has always returned the raw key, and
    // Next resolves it against the filesystem either way.
    const url = isPrivate
      ? `/api/v1/storage/${key.split('/').map(encodeURIComponent).join('/')}`
      : `${this.baseUrl}/${key}`;

    logger.info('File uploaded to local storage', {
      key,
      filePath,
      size: file.length,
      url,
      visibility: isPrivate ? 'private' : 'public',
    });

    return {
      key,
      url,
      size: file.length,
    };
  }

  /**
   * Delete a file from **both** roots.
   *
   * The caller does not tell us whether the object was public or private,
   * and nothing on disk records it, so both are swept.
   */
  async delete(key: string): Promise<DeleteResult> {
    validateStorageKey(key);

    const paths = [resolveWithin(this.privateDir, key), resolveWithin(this.baseDir, key)];
    let success = true;

    for (const filePath of paths) {
      try {
        if (existsSync(filePath)) {
          await unlink(filePath);
          logger.info('File deleted from local storage', { key, filePath });
        } else {
          logger.debug('File not found for deletion', { key, filePath });
        }
      } catch (error) {
        logger.error('Failed to delete file from local storage', error, { key, filePath });
        success = false;
      }
    }

    return { success, key };
  }

  /**
   * Delete every file under a prefix, from **both** roots.
   *
   * This is the erasure path: `eraseUser()` calls `deleteByPrefix()` to
   * clear a user's blobs. Sweeping only the public root would leave the
   * private copies on disk and turn GDPR erasure into a partial delete —
   * which is the bug, not a missing nice-to-have.
   *
   * A prefix that names the root itself is refused by `resolveWithin` — this
   * is the call site where that would have been catastrophic (#508). Both
   * resolutions happen before any `rm`, so a refusal deletes nothing from
   * either root.
   */
  async deletePrefix(prefix: string): Promise<DeleteResult> {
    validateStorageKey(prefix);

    const dirs = [resolveWithin(this.privateDir, prefix), resolveWithin(this.baseDir, prefix)];
    let success = true;

    for (const dirPath of dirs) {
      try {
        if (existsSync(dirPath)) {
          await rm(dirPath, { recursive: true });
          logger.info('Directory deleted from local storage', { prefix, dirPath });
        } else {
          logger.debug('Directory not found for deletion', { prefix, dirPath });
        }
      } catch (error) {
        logger.error('Failed to delete directory from local storage', error, { prefix, dirPath });
        success = false;
      }
    }

    return { success, key: prefix };
  }

  /**
   * Read an object back as bytes.
   *
   * Private root first: a caller asking for bytes by key is usually after
   * the private object, and checking it first means a public file never
   * shadows a private one of the same key.
   */
  async download(key: string): Promise<StorageObject> {
    validateStorageKey(key);

    for (const root of [this.privateDir, this.baseDir]) {
      const filePath = resolveWithin(root, key);

      // Just read it, and let the failure classify the path. Checking
      // existence (or stat-ing for `isFile`) first would be a TOCTOU race:
      // the file can be replaced between the check and the read, so the
      // answer would describe a file we did not open. `readFile` opens once
      // and reports on that handle.
      try {
        const body = await readFile(filePath);

        // Length of what we actually read — the caller uses this as a
        // Content-Length, so it must describe these exact bytes.
        return { key, body, size: body.length };
      } catch (error) {
        // ENOENT — not in this root. EISDIR — the key names a directory
        // (`documents/user-1`). Both mean "no object here": try the other
        // root, then fall through to a clean "not found". Anything else
        // (EACCES, EMFILE) is a real fault and must not be swallowed.
        const code = errnoCode(error);
        if (code === 'ENOENT' || code === 'EISDIR') continue;
        throw error;
      }
    }

    throw new Error(`Object not found in local storage: ${key}`);
  }

  /**
   * Mint a time-limited URL for the signed read route.
   *
   * Unlike S3's presigned URLs this does not check that the object exists —
   * the route resolves the key when the URL is used, and a token for a
   * missing key simply 404s there.
   */
  // Signing is synchronous here — an HMAC, not a round trip like S3's
  // presigner. It stays `async` regardless so a rejected key comes back as a
  // rejected promise: the interface is `Promise<string>`, and a method that
  // throws synchronously would slip past every caller's `.catch()`.
  // eslint-disable-next-line @typescript-eslint/require-await
  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    validateStorageKey(key);

    const { url } = buildStorageAccessUrl(key, expiresIn);

    logger.debug('Generated signed URL for local storage', { key, expiresIn });

    return url;
  }
}

/**
 * Read the `code` off a Node filesystem error without asserting a type onto
 * it — `catch` binds `unknown`, and the project forbids `as` on values that
 * did not come from a validated source.
 */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Join `key` onto `root` and refuse anything that is not strictly inside it —
 * including the root itself.
 *
 * `validateStorageKey` already rejects `..`, absolute paths, backslashes
 * and null bytes, so this is a backstop rather than the primary defence.
 * It earns its place because the private root is the first place in this
 * codebase where a traversal would *read a secret* rather than write a
 * junk file — worth not depending on a single validator staying strict.
 *
 * **The root itself is not a legal target (#508).** `validateStorageKey(".")`
 * passes every rule it has — no `..`, not absolute, no NUL, no backslash — and
 * `resolve(root, ".")` is `root`, so a key of `"."`, `"./"` or any other
 * spelling that normalises to nothing used to resolve to the root and be handed
 * to whatever the caller does next. `deletePrefix` is the destructive one: it
 * `rm`s recursively, so that key erased every object the provider held. But
 * `upload` is not the harmless `EISDIR` the first cut of this fix claimed —
 * with the root absent (the default `.storage/private` on a fresh checkout) it
 * `mkdir`s `dirname(root)`, *outside* the root this function exists to contain,
 * then writes a regular **file** at the root path, after which every upload
 * fails `ENOTDIR` until someone deletes it. `delete` and `download` genuinely do
 * fail on `EISDIR`, but no caller has a use for a key naming the root, so the
 * rule belongs here rather than at three of the four call sites.
 *
 * Comparing resolved paths rather than screening the key string catches every
 * spelling at once, including ones normalisation invents. Nothing reaches this
 * today — the object keys are `avatars/${userId}/…` and
 * `${keyPrefix}${randomUUID()}${ext}`, and no route takes a caller-supplied
 * prefix — so this is defence in depth, worth the one comparison because the
 * `deletePrefix` blast radius is total.
 */
function resolveWithin(root: string, key: string): string {
  const rootPath = resolve(root);
  const fullPath = resolve(rootPath, key);

  if (fullPath === rootPath) {
    throw new Error('Storage key must not resolve to the storage root');
  }

  if (!fullPath.startsWith(rootPath + sep)) {
    throw new Error('Storage key resolves outside the storage root');
  }

  return fullPath;
}

/**
 * Create Local provider
 *
 * Always returns a valid provider - no configuration required.
 */
export function createLocalProvider(config: LocalProviderConfig = {}): LocalProvider {
  return new LocalProvider(config);
}

/**
 * Create Local provider from environment variables
 *
 * Every variable is optional — the defaults are the development ones. This
 * exists so `client.ts` can configure the provider at all: it used to call
 * a zero-argument factory, which made `LocalProviderConfig` unreachable
 * outside tests.
 */
export function createLocalProviderFromEnv(): LocalProvider {
  const baseDir = process.env.STORAGE_LOCAL_BASE_DIR;
  const baseUrl = process.env.STORAGE_LOCAL_BASE_URL;
  const privateDir = process.env.STORAGE_LOCAL_PRIVATE_DIR;

  return new LocalProvider({
    ...(baseDir ? { baseDir } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(privateDir ? { privateDir } : {}),
  });
}
