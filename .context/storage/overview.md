# Storage System

The storage system provides multi-provider file storage for Sunrise, following the same patterns as the email system (singleton client with graceful degradation).

## Architecture

```
lib/storage/
├── client.ts              # getStorageClient(), isStorageEnabled(), getStorageProviderName()
├── upload.ts              # uploadAvatar(), deleteFile(), deleteAvatar(), deleteByPrefix()
├── image.ts               # validateImageMagicBytes(), processImage(), getExtensionForMimeType(), isSupportedImageType()
├── constants.ts           # Client-safe constants (SUPPORTED_IMAGE_TYPES, IMAGE_EXTENSIONS)
├── access-tokens.ts       # HMAC read tokens for the signed storage route
└── providers/
    ├── types.ts           # StorageProvider interface, StorageCapabilities, getStorageCapabilities()
    ├── validate-key.ts    # validateStorageKey() - path traversal prevention
    ├── s3.ts              # AWS S3 / S3-compatible (S3ProviderConfig)
    ├── vercel-blob.ts     # Vercel Blob Storage (VercelBlobProviderConfig)
    └── local.ts           # Local filesystem (LocalProviderConfig)

lib/validations/
└── storage.ts             # Zod schemas for file validation (size, mime types)

components/forms/
└── avatar-crop-dialog.tsx # Reusable avatar cropping dialog (react-easy-crop)
```

## Provider Selection

Providers are selected in this priority:

1. **Explicit**: `STORAGE_PROVIDER` env var (`s3`, `vercel-blob`, `local`)
2. **Auto-detect**: Based on available credentials (S3 → Vercel Blob)
3. **Fallback**: Local filesystem in development mode

```bash
# Explicit selection
STORAGE_PROVIDER=s3

# Or auto-detect from credentials
S3_BUCKET=my-bucket
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

## Object Visibility

`upload()` takes a `public` option that defaults to `true`. Whether `public: false` can be honoured depends entirely on the backend, so **ask before you write**:

```typescript
import { getStorageCapabilities } from '@/lib/storage/providers/types';

const storage = getStorageClient();
if (!storage) return;

const caps = getStorageCapabilities(storage);
if (!caps.privateObjects) {
  // Refuse up front. Uploading anyway publishes the file.
  throw new Error(`${storage.name} cannot store private objects`);
}

await storage.upload(buffer, { key, contentType, public: false });
```

### Capabilities matrix

| Capability       | S3                                              | Vercel Blob | Local |
| ---------------- | ----------------------------------------------- | ----------- | ----- |
| `privateObjects` | `S3_USE_ACL` or `S3_OBJECTS_PRIVATE_BY_DEFAULT` | ✗           | ✓     |
| `signedUrls`     | ✓                                               | ✗           | ✓     |
| `download`       | ✓                                               | ✗           | ✓     |

**Read capabilities through `getStorageCapabilities(provider)` — never `provider.capabilities` directly.** The field is an optional `Partial<StorageCapabilities>` so that a fork's custom provider (see [Adding a New Provider](#adding-a-new-provider)) keeps compiling when a capability is added upstream. An undeclared capability means _cannot_, and the helper is what fills that in.

### What each provider does with `public: false`

- **S3** — sends `ACL: private` when `S3_USE_ACL=true`. Without ACLs it cannot verify object visibility from the SDK, so it logs a warning (once per process) and uploads anyway. This is deliberate: the AWS-recommended posture is Block Public Access plus a bucket policy, where every object is _already_ private and throwing would reject the safest configuration. Declare that posture with `S3_OBJECTS_PRIVATE_BY_DEFAULT=true`.
- **Vercel Blob** — **throws**. Every blob is served from a public CDN URL; there is no configuration that makes this work, so an ambiguous warning would be dishonest.
- **Local** — writes to a separate private root (`.storage/private/`, gitignored) that Next does not serve. Public uploads still go to `public/uploads/`. Read a private object back with `download()`.

The `upload_to_storage` agent capability enforces this automatically: a binding with `public: false` or `signedUrlTtlSeconds` on a provider that lacks `privateObjects` fails with `private_objects_not_supported` rather than handing the user a world-readable URL.

## Providers

### S3 Provider

Works with AWS S3 and any S3-compatible service (MinIO, DigitalOcean Spaces, Cloudflare R2). Uses `S3ProviderConfig` interface for typed configuration.

```bash
# Required
S3_BUCKET=my-bucket
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...

# Optional
S3_REGION=us-east-1                          # Default: us-east-1
S3_ENDPOINT=https://s3.custom.com            # For S3-compatible services
S3_PUBLIC_URL_BASE=https://cdn.example.com   # Custom CDN/domain
S3_USE_ACL=true                              # Enable ACL (only for legacy buckets, off by default)
S3_OBJECTS_PRIVATE_BY_DEFAULT=true           # Bucket blocks public access — declares privateObjects
```

> **Note:** Modern S3 buckets (since April 2023) have ACLs disabled by default. Only set `S3_USE_ACL=true` for legacy buckets that use ACL-based access control.

**Signed URLs:**

S3Provider supports generating time-limited signed URLs for private file access:

```typescript
const storage = getStorageClient();
// Check the capability, not the provider name — a fork may add another
// backend that signs URLs, and `name === 's3'` would lock it out.
if (storage && getStorageCapabilities(storage).signedUrls) {
  // Generate a signed URL valid for 1 hour (3600 seconds)
  const signedUrl = await storage.getSignedUrl!('documents/private-report.pdf', 3600);
}
```

### Vercel Blob Provider

Integrated with Vercel deployments. Simple setup, CDN-backed. Uses `VercelBlobProviderConfig` interface for typed configuration.

```bash
BLOB_READ_WRITE_TOKEN=vercel_blob_...
```

Get token from: Vercel Dashboard → Storage → Blob

> **Note:** Vercel Blob does not support signed URLs - all files are publicly accessible. Use S3 if you need private file access with time-limited URLs.

### Local Provider

Development fallback. Uses `LocalProviderConfig` for typed configuration, built by `createLocalProviderFromEnv()`.

Two roots:

| Upload                   | Directory           | Served at                 | Read back via                  |
| ------------------------ | ------------------- | ------------------------- | ------------------------------ |
| default (`public: true`) | `public/uploads/`   | `/uploads/<key>` (static) | direct URL                     |
| `public: false`          | `.storage/private/` | signed route only         | `download()`, `getSignedUrl()` |

```bash
# All optional — these are the defaults
STORAGE_LOCAL_BASE_DIR=public/uploads
STORAGE_LOCAL_BASE_URL=/uploads
STORAGE_LOCAL_PRIVATE_DIR=.storage/private
```

- No configuration required
- Automatically enabled in development when no cloud provider configured
- **Not for production** - files don't persist across deploys
- `.storage/` is gitignored

> **Keep the private root outside `public/`.** Pointing `STORAGE_LOCAL_PRIVATE_DIR` at anything Next serves statically re-creates the exact bug this split exists to fix.

**Deletes span both roots.** Nothing records which root holds a given key, so `delete()` and `deletePrefix()` sweep both and `download()` checks private first. This matters for erasure: `eraseUser()` clears a user's blobs with `deleteByPrefix('avatars/<userId>/')`, and sweeping only the public root would leave their private files on disk.

## API Endpoints

### Rate Limiting

The avatar upload endpoint (`/api/v1/users/me/avatar`) is protected by `uploadLimiter` from `lib/security/rate-limit.ts`. When the rate limit is exceeded, the endpoint returns HTTP 429 (Too Many Requests).

### Signed Object Read

```http
GET /api/v1/storage/<key...>?token=<signed>
```

Serves a privately stored object. Mint the URL with `getSignedUrl()`:

```typescript
const storage = getStorageClient();
const url = await storage!.getSignedUrl('documents/user-1/contract.pdf', 300); // 5 min
// → /api/v1/storage/documents/user-1/contract.pdf?token=eyJrZXk...
```

Provider-agnostic — it works with anything declaring the `download` capability — but in practice it exists for the local provider, since S3 signs its own URLs directly against the bucket.

**The token is the only credential, and it grants exactly one key.** There is deliberately no session fallback. Storage keys carry no ownership (`agent-uploads/{agentId}/{uuid}` names no user), so `withAuth()` here would let any authenticated user read any private object — worse than having no read path. The route compares the key inside the token against the key requested and 403s on a mismatch.

Tokens are stateless HMAC-SHA256 over `BETTER_AUTH_SECRET` (`lib/storage/access-tokens.ts`, same shape as `lib/orchestration/approval-tokens.ts`) — no table, no migration. **Rotating `BETTER_AUTH_SECRET` invalidates every outstanding URL**, which is the intended lever if one leaks. Lifetime is capped at 7 days.

The payload is `{ typ: 'storage-read', key, expiresAt }`. `typ` is the domain separator against the approval scheme, which signs the same construction with the same secret: without a tag in the signed bytes, the MAC cannot tell the two protocols apart, and the only thing preventing cross-scheme replay is that the two payload schemas happen to be disjoint on required fields. Verification asserts the tag (#507).

**Adding another signed scheme? Derive a subkey, don't reuse the raw secret.** These two token modules HMAC `BETTER_AUTH_SECRET` directly, which is why they need `typ` at all — and they are not the only things rooted in that secret: better-auth signs its own sessions and JWTs with it (`lib/auth/config.ts`, `lib/auth/change-email.ts`), and `lib/logging/visitor-id.ts` signs the visitor cookie. Treat this as a non-exhaustive list and grep before assuming.

`visitor-id.ts` does the stronger thing: HKDF to a subkey under a versioned label (`sunrise:visitor-id:v1`), so it shares no signing key with anything and cannot be confused with any other scheme by construction. Prefer that for new schemes. If a scheme does sign with the raw secret, it **must** carry its own `typ`.

`generateStorageAccessToken()` signs whatever key it is given — only `getSignedUrl()` validates first. The route therefore re-runs `validateStorageKey()` after the token checks, so a token minted directly for a traversal key is rejected with `INVALID_KEY` rather than reaching the filesystem.

| Status | Code                     | Meaning                                     |
| ------ | ------------------------ | ------------------------------------------- |
| 400    | `INVALID_KEY`            | Token authentically names an unsafe key     |
| 401    | `TOKEN_REQUIRED`         | No `token` query parameter                  |
| 401    | `INVALID_TOKEN`          | Expired, tampered, or malformed             |
| 403    | `TOKEN_KEY_MISMATCH`     | Valid token, but minted for a different key |
| 404    | `NOT_FOUND`              | No such object                              |
| 501    | `DOWNLOAD_NOT_SUPPORTED` | Provider has no `download` capability       |
| 503    | `STORAGE_NOT_CONFIGURED` | No provider configured                      |

Responses are always `application/octet-stream` with `Content-Disposition: attachment`, `nosniff`, and a `default-src 'none'` CSP — never the object's real content type. These are user-supplied bytes on the app's own origin, so rendering an uploaded `.html` or `.svg` inline would be stored XSS against a live session. To display an object, fetch it and build an object URL client-side.

### Upload Avatar

```http
POST /api/v1/users/me/avatar
Content-Type: multipart/form-data

file: <binary>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "url": "https://.../avatars/user-123/avatar.jpg?v=1706012345678",
    "key": "avatars/user-123/avatar.jpg",
    "size": 12345,
    "width": 500,
    "height": 500
  }
}
```

> **Cache Busting:** The stored URL includes a `?v={timestamp}` query parameter to ensure browsers fetch the new image after avatar replacement. This cache-busted URL is what gets stored in the user's `image` field.

### Delete Avatar

```http
DELETE /api/v1/users/me/avatar
```

**Response:**

```json
{
  "success": true,
  "data": {
    "success": true,
    "message": "Avatar removed"
  }
}
```

## Image Processing

Images are automatically processed before upload:

1. **Validation**: Magic bytes check (not just MIME type)
2. **Resize**: Max 500x500 pixels (configurable)
3. **Optimize**: Quality compression for web (default JPEG quality: 85)
4. **Format**: Avatars always output JPEG regardless of input format. When using `processImage` directly without specifying a format, the original format is preserved.

Supported formats: JPEG, PNG, WebP, GIF

### Fit: square crop vs. bounding box

`processImage` takes a `fit` option. Both modes only ever shrink — neither
upscales a small source into a blurry large one.

| `fit`               | Result                                                                            | Use for        |
| ------------------- | --------------------------------------------------------------------------------- | -------------- |
| `'cover'` (default) | Centre-cropped **square**, sized to the smaller of `maxWidth`/`maxHeight`         | Avatars        |
| `'inside'`          | Scaled to fit **inside** the `maxWidth` × `maxHeight` box, aspect ratio preserved | Logos, banners |

```typescript
// Avatar — square, centre-cropped (what uploadAvatar() does)
await processImage(buffer, { maxWidth: 500, maxHeight: 500 });

// Logo — the caps are a real bounding box; nothing is cropped
await processImage(buffer, { maxWidth: 800, maxHeight: 200, fit: 'inside' });
```

`'cover'` collapses the two caps to a single square dimension, so a
`800 × 200` request under the default fit yields a `200 × 200` square. Pass
`fit: 'inside'` whenever the image is not square by nature — a centre-cropped
wordmark or banner is unusable.

### Client-Side Crop

The `AvatarUpload` component includes an integrated crop dialog (react-easy-crop). The cropping functionality is also available as a standalone `AvatarCropDialog` component (`components/forms/avatar-crop-dialog.tsx`) for reuse across the app:

- User can pan/zoom to select a square region
- Client sends the pre-cropped image to the API
- Server still processes (resize, optimize, convert to JPEG) regardless of client crop
- API consumers that skip the frontend crop still get a valid square avatar via centre-crop on the server

### Size Limits

```bash
MAX_FILE_SIZE_MB=5  # Default: 5 MB
```

Size and type validation schemas are available in `lib/validations/storage.ts` for consistent validation across the app. The `lib/storage/constants.ts` file exports client-safe constants (`SUPPORTED_IMAGE_TYPES`, `IMAGE_EXTENSIONS`) that can be imported in both server and client components.

> **Deprecation:** File size utilities (`DEFAULT_MAX_FILE_SIZE`, `getMaxFileSize()`) in `lib/storage/upload.ts` are deprecated. Use `MAX_FILE_SIZE_BYTES` and `getMaxFileSizeBytes()` from `lib/validations/storage.ts` instead for Zod-based validation.

### Validation Schemas

Use Zod schemas from `lib/validations/storage.ts` for type-safe validation:

```typescript
import { avatarUploadSchema, imageFileSchema } from '@/lib/validations/storage';

// Validate file metadata before upload
const result = avatarUploadSchema.safeParse({
  file: { name: file.name, size: file.size, type: file.type },
});

if (!result.success) {
  return errorResponse(result.error.errors[0].message, { status: 400 });
}

// Available schemas:
// - fileMetadataSchema: Basic file validation (name, size, type)
// - imageFileSchema: Extends fileMetadataSchema with image MIME type check
// - avatarUploadSchema: Full avatar validation with size limit
// - s3ConfigSchema, vercelBlobConfigSchema: Provider config validation
```

## Usage

### Server-Side (API Routes)

```typescript
import { uploadAvatar, deleteAvatar, deleteByPrefix, isStorageEnabled } from '@/lib/storage/upload';
import { getStorageProviderName } from '@/lib/storage/client';

// Check if storage is available
if (!isStorageEnabled()) {
  return errorResponse('Storage not configured', { status: 503 });
}

// Get current provider name ('s3', 'vercel-blob', 'local', or null)
const provider = getStorageProviderName();

// Upload avatar
const result = await uploadAvatar(buffer, { userId: 'user-123' });
console.log(result.url); // Public URL

// Delete avatar by URL (convenience wrapper that handles URL parsing)
await deleteAvatar(user.image);

// Delete all files under a user's avatar prefix
await deleteByPrefix(`avatars/${userId}/`);
```

### Client-Side (React)

```tsx
import { AvatarUpload } from '@/components/forms/avatar-upload';

<AvatarUpload currentAvatar={user.image} userName={user.name} initials="JD" />;
```

### Direct Provider Access

```typescript
import { getStorageClient } from '@/lib/storage/client';

const storage = getStorageClient();
if (storage) {
  // Upload any file
  const result = await storage.upload(buffer, {
    key: 'documents/report.pdf',
    contentType: 'application/pdf',
  });

  // Delete file
  await storage.delete('documents/report.pdf');

  // Delete all files with prefix
  await storage.deletePrefix('avatars/user-123/');
}
```

> **Note:** Direct provider access bypasses magic byte validation and image processing. Use `uploadAvatar()` or call `validateImageMagicBytes()` and `processImage()` manually if uploading user-provided images.

## Error Codes

| Code                     | Description                   |
| ------------------------ | ----------------------------- |
| `FILE_TOO_LARGE`         | File exceeds MAX_FILE_SIZE_MB |
| `INVALID_FILE_TYPE`      | Not a supported image format  |
| `UPLOAD_FAILED`          | Storage provider error        |
| `STORAGE_NOT_CONFIGURED` | No storage provider available |

> **Note:** These are API response error codes returned in the `error.code` field. The storage library throws plain `Error` objects with descriptive messages internally.

## Security

### Key Validation

All storage keys are validated before use with `validateStorageKey()`. This validation is called by **all providers** (S3, Vercel Blob, Local) before `upload`, `delete`, and `deletePrefix` operations to prevent path traversal attacks.

```typescript
import { validateStorageKey } from '@/lib/storage/providers/validate-key';

// Called automatically by all providers before upload/delete/deletePrefix operations
validateStorageKey(key); // Throws if invalid
```

**Prevents:**

- Path traversal attacks (`..` in key)
- Absolute path injection (`/etc/passwd`)
- Null byte injection (`file\0.jpg`)
- Backslash attacks (`uploads\..\..\etc`)

**What it does not prevent, and who covers the gap:** `validateStorageKey('.')` passes every rule above, and on the local provider `resolve(root, '.')` is the storage root. Handed to `deletePrefix()` that recursively deleted everything the provider held; handed to `upload()` with the root absent it created a directory _outside_ the root and wrote a regular file at the root path, breaking every later upload with `ENOTDIR`. `resolveWithin()` therefore rejects a key resolving to the root, which covers **all four** local operations — `upload`, `delete`, `deletePrefix`, `download` — not just the destructive one (#508). The object-store providers are unaffected: an S3 or Vercel Blob prefix of `.` is a literal string match, not a path. **A new caller passing a caller-supplied key or prefix is the case to watch** — today the keys are `avatars/${userId}/…` and `${keyPrefix}${randomUUID()}${ext}`.

### File Validation

1. **Magic bytes**: Server-side MIME type verification (not trusting client)
2. **Size limit**: Enforced before processing
3. **Format whitelist**: Only JPEG, PNG, WebP, GIF

### Access Control

- Only authenticated users can upload
- Users can only modify their own avatar
- Storage keys are scoped per user to prevent enumeration
- Private objects are read only through a signed, single-key, time-limited token — never a session. See [Signed Object Read](#signed-object-read) for why a session check would be strictly worse here.

### Avatar Cleanup on User Deletion

When a user is deleted (self-delete or admin), their `avatars/{userId}/` prefix is deleted from storage using `deleteByPrefix` to remove all files under that path.

### Storage Keys

Avatars use a fixed key pattern: `avatars/{userId}/avatar.jpg`

This means each upload overwrites the previous avatar instead of creating orphan files. Benefits:

- No orphan cleanup needed
- Predictable key for deletion
- Simpler storage management

## Testing

### Mock Storage

```typescript
import { resetStorageClient } from '@/lib/storage/client';

beforeEach(() => {
  // Reset singleton between tests
  resetStorageClient();
});

// Set env vars for testing
process.env.STORAGE_PROVIDER = 'local';
```

### Test Helpers

```typescript
// Test image validation
import { validateImageMagicBytes } from '@/lib/storage/image';

const result = validateImageMagicBytes(buffer);
expect(result.valid).toBe(true);
expect(result.detectedType).toBe('image/jpeg');
```

### Image Utilities

```typescript
import { getExtensionForMimeType, isSupportedImageType } from '@/lib/storage/image';

// Get file extension for a MIME type
getExtensionForMimeType('image/jpeg'); // 'jpg'
getExtensionForMimeType('image/png'); // 'png'
getExtensionForMimeType('image/webp'); // 'webp'
getExtensionForMimeType('image/gif'); // 'gif'

// Check if a content type is supported
isSupportedImageType('image/jpeg'); // true
isSupportedImageType('image/svg+xml'); // false
```

## Extending

### Adding a New Provider

1. Create provider in `lib/storage/providers/`:

```typescript
// lib/storage/providers/cloudinary.ts
import type {
  StorageProvider,
  StorageCapabilities,
  UploadOptions,
  UploadResult,
  DeleteResult,
} from '@/lib/storage/providers/types';

export class CloudinaryProvider implements StorageProvider {
  readonly name = 'cloudinary';

  // Optional. Anything you leave out is assumed unsupported, so a provider
  // that omits this entirely is treated as public-only with no read path —
  // safe, but it means callers will refuse private uploads.
  readonly capabilities: Partial<StorageCapabilities> = {
    privateObjects: true,
    signedUrls: true,
  };

  async upload(file: Buffer, options: UploadOptions): Promise<UploadResult> {
    // Implementation
  }

  async delete(key: string): Promise<DeleteResult> {
    // Implementation
  }
}

export function createCloudinaryProviderFromEnv(): CloudinaryProvider | null {
  // Check env vars and create provider
}
```

2. Register in `lib/storage/client.ts`:

```typescript
import { createCloudinaryProviderFromEnv } from './providers/cloudinary';

// In createProvider function:
case 'cloudinary':
  return createCloudinaryProviderFromEnv();

// In auto-detection:
const cloudinaryProvider = createCloudinaryProviderFromEnv();
if (cloudinaryProvider) return cloudinaryProvider;
```

3. Add to provider type:

```typescript
// lib/storage/providers/types.ts
export type StorageProviderType = 's3' | 'vercel-blob' | 'local' | 'cloudinary';
```

## Troubleshooting

### "Storage not configured"

- Development: Should auto-fallback to local
- Production: Set `STORAGE_PROVIDER` and credentials

### S3 Access Denied

- Check bucket permissions (public-read ACL for avatars)
- Verify access key has PutObject, DeleteObject permissions
- For S3-compatible: ensure endpoint is correct

### Large Files Fail

- Check `MAX_FILE_SIZE_MB` setting
- Verify server has enough memory for image processing
- Check storage provider upload limits

### Images Not Displaying

- Verify URL is publicly accessible
- Check CORS settings on storage bucket
- For local: ensure `public/uploads/` exists and is served
