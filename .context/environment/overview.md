# Environment Configuration

## Overview

Sunrise uses **Zod-validated environment variables** for type-safe configuration management. All environment variables are validated at application startup with fail-fast behavior, ensuring that configuration errors are caught immediately rather than at runtime.

**Key Benefits:**

- ✅ **Type-safe access**: TypeScript knows your environment variables exist and have valid values
- ✅ **Fail-fast validation**: Application won't start with invalid or missing required variables
- ✅ **Clear error messages**: Validation failures provide actionable guidance
- ✅ **Autocomplete support**: IDEs provide autocomplete for `env.*` properties
- ✅ **Centralized configuration**: Single source of truth in `lib/env.ts`

## Quick Setup

### 1. Copy Environment Template

Create your local environment file from the template:

```bash
cp .env.example .env.local
```

**Important:** Never commit `.env.local` or `.env` files. These contain secrets and should remain local to your machine.

### 2. Configure Required Variables

#### Database (Required)

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/sunrise_db"
```

For local development, use your local PostgreSQL instance. In Docker, use the service name `db` instead of `localhost`.

#### Authentication (Required)

```bash
BETTER_AUTH_URL="http://localhost:3000"
BETTER_AUTH_SECRET="your-32-character-secret-here"
```

The `BETTER_AUTH_URL` is your application's base URL. For local development, use `http://localhost:3000`.

The `BETTER_AUTH_SECRET` is used for JWT signing and must be at least 32 characters.

#### App Configuration (Required)

```bash
NODE_ENV="development"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

`NEXT_PUBLIC_APP_URL` is embedded at build time and must match `BETTER_AUTH_URL` for consistency. This is used by the client-side authentication library.

#### OAuth Providers (Optional)

```bash
GOOGLE_CLIENT_ID="your-google-client-id"
GOOGLE_CLIENT_SECRET="your-google-client-secret"
```

Only required if you want to enable Google OAuth. Leave empty to disable.

#### Email (Optional for Phase 1, Required for Phase 3)

```bash
RESEND_API_KEY="your-resend-api-key"
EMAIL_FROM="noreply@yourdomain.com"
```

Email configuration is optional during Phase 1 development. It will be required in Phase 3 when implementing the email system.

#### Logging (Optional)

```bash
LOG_LEVEL="info"
LOG_SANITIZE_PII=true
```

- `LOG_LEVEL` controls minimum log verbosity (`debug`, `info`, `warn`, `error`)
- `LOG_SANITIZE_PII` controls whether PII (emails, names, IPs) is redacted in logs
  - Default: `false` in development (visible for debugging)
  - Default: `true` in production (GDPR/CCPA compliant)
  - Secrets (passwords, tokens) are ALWAYS redacted regardless of this setting

#### Security (Optional)

```bash
ALLOWED_ORIGINS="https://app.example.com,https://mobile.example.com"
```

- `ALLOWED_ORIGINS` configures CORS to allow cross-origin requests from specific domains
  - Default: Same-origin only (most secure)
  - Development: localhost variants are auto-allowed
  - Production: Only explicitly listed origins are allowed
  - Leave unset for same-origin only APIs

### 3. Generate Secrets

#### BETTER_AUTH_SECRET

Generate a cryptographically secure secret:

```bash
openssl rand -base64 32
```

Copy the output and paste it as your `BETTER_AUTH_SECRET` value.

**Important:** Use different secrets for development and production environments. Never reuse secrets across environments.

### 4. Validate Configuration

Start the development server to validate your configuration:

```bash
npm run dev
```

If all required variables are valid, you'll see:

```
✅ Environment variables validated successfully
```

If any variables are missing or invalid, you'll see detailed error messages:

```
❌ Invalid environment variables:
{
  "DATABASE_URL": ["Required"],
  "BETTER_AUTH_SECRET": ["String must contain at least 32 character(s)"]
}
```

## Common Patterns

### Accessing Environment Variables

**⚠️ CRITICAL: Server-Side Only**

The `lib/env.ts` module and the `env` object should **ONLY be imported in server-side code**:

- ✅ Server components
- ✅ API routes (`app/api/**/route.ts`)
- ✅ Server actions
- ✅ Middleware (`middleware.ts`)
- ✅ Server utilities (`lib/db`, `lib/auth/config.ts`, etc.)

**❌ NEVER import `env` in client-side code:**

- ❌ Client components (`'use client'`)
- ❌ Client-side utilities (e.g., `lib/auth/client.ts`)
- ❌ Browser-only code

**Why?** The validation in `lib/env.ts` checks for server-only variables (like `DATABASE_URL`, `BETTER_AUTH_SECRET`) that don't exist in the browser. Importing it in client code will cause validation errors.

**Server-Side Usage (Recommended):**

```typescript
// ✅ GOOD: Server component or API route
import { env } from '@/lib/env';

export default async function ServerComponent() {
  const secret = env.BETTER_AUTH_SECRET; // Type-safe, validated
  const dbUrl = env.DATABASE_URL; // Guaranteed to exist
  // ...
}
```

**Client-Side Usage (Use `process.env` directly):**

```typescript
// ✅ GOOD: Client component
'use client'

export function ClientComponent() {
  // Access NEXT_PUBLIC_* variables directly
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  // Note: These are still validated on the server during build/startup
  return <div>{appUrl}</div>
}
```

**❌ Don't use `process.env` in server-side code:**

```typescript
// BAD: No type safety, could be undefined, no validation
const secret = process.env.BETTER_AUTH_SECRET;
```

### Client vs. Server Variables

Environment variables prefixed with `NEXT_PUBLIC_` are **embedded at build time** and available in both client and server JavaScript:

**In Client Components:**

```typescript
'use client'

export function MyClientComponent() {
  // ✅ Access NEXT_PUBLIC_* directly via process.env
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

  // ❌ NEVER import env in client code
  // import { env } from '@/lib/env' // This will cause errors!

  return <div>{appUrl}</div>
}
```

**In Server Components:**

```typescript
// Server component (no 'use client')
import { env } from '@/lib/env';

export default async function ServerComponent() {
  // ✅ All variables available, type-safe
  const secret = env.BETTER_AUTH_SECRET;
  const dbUrl = env.DATABASE_URL;
  const appUrl = env.NEXT_PUBLIC_APP_URL;

  // ... use any environment variable
}
```

**Server-only variables** (without `NEXT_PUBLIC_` prefix) are only available in:

- Server components (no `'use client'` directive)
- API routes (`app/api/**/route.ts`)
- Server actions (`'use server'`)
- Middleware (`middleware.ts`)
- Server utilities (`lib/db`, `lib/auth/config.ts`)

### Environment-Specific Configuration

Check the current environment:

```typescript
import { env } from '@/lib/env';

if (env.NODE_ENV === 'development') {
  // Development-only logic
  console.log('Debug info:', data);
}

if (env.NODE_ENV === 'production') {
  // Production-only logic
  enableAdvancedCaching();
}
```

**Best Practice:** Use optional environment variables for features that should behave differently in development vs. production, rather than branching on `NODE_ENV` extensively.

### Optional Variables

Some variables are optional and may be `undefined`:

```typescript
import { env } from '@/lib/env';

// Optional variables need null checking
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  enableGoogleOAuth();
}

// Or use optional chaining with fallback
const clientId = env.GOOGLE_CLIENT_ID || 'not-configured';
```

## Troubleshooting

### Application Won't Start

**Symptom:** Server crashes immediately with "Environment validation failed"

**Cause:** Required environment variables are missing or invalid

**Solution:**

1. Check the error message for specific fields that failed validation
2. Compare your `.env.local` with `.env.example` to find missing variables
3. Verify variable values match the expected format (URLs, minimum length, etc.)
4. Ensure secrets are properly generated (e.g., 32+ characters for `BETTER_AUTH_SECRET`)

**Example error:**

```json
{
  "BETTER_AUTH_SECRET": ["String must contain at least 32 character(s)"]
}
```

**Fix:** Generate a longer secret:

```bash
openssl rand -base64 32
```

### Database Connection Failed

**Symptom:** "Invalid connection string" or database connection errors

**Cause:** `DATABASE_URL` is malformed or points to wrong database

**Solution:**

1. Verify PostgreSQL connection string format:
   ```
   postgresql://[user]:[password]@[host]:[port]/[database]
   ```
2. Check that PostgreSQL is running: `pg_isready`
3. Verify credentials and database exist
4. In Docker: use service name `db` instead of `localhost`

**Local development:**

```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/sunrise_db"
```

**Docker Compose:**

```bash
DATABASE_URL="postgresql://postgres:password@db:5432/sunrise_db"
```

### Authentication Not Working

**Symptom:** Login fails, session errors, OAuth redirect errors

**Cause:** `BETTER_AUTH_URL` doesn't match actual application URL

**Solution:**

1. Ensure `BETTER_AUTH_URL` matches your running app:
   - Local dev: `http://localhost:3000`
   - Production: `https://yourdomain.com`
2. Ensure `NEXT_PUBLIC_APP_URL` matches `BETTER_AUTH_URL`
3. Restart dev server after changing `NEXT_PUBLIC_*` variables (they're embedded at build time)

### OAuth Provider Not Working

**Symptom:** Google sign-in button missing or OAuth fails

**Cause:** `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` not set

**Solution:**

1. Set both variables (both are required to enable Google OAuth)
2. Get credentials from [Google Cloud Console](https://console.cloud.google.com/)
3. Configure OAuth consent screen and authorized redirect URIs:
   - Local: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://yourdomain.com/api/auth/callback/google`

### Environment Changes Not Taking Effect

**Symptom:** Changed environment variable but app behavior unchanged

**Cause:** Variables starting with `NEXT_PUBLIC_` are embedded at build time

**Solution:**

1. Restart development server: `Ctrl+C` then `npm run dev`
2. For production builds, rebuild the application: `npm run build`
3. Server-only variables take effect immediately (no rebuild needed)

## Security Best Practices

### Secret Management

**DO:**

- ✅ Use `openssl rand -base64 32` to generate secrets
- ✅ Use different secrets for dev, staging, and production
- ✅ Store production secrets in secure secret management (e.g., Vercel, AWS Secrets Manager)
- ✅ Rotate secrets quarterly or after suspected compromise
- ✅ Audit who has access to production secrets

**DON'T:**

- ❌ Never commit `.env.local` or `.env` files to Git
- ❌ Never share secrets via email, Slack, or unsecured channels
- ❌ Never use the same secret across multiple environments
- ❌ Never use weak or predictable secrets

### .env File Management

Your `.gitignore` should include:

```gitignore
.env
.env.local
.env*.local
```

Only `.env.example` should be committed (it contains no actual secrets).

### Exposing Variables to Client

Be extremely careful about `NEXT_PUBLIC_*` variables:

- ⚠️ **All `NEXT_PUBLIC_*` variables are visible in browser JavaScript**
- ⚠️ **Never use `NEXT_PUBLIC_` prefix for secrets**
- ⚠️ **Only expose truly public values** (API URLs, feature flags, etc.)

**Good use cases for `NEXT_PUBLIC_`:**

- Application URL
- Public API endpoints
- Feature flag names (not values)
- Analytics IDs (if public)

**Never use `NEXT_PUBLIC_` for:**

- API keys
- Secrets
- Private configuration
- Database credentials

## Related Documentation

- **[Environment Variable Reference](./reference.md)** - Complete list of all variables with descriptions and constraints
- **[Database Configuration](./../database/schema.md)** - Database setup and schema documentation
- **[Authentication Configuration](./../auth/overview.md)** - Authentication system documentation
- **[API Documentation](./../api/endpoints.md)** - API endpoint patterns and usage

## Validation Schema

The complete validation schema is in `lib/env.ts`. All variables are validated using Zod schemas with custom error messages.

To add a new environment variable:

1. Add it to the schema in `lib/env.ts`
2. Add it to `.env.example` with a description
3. Document it in `reference.md`
4. Update this guide if it affects setup

Example:

```typescript
// lib/env.ts
const envSchema = z.object({
  // ... existing variables

  NEW_VARIABLE: z.string().min(10, {
    message: 'NEW_VARIABLE must be at least 10 characters',
  }),
});
```
