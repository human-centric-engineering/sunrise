# Environment Variable Reference

Complete reference for all environment variables used in Sunrise. This document provides detailed information about each variable, including requirements, formats, and usage examples.

## Quick Reference Table

| Variable | Required | Type | Default | Phase | Description |
|----------|----------|------|---------|-------|-------------|
| [`DATABASE_URL`](#database_url) | ✅ Yes | URL | - | 1.3 | PostgreSQL connection string |
| [`BETTER_AUTH_URL`](#better_auth_url) | ✅ Yes | URL | - | 1.4 | Application base URL |
| [`BETTER_AUTH_SECRET`](#better_auth_secret) | ✅ Yes | String (32+) | - | 1.4 | JWT signing secret |
| [`GOOGLE_CLIENT_ID`](#google_client_id) | ❌ No | String | - | 1.4 | Google OAuth client ID |
| [`GOOGLE_CLIENT_SECRET`](#google_client_secret) | ❌ No | String | - | 1.4 | Google OAuth secret |
| [`RESEND_API_KEY`](#resend_api_key) | ❌ No | String | - | 3.1 | Resend email API key |
| [`EMAIL_FROM`](#email_from) | ❌ No | Email | - | 3.1 | Sender email address |
| [`NODE_ENV`](#node_env) | ✅ Yes | Enum | `development` | 1.1 | Environment name |
| [`NEXT_PUBLIC_APP_URL`](#next_public_app_url) | ✅ Yes | URL | - | 1.4 | Public app URL (client-side) |

## Detailed Descriptions

### Database

#### `DATABASE_URL`

- **Purpose:** PostgreSQL database connection string for Prisma ORM
- **Required:** ✅ Yes
- **Type:** URL (PostgreSQL format)
- **Format:** `postgresql://[user]:[password]@[host]:[port]/[database]?[params]`
- **Validation:** Must be a valid PostgreSQL connection string URL
- **Used By:**
  - `lib/db/client.ts` - Prisma client initialization
  - `prisma/schema.prisma` - Database migrations
- **Phase:** 1.3 (Database Layer)

**Examples:**

Local development:
```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/sunrise_db"
```

Docker Compose (use service name):
```bash
DATABASE_URL="postgresql://postgres:password@db:5432/sunrise_db"
```

Production (with SSL):
```bash
DATABASE_URL="postgresql://user:pass@prod-db.example.com:5432/sunrise?sslmode=require"
```

**Common Parameters:**
- `sslmode=require` - Enforce SSL connection (recommended for production)
- `sslmode=disable` - Disable SSL (local development only)
- `schema=public` - Use specific schema (default: public)
- `connection_limit=10` - Max connections in pool

**Troubleshooting:**
- Ensure PostgreSQL is running: `pg_isready`
- Test connection: `psql $DATABASE_URL`
- Verify database exists: `psql -l`
- Check firewall rules if connecting to remote database

---

### Authentication

#### `BETTER_AUTH_URL`

- **Purpose:** Base URL of the application for better-auth OAuth redirects and session management
- **Required:** ✅ Yes
- **Type:** URL
- **Format:** `http://` or `https://` followed by domain and optional port
- **Validation:** Must be a valid HTTP/HTTPS URL
- **Used By:**
  - `lib/auth/config.ts` - better-auth server configuration
  - OAuth redirect URI calculation
  - Session cookie domain
- **Phase:** 1.4 (Authentication System)

**Examples:**

Local development:
```bash
BETTER_AUTH_URL="http://localhost:3000"
```

Production:
```bash
BETTER_AUTH_URL="https://app.example.com"
```

Custom port:
```bash
BETTER_AUTH_URL="http://localhost:3001"
```

**Important Notes:**
- Must match the actual URL where your application is accessible
- Must match `NEXT_PUBLIC_APP_URL` for consistency
- Include port number if not using default (80/443)
- Use `https://` in production
- Used for OAuth redirect URIs: `{BETTER_AUTH_URL}/api/auth/callback/[provider]`

**Troubleshooting:**
- OAuth fails: Ensure URL matches OAuth provider configuration
- Session issues: Verify URL matches where app is accessed
- CORS errors: Check URL includes correct protocol (http vs https)

#### `BETTER_AUTH_SECRET`

- **Purpose:** Secret key for signing JWT tokens and securing sessions
- **Required:** ✅ Yes
- **Type:** String (minimum 32 characters)
- **Format:** Base64-encoded random string (recommended)
- **Validation:** Must be at least 32 characters
- **Used By:**
  - `lib/auth/config.ts` - JWT signing and verification
  - Session encryption
- **Phase:** 1.4 (Authentication System)

**Generating a Secret:**

```bash
# Recommended: 32 bytes encoded in base64 (44 characters)
openssl rand -base64 32

# Alternative: 64 bytes for extra security
openssl rand -base64 64
```

**Example:**

```bash
BETTER_AUTH_SECRET="Ag8JfK3mN9pQr2StUv4WxY5zB7cD0eF1Gh2Ij3Kl4M="
```

**Important Security Notes:**
- ⚠️ **Never commit this to version control**
- ⚠️ **Use different secrets for each environment** (dev, staging, production)
- ⚠️ **Rotate quarterly or after suspected compromise**
- ⚠️ **Minimum 32 characters** (44 characters recommended from base64 encoding)
- ⚠️ **Store securely** in production secret management (Vercel, AWS Secrets Manager, etc.)

**Troubleshooting:**
- "Must be at least 32 characters" error: Generate a longer secret with `openssl rand -base64 32`
- Sessions invalidated after restart: This is expected in development; production should use persistent secret
- Authentication fails: Verify secret hasn't been changed between server restarts

#### `GOOGLE_CLIENT_ID`

- **Purpose:** Google OAuth 2.0 client ID for Google sign-in
- **Required:** ❌ No (Google OAuth disabled if not provided)
- **Type:** String
- **Format:** Google-issued client ID (ends with `.apps.googleusercontent.com`)
- **Validation:** None (optional)
- **Used By:**
  - `lib/auth/config.ts` - Google OAuth provider configuration
- **Phase:** 1.4 (Authentication System)

**Example:**

```bash
GOOGLE_CLIENT_ID="123456789-abc123def456.apps.googleusercontent.com"
```

**Setup:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable "Google+ API"
4. Create OAuth 2.0 credentials
5. Configure authorized redirect URIs:
   - Local: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://yourdomain.com/api/auth/callback/google`

**Important Notes:**
- Both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must be set to enable Google OAuth
- If only one is set, Google OAuth will be disabled
- Client ID is not sensitive and can be exposed in client-side code

#### `GOOGLE_CLIENT_SECRET`

- **Purpose:** Google OAuth 2.0 client secret for secure token exchange
- **Required:** ❌ No (Google OAuth disabled if not provided)
- **Type:** String
- **Format:** Google-issued client secret
- **Validation:** None (optional)
- **Used By:**
  - `lib/auth/config.ts` - Google OAuth provider configuration
- **Phase:** 1.4 (Authentication System)

**Example:**

```bash
GOOGLE_CLIENT_SECRET="GOCSPX-abcdefghijklmnopqrstuvwxyz"
```

**Setup:**
Same as `GOOGLE_CLIENT_ID` - both are provided when creating OAuth credentials in Google Cloud Console.

**Important Security Notes:**
- ⚠️ **Keep this secret** - never expose in client-side code or version control
- ⚠️ **Server-only** - only used in backend OAuth flow
- ⚠️ **Rotate if compromised** - generate new credentials in Google Cloud Console

---

### Email

#### `RESEND_API_KEY`

- **Purpose:** API key for Resend email service
- **Required:** ❌ No (Phase 1), ✅ Yes (Phase 3)
- **Type:** String
- **Format:** Resend-issued API key (starts with `re_`)
- **Validation:** None (optional in Phase 1)
- **Used By:**
  - `lib/email/client.ts` - Resend client initialization (Phase 3)
  - Email sending functionality (Phase 3)
- **Phase:** 3.1 (Email System)

**Example:**

```bash
RESEND_API_KEY="re_123456789_abcdefghijklmnopqrstuvwxyz"
```

**Setup:**
1. Create account at [resend.com](https://resend.com)
2. Verify your sending domain
3. Generate API key in dashboard
4. Use test mode for development (free)

**Important Notes:**
- Optional during Phase 1 and Phase 2 development
- Required in Phase 3 when email functionality is implemented
- Different keys for development and production recommended
- Free tier available for testing

**Test Mode:**
In development, Resend provides a test mode that doesn't actually send emails but returns success responses.

#### `EMAIL_FROM`

- **Purpose:** Sender email address for all transactional emails
- **Required:** ❌ No (Phase 1), ✅ Yes (Phase 3)
- **Type:** Email address
- **Format:** `name@domain.com` or `Name <name@domain.com>`
- **Validation:** Must be a valid email address
- **Used By:**
  - `lib/email/send.ts` - Email sending utilities (Phase 3)
  - All email templates (Phase 3)
- **Phase:** 3.1 (Email System)

**Examples:**

Simple format:
```bash
EMAIL_FROM="noreply@example.com"
```

With display name:
```bash
EMAIL_FROM="Sunrise App <noreply@example.com>"
```

**Important Notes:**
- Domain must be verified in Resend dashboard
- Use `noreply@` for transactional emails
- Display name is optional but recommended for better UX
- Must match verified sending domain in Resend

**Recommended Patterns:**
- Transactional emails: `noreply@yourdomain.com`
- Support emails: `support@yourdomain.com`
- Notifications: `notifications@yourdomain.com`

---

### Application Configuration

#### `NODE_ENV`

- **Purpose:** Indicates the current environment (development, production, or test)
- **Required:** ✅ Yes
- **Type:** Enum (`development` | `production` | `test`)
- **Default:** `development`
- **Validation:** Must be one of the three allowed values
- **Used By:**
  - `lib/db/client.ts` - Logging configuration
  - `lib/api/errors.ts` - Error detail exposure
  - Next.js internal optimizations
- **Phase:** 1.1 (Project Initialization)

**Examples:**

Development:
```bash
NODE_ENV="development"
```

Production:
```bash
NODE_ENV="production"
```

Testing:
```bash
NODE_ENV="test"
```

**Behavior by Environment:**

**Development:**
- Verbose logging enabled
- Detailed error messages with stack traces
- Database query logging enabled
- Hot module reloading
- React development warnings

**Production:**
- Minimal logging (errors only)
- Sanitized error messages (no sensitive details exposed)
- Database query logging disabled
- Optimized bundles
- No development warnings

**Test:**
- Used by test runners (Vitest, Jest)
- Minimal logging
- Test-specific configurations

**Important Notes:**
- Automatically set by Next.js in most cases
- `next dev` sets `NODE_ENV=development`
- `next build` and `next start` set `NODE_ENV=production`
- Explicitly set in test scripts: `NODE_ENV=test vitest`

#### `NEXT_PUBLIC_APP_URL`

- **Purpose:** Public-facing application URL, accessible in client-side code
- **Required:** ✅ Yes
- **Type:** URL
- **Format:** `http://` or `https://` followed by domain and optional port
- **Validation:** Must be a valid HTTP/HTTPS URL
- **Used By:**
  - `lib/auth/client.ts` - Client-side authentication library
  - Client components that need to know the app URL
  - API calls from browser
- **Phase:** 1.4 (Authentication System)

**Examples:**

Local development:
```bash
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

Production:
```bash
NEXT_PUBLIC_APP_URL="https://app.example.com"
```

**Important Notes:**
- ⚠️ **Embedded at build time** - must rebuild after changing
- ⚠️ **Visible in browser** - accessible in client-side JavaScript
- ⚠️ **Should match `BETTER_AUTH_URL`** for consistency
- ⚠️ **Don't use for secrets** - this is public information

**When to Use:**
- ✅ Constructing API URLs in client components
- ✅ OAuth redirect URI construction
- ✅ Sharing links with users
- ✅ Metadata (OpenGraph, structured data)

**When NOT to Use:**
- ❌ Don't use for API keys or secrets
- ❌ Don't use for server-only configuration
- ❌ Don't use for database connection strings

**Troubleshooting:**
- Changes not taking effect: Restart dev server or rebuild (`npm run build`)
- Undefined in browser: Ensure variable starts with `NEXT_PUBLIC_`
- Wrong URL shown: Verify build-time value matches runtime environment

---

## Environment-Specific Values

### Development (Local)

```bash
# .env.local (for local development)
DATABASE_URL="postgresql://postgres:password@localhost:5432/sunrise_db"
BETTER_AUTH_URL="http://localhost:3000"
BETTER_AUTH_SECRET="dev-secret-at-least-32-characters-long"
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
RESEND_API_KEY=""
EMAIL_FROM=""
NODE_ENV="development"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

**Notes:**
- Use simple passwords for local database
- OAuth and email can be left empty during early development
- `BETTER_AUTH_SECRET` can be simple but still must be 32+ characters

### Production

```bash
# Production environment (set in deployment platform)
DATABASE_URL="postgresql://user:pass@prod-db.example.com:5432/sunrise?sslmode=require"
BETTER_AUTH_URL="https://app.example.com"
BETTER_AUTH_SECRET="[strong-secret-from-secret-manager]"
GOOGLE_CLIENT_ID="[production-client-id]"
GOOGLE_CLIENT_SECRET="[production-client-secret]"
RESEND_API_KEY="[production-api-key]"
EMAIL_FROM="noreply@example.com"
NODE_ENV="production"
NEXT_PUBLIC_APP_URL="https://app.example.com"
```

**Important Production Changes:**
- ✅ Use SSL for database (`sslmode=require`)
- ✅ Use HTTPS URLs only
- ✅ Strong, unique secrets from secret manager
- ✅ Production OAuth credentials with correct redirect URIs
- ✅ Verified email sending domain
- ✅ Different `BETTER_AUTH_SECRET` from development

### Docker

When running in Docker Compose, some values change:

```bash
# docker-compose.yml environment section
DATABASE_URL="postgresql://postgres:password@db:5432/sunrise_db"
#                                         ^^^ service name, not localhost
BETTER_AUTH_URL="http://localhost:3000"  # Still localhost from host perspective
BETTER_AUTH_SECRET="docker-secret-at-least-32-characters"
NODE_ENV="development"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

**Key Differences:**
- Database host is `db` (Docker service name) instead of `localhost`
- App URLs remain `localhost` because they're accessed from host machine
- Network is isolated within Docker Compose network

---

## Security Best Practices

### Secret Storage

**Development:**
- Store in `.env.local` (gitignored)
- Simple secrets OK for local dev
- Can share dev secrets with team via secure channel

**Production:**
- Use secret management service:
  - **Vercel:** Environment Variables UI
  - **AWS:** Secrets Manager or Systems Manager Parameter Store
  - **Render:** Environment Variables (encrypted at rest)
  - **Railway:** Environment Variables (encrypted)
  - **Self-hosted:** HashiCorp Vault, Kubernetes Secrets
- Never hardcode in deployment scripts
- Rotate secrets quarterly
- Audit access logs

### Secret Rotation

When rotating secrets in production:

1. Generate new secret value
2. Update in secret manager
3. Deploy with new secret
4. Monitor for issues
5. Invalidate old secret after successful deployment

For zero-downtime rotation:
1. Add new secret alongside old (if system supports dual secrets)
2. Deploy with both active
3. Monitor usage
4. Remove old secret after traffic shifted

### Access Control

- ⚠️ Limit who can view production secrets
- ⚠️ Use separate secrets per environment
- ⚠️ Use role-based access control (RBAC) in secret manager
- ⚠️ Enable audit logging for secret access
- ⚠️ Require MFA for viewing production secrets

---

## Validation Schema

The complete validation schema is defined in `lib/env.ts`:

```typescript
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: '...' }),
  BETTER_AUTH_URL: z.string().url({ message: '...' }),
  BETTER_AUTH_SECRET: z.string().min(32, { message: '...' }),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_PUBLIC_APP_URL: z.string().url({ message: '...' }),
})
```

**Validation happens at:**
- Application startup (server initialization)
- Module load time (when `lib/env.ts` is imported)
- Before any environment variables are used

**Validation ensures:**
- Required variables exist
- URLs are properly formatted
- Strings meet minimum length requirements
- Enums have valid values
- Email addresses are valid format

### ⚠️ Server-Side Only Module

**CRITICAL:** The `lib/env.ts` module validates server-only environment variables and should **NEVER** be imported in client-side code.

**✅ Safe to import `env`:**
- Server components (no `'use client'` directive)
- API routes (`app/api/**/route.ts`)
- Server actions (`'use server'`)
- Middleware (`middleware.ts`)
- Server utilities (`lib/db`, `lib/auth/config.ts`, etc.)

**❌ DO NOT import `env` in:**
- Client components (`'use client'`)
- Client-side utilities (e.g., `lib/auth/client.ts`)
- Browser-only code

**Why?** The validation checks for server variables like `DATABASE_URL` and `BETTER_AUTH_SECRET` that don't exist in the browser. Importing `lib/env.ts` in client code will cause validation errors.

**For client-side code, use `process.env` directly:**

```typescript
'use client'

export function ClientComponent() {
  // ✅ Correct: Access NEXT_PUBLIC_* directly
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  // ❌ Wrong: Don't import env in client code
  // import { env } from '@/lib/env' // This causes errors!
}
```

**Example of correct usage:**

```typescript
// ✅ Server component - import env
import { env } from '@/lib/env'

export default async function Dashboard() {
  const dbUrl = env.DATABASE_URL // Type-safe, validated
  // ...
}

// ✅ Client component - use process.env
'use client'

export function LoginButton() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  // ...
}
```

---

## Adding New Variables

To add a new environment variable:

### 1. Update `lib/env.ts`

Add to the Zod schema:

```typescript
const envSchema = z.object({
  // ... existing variables

  NEW_API_KEY: z.string().min(10, {
    message: 'NEW_API_KEY must be at least 10 characters'
  }),
})
```

### 2. Update `.env.example`

Add with description:

```bash
# New Service Configuration
NEW_API_KEY="your-api-key-here"  # Get from newservice.com/dashboard
```

### 3. Update Documentation

Add entry to this reference document:
- Quick reference table
- Detailed description section
- Examples
- Setup instructions

### 4. Update `.context/environment/overview.md`

If the variable affects setup or has special considerations, document in the overview guide.

---

## Migration from `process.env`

### Server-Side Code Migration

If you find direct `process.env` usage in **server-side code** (server components, API routes, server utilities):

**Before:**
```typescript
// Server component or API route
const secret = process.env.BETTER_AUTH_SECRET || 'fallback'
```

**After:**
```typescript
// Server component or API route
import { env } from '@/lib/env'

const secret = env.BETTER_AUTH_SECRET // No fallback needed, validated
```

**Benefits:**
- Type safety (no `| undefined`)
- Validation (fails at startup, not runtime)
- Autocomplete in IDE
- No need for fallback values

### Client-Side Code (No Migration Needed)

**For client-side code (client components), continue using `process.env` directly:**

```typescript
'use client'

export function ClientComponent() {
  // ✅ Correct: Keep using process.env for client code
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  // ❌ Don't migrate to env import in client code
}
```

**Why?** Client components can only access `NEXT_PUBLIC_*` variables, and importing `lib/env.ts` in client code will cause validation errors for server-only variables.

---

## Related Documentation

- **[Environment Overview](./overview.md)** - Setup guide, patterns, and troubleshooting
- **[Database Schema](./../database/schema.md)** - Database configuration and Prisma setup
- **[Authentication System](./../auth/overview.md)** - better-auth configuration and flows
- **[API Documentation](./../api/endpoints.md)** - API endpoint patterns
- **[Deployment Guide](./../../.instructions/DEPLOYMENT.md)** - Platform-specific deployment instructions
