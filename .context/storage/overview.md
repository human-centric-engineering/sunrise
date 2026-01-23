# Storage System

The storage system provides multi-provider file storage for Sunrise, following the same patterns as the email system (singleton client with graceful degradation).

## Architecture

```
lib/storage/
├── client.ts              # getStorageClient(), isStorageEnabled()
├── upload.ts              # uploadAvatar(), deleteFile(), deleteByPrefix()
├── image.ts               # validateImageMagicBytes(), processImage()
└── providers/
    ├── types.ts           # StorageProvider interface
    ├── s3.ts              # AWS S3 / S3-compatible
    ├── vercel-blob.ts     # Vercel Blob Storage
    └── local.ts           # Local filesystem (dev only)
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

## Providers

### S3 Provider

Works with AWS S3 and any S3-compatible service (MinIO, DigitalOcean Spaces, Cloudflare R2).

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
```

> **Note:** Modern S3 buckets (since April 2023) have ACLs disabled by default. Only set `S3_USE_ACL=true` for legacy buckets that use ACL-based access control.

### Vercel Blob Provider

Integrated with Vercel deployments. Simple setup, CDN-backed.

```bash
BLOB_READ_WRITE_TOKEN=vercel_blob_...
```

Get token from: Vercel Dashboard → Storage → Blob

### Local Provider

Development fallback. Files stored in `public/uploads/`.

- No configuration required
- Automatically enabled in development when no cloud provider configured
- **Not for production** - files don't persist across deploys

## API Endpoints

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
3. **Optimize**: Quality compression for web
4. **Format**: Avatars always output JPEG regardless of input format. When using `processImage` directly without specifying a format, the original format is preserved.

Supported formats: JPEG, PNG, WebP, GIF

### Client-Side Crop

The `AvatarUpload` component includes an integrated crop dialog (react-easy-crop):

- User can pan/zoom to select a square region
- Client sends the pre-cropped image to the API
- Server still processes (resize, optimize, convert to JPEG) regardless of client crop
- API consumers that skip the frontend crop still get a valid square avatar via centre-crop on the server

### Size Limits

```bash
MAX_FILE_SIZE_MB=5  # Default: 5 MB
```

## Usage

### Server-Side (API Routes)

```typescript
import { uploadAvatar, deleteByPrefix, isStorageEnabled } from '@/lib/storage/upload';

// Check if storage is available
if (!isStorageEnabled()) {
  return errorResponse('Storage not configured', { status: 503 });
}

// Upload avatar
const result = await uploadAvatar(buffer, { userId: 'user-123' });
console.log(result.url); // Public URL

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

## Error Codes

| Code                     | Description                   |
| ------------------------ | ----------------------------- |
| `FILE_TOO_LARGE`         | File exceeds MAX_FILE_SIZE_MB |
| `INVALID_FILE_TYPE`      | Not a supported image format  |
| `UPLOAD_FAILED`          | Storage provider error        |
| `STORAGE_NOT_CONFIGURED` | No storage provider available |

## Security

### File Validation

1. **Magic bytes**: Server-side MIME type verification (not trusting client)
2. **Size limit**: Enforced before processing
3. **Format whitelist**: Only JPEG, PNG, WebP, GIF

### Access Control

- Only authenticated users can upload
- Users can only modify their own avatar
- Storage keys are scoped per user to prevent enumeration

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

## Extending

### Adding a New Provider

1. Create provider in `lib/storage/providers/`:

```typescript
// lib/storage/providers/cloudinary.ts
import type { StorageProvider, UploadOptions, UploadResult, DeleteResult } from './types';

export class CloudinaryProvider implements StorageProvider {
  readonly name = 'cloudinary';

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
