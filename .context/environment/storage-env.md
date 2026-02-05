# Storage Environment Variables

Configuration for file storage providers (S3, Vercel Blob, local).

> **Validation Note:** Storage variables use **graceful degradation** rather than fail-fast validation. They are not included in the `lib/env.ts` Zod schema and are accessed directly from `process.env` in storage modules. Invalid or missing values are handled at runtime, not caught at startup. This allows storage to be fully optional—the system falls back to local filesystem if no provider credentials are configured.

## Provider Selection

### Auto-Detection Behavior

When `STORAGE_PROVIDER` is not set, the system auto-detects:

1. **S3 credentials present** (`S3_BUCKET` + `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`) → Uses S3
2. **Vercel Blob token present** (`BLOB_READ_WRITE_TOKEN`) → Uses Vercel Blob
3. **No credentials** → Falls back to local filesystem (`public/uploads/`)

**Important:** Local filesystem is NOT suitable for production (files don't persist across deploys).

### `STORAGE_PROVIDER`

- **Purpose:** Explicitly select the file storage provider
- **Required:** ❌ No
- **Type:** Enum (`s3` | `vercel-blob` | `local`)
- **Default:** Auto-detect from available credentials

**Examples:**

```bash
# Explicitly use S3
STORAGE_PROVIDER="s3"

# Explicitly use Vercel Blob
STORAGE_PROVIDER="vercel-blob"

# Explicitly use local filesystem (development only)
STORAGE_PROVIDER="local"
```

### `MAX_FILE_SIZE_MB`

- **Purpose:** Maximum allowed file upload size in megabytes
- **Required:** ❌ No
- **Type:** Number
- **Default:** `5` (application-level default, not schema-validated)

**Examples:**

```bash
MAX_FILE_SIZE_MB=5   # Default: 5MB limit
MAX_FILE_SIZE_MB=25  # Larger uploads (documents)
MAX_FILE_SIZE_MB=2   # Restrict to small files (avatars)
```

**Platform Limits:**

- Vercel Hobby: 4.5MB request body limit
- Vercel Pro: Configurable

## S3 / S3-Compatible Storage

Works with AWS S3, MinIO, DigitalOcean Spaces, Cloudflare R2.

### `S3_BUCKET`

- **Purpose:** Name of the S3 bucket for file storage
- **Required:** ⚠️ Conditionally (required when using S3)
- **Type:** String (lowercase, no spaces, 3-63 characters)

**Examples:**

```bash
S3_BUCKET="my-app-uploads"        # AWS S3
S3_BUCKET="my-space-name"         # DigitalOcean Spaces
S3_BUCKET="local-uploads"         # MinIO
```

### `S3_ACCESS_KEY_ID`

- **Purpose:** AWS access key ID (or equivalent)
- **Required:** ⚠️ Conditionally (required when using S3)
- **Type:** String

**Examples:**

```bash
S3_ACCESS_KEY_ID="AKIAIOSFODNN7EXAMPLE"    # AWS
S3_ACCESS_KEY_ID="minioadmin"               # MinIO
S3_ACCESS_KEY_ID="DO00EXAMPLE1234567890"   # DigitalOcean
```

### `S3_SECRET_ACCESS_KEY`

- **Purpose:** AWS secret access key (or equivalent)
- **Required:** ⚠️ Conditionally (required when using S3)
- **Type:** String

**Example:**

```bash
S3_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
```

**Security Notes:**

- ⚠️ **Never commit to version control**
- ⚠️ **Use IAM roles in production** when possible
- ⚠️ **Rotate regularly**
- ⚠️ **Use least-privilege IAM policies**

### `S3_REGION`

- **Purpose:** AWS region for the S3 bucket
- **Required:** ❌ No
- **Type:** String
- **Default:** `us-east-1` (application-level default, not schema-validated)

**Examples:**

```bash
S3_REGION="us-east-1"      # AWS
S3_REGION="nyc3"           # DigitalOcean Spaces
S3_REGION="auto"           # Cloudflare R2
```

**Common Regions:**

| Provider      | Region Examples                            |
| ------------- | ------------------------------------------ |
| AWS           | `us-east-1`, `eu-west-1`, `ap-southeast-1` |
| DigitalOcean  | `nyc3`, `ams3`, `sgp1`, `sfo3`             |
| Cloudflare R2 | `auto`                                     |
| MinIO         | Any (not used for routing)                 |

### `S3_ENDPOINT`

- **Purpose:** Custom endpoint URL for S3-compatible services
- **Required:** ❌ No (only for non-AWS)
- **Type:** URL
- **Default:** AWS S3 default endpoint

**Examples:**

```bash
# DigitalOcean Spaces
S3_ENDPOINT="https://nyc3.digitaloceanspaces.com"

# Cloudflare R2
S3_ENDPOINT="https://[account-id].r2.cloudflarestorage.com"

# MinIO (local)
S3_ENDPOINT="http://localhost:9000"

# AWS S3 (leave unset)
# S3_ENDPOINT=
```

### `S3_PUBLIC_URL_BASE`

- **Purpose:** Custom base URL for public file URLs (CDN domain)
- **Required:** ❌ No
- **Type:** URL (no trailing slash)
- **Default:** Standard S3 URL format

**Examples:**

```bash
# CloudFront CDN
S3_PUBLIC_URL_BASE="https://d1234567890.cloudfront.net"

# Custom domain
S3_PUBLIC_URL_BASE="https://cdn.example.com"

# DigitalOcean Spaces CDN
S3_PUBLIC_URL_BASE="https://my-space.nyc3.cdn.digitaloceanspaces.com"
```

### `S3_USE_ACL`

- **Purpose:** Enable ACL headers on S3 uploads
- **Required:** ❌ No
- **Type:** Boolean
- **Default:** `false`

**Examples:**

```bash
# Modern buckets (recommended): ACL disabled
S3_USE_ACL=false

# Legacy buckets: Enable ACL
S3_USE_ACL=true
```

**Important:**

- Most modern S3 buckets have ACLs disabled by default (AWS since April 2023)
- Use bucket policies instead of ACLs (recommended)
- Only enable for legacy buckets or DigitalOcean Spaces

## Vercel Blob Storage

### `BLOB_READ_WRITE_TOKEN`

- **Purpose:** Authentication token for Vercel Blob storage
- **Required:** ⚠️ Conditionally (required when using Vercel Blob)
- **Type:** String (starts with `vercel_blob_rw_`)

**Example:**

```bash
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_abc123def456..."
```

**How to Obtain:**

1. Go to Vercel project dashboard
2. Navigate to **Storage** tab
3. Click **Create Database** → **Blob**
4. Go to store settings
5. Copy the **Read-Write Token**

**Important Notes:**

- ⚠️ Automatically available in Vercel deployments
- ⚠️ Must be manually set for local development
- ⚠️ Never commit to version control

## Provider Comparison

| Feature                 | S3          | Vercel Blob          | Local |
| ----------------------- | ----------- | -------------------- | ----- |
| Production Ready        | ✅          | ✅                   | ❌    |
| Persists Across Deploys | ✅          | ✅                   | ❌    |
| CDN Support             | ✅          | ✅                   | ❌    |
| Setup Complexity        | Medium      | Low                  | None  |
| Cost                    | Pay per use | Included with Vercel | Free  |

## Environment-Specific Configuration

### Development (Local)

```bash
# Option 1: Local filesystem (simplest)
STORAGE_PROVIDER="local"

# Option 2: MinIO (S3-compatible, local)
STORAGE_PROVIDER="s3"
S3_BUCKET="sunrise-uploads"
S3_ACCESS_KEY_ID="minioadmin"
S3_SECRET_ACCESS_KEY="minioadmin"
S3_ENDPOINT="http://localhost:9000"
```

### Production

```bash
# Option A: AWS S3
S3_BUCKET="my-app-uploads-prod"
S3_ACCESS_KEY_ID="[from-secret-manager]"
S3_SECRET_ACCESS_KEY="[from-secret-manager]"
S3_REGION="us-east-1"
S3_PUBLIC_URL_BASE="https://cdn.example.com"

# Option B: Vercel Blob
BLOB_READ_WRITE_TOKEN="[auto-set-by-vercel]"
```

### Docker

```bash
# MinIO in Docker
S3_BUCKET="sunrise-uploads"
S3_ACCESS_KEY_ID="minioadmin"
S3_SECRET_ACCESS_KEY="minioadmin"
S3_ENDPOINT="http://minio:9000"  # Docker service name
```

## Troubleshooting

**"Invalid token" error (Vercel Blob):**

- Verify token starts with `vercel_blob_rw_`
- Copy token from Vercel dashboard

**Upload fails with 403 (S3):**

- Check IAM permissions
- Verify bucket policy
- Check if ACLs are required (`S3_USE_ACL=true`)

**Files not accessible:**

- Check bucket public access settings
- Verify `S3_PUBLIC_URL_BASE` if using CDN

## Related Documentation

- [Environment Overview](./overview.md) - Quick setup guide
- [Environment Reference](./reference.md) - All environment variables
- [Storage Overview](../storage/overview.md) - Storage system documentation
