# Environment Variable Reference

Complete reference for all environment variables used in Sunrise.

## Detailed Documentation by Category

| Category       | File                                 | Variables                                                                         |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| Database       | [database-env.md](./database-env.md) | `DATABASE_URL`                                                                    |
| Authentication | [auth-env.md](./auth-env.md)         | `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_*`                               |
| Email          | [email-env.md](./email-env.md)       | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, `CONTACT_EMAIL`                |
| Storage        | [storage-env.md](./storage-env.md)   | `STORAGE_PROVIDER`, `S3_*`, `BLOB_READ_WRITE_TOKEN`, `MAX_FILE_SIZE_MB`           |
| Services       | [services-env.md](./services-env.md) | `NODE_ENV`, `NEXT_PUBLIC_APP_URL`, `LOG_*`, `ALLOWED_ORIGINS`, `COOKIE_CONSENT_*` |

## Quick Reference Table

| Variable                                                  | Required | Type         | Default       | Description                           |
| --------------------------------------------------------- | -------- | ------------ | ------------- | ------------------------------------- |
| [`DATABASE_URL`](./database-env.md)                       | ✅ Yes   | URL          | -             | PostgreSQL connection string          |
| [`BETTER_AUTH_URL`](./auth-env.md)                        | ✅ Yes   | URL          | -             | Application base URL                  |
| [`BETTER_AUTH_SECRET`](./auth-env.md)                     | ✅ Yes   | String (32+) | -             | JWT signing secret                    |
| [`GOOGLE_CLIENT_ID`](./auth-env.md)                       | ❌ No    | String       | -             | Google OAuth client ID                |
| [`GOOGLE_CLIENT_SECRET`](./auth-env.md)                   | ❌ No    | String       | -             | Google OAuth secret                   |
| [`RESEND_API_KEY`](./email-env.md)                        | ❌ No    | String       | -             | Resend email API key                  |
| [`EMAIL_FROM`](./email-env.md)                            | ❌ No    | Email        | -             | Sender email address                  |
| [`EMAIL_FROM_NAME`](./email-env.md)                       | ❌ No    | String       | -             | Sender display name                   |
| [`CONTACT_EMAIL`](./email-env.md)                         | ❌ No    | Email        | `EMAIL_FROM`  | Contact form notifications            |
| [`NODE_ENV`](./services-env.md)                           | ✅ Yes   | Enum         | `development` | Environment name                      |
| [`NEXT_PUBLIC_APP_URL`](./services-env.md)                | ✅ Yes   | URL          | -             | Public app URL (client-side)          |
| [`NEXT_PUBLIC_COOKIE_CONSENT_ENABLED`](./services-env.md) | ❌ No    | Boolean      | `true`        | Enable cookie consent banner          |
| [`LOG_LEVEL`](./services-env.md)                          | ❌ No    | Enum         | Auto          | Minimum log level                     |
| [`LOG_SANITIZE_PII`](./services-env.md)                   | ❌ No    | Boolean      | Auto          | PII sanitization in logs              |
| [`ALLOWED_ORIGINS`](./services-env.md)                    | ❌ No    | String       | -             | CORS allowed origins                  |
| [`STORAGE_PROVIDER`](./storage-env.md) ²                  | ❌ No    | Enum         | Auto-detect   | Storage provider selection            |
| [`MAX_FILE_SIZE_MB`](./storage-env.md) ²                  | ❌ No    | Number       | `5`           | Max upload file size (MB)             |
| [`S3_BUCKET`](./storage-env.md) ²                         | ⚠️ Cond  | String       | -             | S3 bucket name                        |
| [`S3_ACCESS_KEY_ID`](./storage-env.md) ²                  | ⚠️ Cond  | String       | -             | AWS access key ID                     |
| [`S3_SECRET_ACCESS_KEY`](./storage-env.md) ²              | ⚠️ Cond  | String       | -             | AWS secret access key                 |
| [`S3_REGION`](./storage-env.md) ²                         | ❌ No    | String       | `us-east-1`   | AWS region                            |
| [`S3_ENDPOINT`](./storage-env.md) ²                       | ❌ No    | URL          | -             | Custom S3-compatible endpoint         |
| [`S3_PUBLIC_URL_BASE`](./storage-env.md) ²                | ❌ No    | URL          | -             | CDN/domain for public URLs            |
| [`S3_USE_ACL`](./storage-env.md) ²                        | ❌ No    | Boolean      | `false`       | Enable ACL on uploads                 |
| [`BLOB_READ_WRITE_TOKEN`](./storage-env.md) ²             | ⚠️ Cond  | String       | -             | Vercel Blob storage token             |
| `PERF_SLOW_THRESHOLD_MS` ¹                                | ❌ No    | Number       | `1000`        | Threshold for logging slow operations |
| `PERF_CRITICAL_THRESHOLD_MS` ¹                            | ❌ No    | Number       | `5000`        | Threshold for Sentry alerts           |
| `HEALTH_INCLUDE_MEMORY` ¹                                 | ❌ No    | Boolean      | `false`       | Include memory stats in health check  |
| [`NEXT_TELEMETRY_DISABLED`](./services-env.md)            | ❌ No    | Boolean      | -             | Set to 1 to disable Next.js telemetry |

¹ **Not validated at startup.** These variables are accessed directly from `process.env` rather than through the validated `lib/env.ts` schema. Invalid values are handled at runtime.

² **Storage variables use graceful degradation.** Not included in `lib/env.ts` schema. See [storage-env.md](./storage-env.md) for details.

## Environment-Specific Values

### Development

```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/sunrise_db"
BETTER_AUTH_URL="http://localhost:3000"
BETTER_AUTH_SECRET="dev-secret-at-least-32-characters-long"
NODE_ENV="development"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

### Production

```bash
DATABASE_URL="postgresql://user:pass@prod-db.example.com:5432/sunrise?sslmode=require"
BETTER_AUTH_URL="https://app.example.com"
BETTER_AUTH_SECRET="[strong-secret-from-secret-manager]"
NODE_ENV="production"
NEXT_PUBLIC_APP_URL="https://app.example.com"
```

### Docker

```bash
DATABASE_URL="postgresql://postgres:password@db:5432/sunrise_db"
# Note: Use service name 'db' instead of 'localhost'
```

## Validation Schema

Environment variables are validated at startup using Zod in `lib/env.ts`:

```typescript
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});
```

### Server-Side Only

**CRITICAL:** The `lib/env.ts` module validates server-only variables. **Never import it in client-side code.**

✅ **Safe to import:**

- Server components (no `'use client'`)
- API routes (`app/api/**/route.ts`)
- Server actions (`'use server'`)

❌ **DO NOT import in:**

- Client components (`'use client'`)
- Browser-only code

**For client-side code, use `process.env` directly:**

```typescript
'use client';
const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
```

## Adding New Variables

1. **Update `lib/env.ts`** - Add to Zod schema
2. **Update `.env.example`** - Add with description
3. **Update documentation** - Add to relevant category file
4. **Update overview** - If it affects setup

## Security Best Practices

**Development:**

- Store in `.env.local` (gitignored)
- Simple secrets OK for local dev

**Production:**

- Use secret management service (Vercel, AWS Secrets Manager, etc.)
- Never hardcode in deployment scripts
- Rotate secrets quarterly
- Use different secrets per environment

## Related Documentation

- [Environment Overview](./overview.md) - Setup guide and troubleshooting
- [Database Schema](../database/schema.md) - Database configuration
- [Authentication System](../auth/overview.md) - Auth configuration
- [Deployment Guide](../../.instructions/DEPLOYMENT.md) - Platform-specific instructions
