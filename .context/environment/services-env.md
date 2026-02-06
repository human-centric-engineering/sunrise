# Services Environment Variables

Configuration for logging, security, application settings, and cookie consent.

## Application Configuration

### `NODE_ENV`

- **Purpose:** Indicates the current environment
- **Required:** ✅ Yes
- **Type:** Enum (`development` | `production` | `test`)
- **Default:** `development`
- **Used By:**
  - `lib/db/client.ts` - Logging configuration
  - `lib/api/errors.ts` - Error detail exposure
  - Next.js internal optimizations

**Behavior by Environment:**

| Environment   | Logging | Error Details     | Optimizations        |
| ------------- | ------- | ----------------- | -------------------- |
| `development` | Verbose | Full stack traces | Hot reload, warnings |
| `production`  | Minimal | Sanitized         | Optimized bundles    |
| `test`        | Minimal | Full              | Test configs         |

**Note:** Automatically set by Next.js (`next dev` → development, `next build`/`start` → production).

### `NEXT_PUBLIC_APP_URL`

- **Purpose:** Public-facing application URL, accessible in client-side code
- **Required:** ✅ Yes
- **Type:** URL
- **Used By:**
  - `lib/auth/client.ts` - Client-side authentication
  - Client components, API calls, metadata

**Examples:**

```bash
# Development
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# Production
NEXT_PUBLIC_APP_URL="https://app.example.com"
```

**Important:**

- ⚠️ **Embedded at build time** - must rebuild after changing
- ⚠️ **Visible in browser** - don't use for secrets
- ⚠️ **Should match `BETTER_AUTH_URL`**

## Logging

### `LOG_LEVEL`

- **Purpose:** Controls the minimum log level that will be output
- **Required:** ❌ No
- **Type:** Enum (`debug` | `info` | `warn` | `error`)
- **Default:** `debug` in development, `info` in production
- **Used By:**
  - `lib/logging/index.ts` - Logger configuration

**Examples:**

```bash
LOG_LEVEL="debug"   # All logs including debug
LOG_LEVEL="info"    # Info, warn, error (skip debug)
LOG_LEVEL="warn"    # Warnings and errors only
LOG_LEVEL="error"   # Errors only
```

**Log Level Hierarchy:**

| Level   | Description       | Includes                 |
| ------- | ----------------- | ------------------------ |
| `debug` | Verbose debugging | debug, info, warn, error |
| `info`  | Application flow  | info, warn, error        |
| `warn`  | Degraded states   | warn, error              |
| `error` | Breaking errors   | error only               |

### `LOG_SANITIZE_PII`

- **Purpose:** Controls whether PII is redacted in logs
- **Required:** ❌ No
- **Type:** Boolean
- **Default:** `true` in production, `false` in development (runtime default, not schema-validated)
- **Used By:**
  - `lib/logging/index.ts` - PII sanitization

> **Note:** This variable uses a runtime default in `lib/logging/index.ts` rather than being validated in the central `lib/env.ts` schema. The default is applied based on `NODE_ENV` when the logger initializes.

**Examples:**

```bash
LOG_SANITIZE_PII=true   # Always sanitize (GDPR compliant)
LOG_SANITIZE_PII=false  # Show PII (use with caution)
```

**Two-Tier Sanitization:**

| Tier             | Fields                                  | Behavior         |
| ---------------- | --------------------------------------- | ---------------- |
| Secrets (always) | `password`, `token`, `apiKey`, `secret` | `[REDACTED]`     |
| PII (controlled) | `email`, `phone`, `firstName`, `ip`     | `[PII REDACTED]` |

**Example Output:**

```typescript
logger.info('User created', { email: 'user@example.com', password: 'secret' });

// Development: { email: 'user@example.com', password: '[REDACTED]' }
// Production:  { email: '[PII REDACTED]', password: '[REDACTED]' }
```

## Security

### `ALLOWED_ORIGINS`

- **Purpose:** Comma-separated list of origins allowed for CORS
- **Required:** ❌ No
- **Type:** String (comma-separated URLs)
- **Default:** Same-origin only
- **Used By:**
  - `lib/security/cors.ts` - CORS origin validation

**Examples:**

```bash
# Same-origin only (default, most secure)
# ALLOWED_ORIGINS=

# Allow specific external origins
ALLOWED_ORIGINS="https://app.example.com,https://mobile.example.com"

# Multiple origins with mobile app
ALLOWED_ORIGINS="https://app.example.com,capacitor://localhost"
```

**Behavior:**

| Environment | `ALLOWED_ORIGINS` | Result                          |
| ----------- | ----------------- | ------------------------------- |
| Development | Not set           | localhost variants auto-allowed |
| Production  | Not set           | Same-origin only (no CORS)      |
| Production  | Set               | Only configured origins         |

**Security Notes:**

- ⚠️ **Never use `*` (wildcard)** - defeats CORS protection
- ⚠️ **Use HTTPS origins in production**
- ⚠️ **Be specific** - only add origins that need access

## Cookie Consent

### `NEXT_PUBLIC_COOKIE_CONSENT_ENABLED`

- **Purpose:** Enable or disable the cookie consent banner
- **Required:** ❌ No
- **Type:** Boolean
- **Default:** `true` (applied in `lib/consent/config.ts`, not schema-validated)
- **Used By:**
  - `lib/consent/config.ts` - Consent system configuration
  - `lib/consent/consent-provider.tsx` - Provider behavior

> **Note:** This variable's default is applied in `lib/consent/config.ts` rather than being validated in the central `lib/env.ts` schema.

**Examples:**

```bash
# Enable cookie consent (default)
NEXT_PUBLIC_COOKIE_CONSENT_ENABLED=true

# Disable cookie consent entirely
NEXT_PUBLIC_COOKIE_CONSENT_ENABLED=false
```

**Behavior:**

| Value   | Banner | Consent Required | Scripts Load  |
| ------- | ------ | ---------------- | ------------- |
| `true`  | Shown  | Yes              | After consent |
| `false` | Never  | No               | Immediately   |

**When to Disable:**

- Internal tools without external tracking
- Applications not serving EU users
- Development/testing environments

**Important:**

- ⚠️ **Embedded at build time** - requires rebuild after changing
- ⚠️ **GDPR compliance** - keep enabled for EU users

## Environment-Specific Summary

| Variable                 | Development             | Production                |
| ------------------------ | ----------------------- | ------------------------- |
| `NODE_ENV`               | `development`           | `production`              |
| `NEXT_PUBLIC_APP_URL`    | `http://localhost:3000` | `https://app.example.com` |
| `LOG_LEVEL`              | `debug`                 | `info`                    |
| `LOG_SANITIZE_PII`       | `false`                 | `true`                    |
| `ALLOWED_ORIGINS`        | Auto (localhost)        | Explicit list             |
| `COOKIE_CONSENT_ENABLED` | As needed               | `true`                    |

## Troubleshooting

**CORS errors:**

- Add the requesting origin to `ALLOWED_ORIGINS`
- Works in dev but fails in prod: Dev auto-allows localhost

**Logs too verbose:**

- Set `LOG_LEVEL=info` or `LOG_LEVEL=warn`

**PII in production logs:**

- Verify `LOG_SANITIZE_PII` is not set to `false`

**Changes not taking effect (NEXT*PUBLIC*\*):**

- Restart dev server or rebuild

## Runtime Variables

Variables automatically provided by Node.js or the framework at runtime.

### `npm_package_version`

- **Purpose:** Reports the application version from `package.json`
- **Required:** N/A (automatically provided by Node.js)
- **Type:** String (semver)
- **Used By:**
  - `app/api/health/route.ts` - Health check version reporting
  - `app/api/v1/admin/stats/route.ts` - Admin stats endpoint

**Note:** This is automatically set by Node.js when running via npm scripts. It reflects the `version` field from your `package.json`.

### `NEXT_TELEMETRY_DISABLED`

- **Purpose:** Disable Next.js anonymous telemetry collection
- **Required:** ❌ No
- **Type:** Boolean (`1` to disable)
- **Default:** Telemetry enabled

**Examples:**

```bash
# Disable Next.js telemetry
NEXT_TELEMETRY_DISABLED=1
```

**When to Use:**

- CI/CD environments (reduce network calls)
- Air-gapped or restricted networks
- Privacy-sensitive deployments
- When telemetry interferes with debugging

**Note:** Next.js collects anonymous usage data to improve the framework. See [Next.js Telemetry](https://nextjs.org/telemetry) for details on what's collected.

## Related Documentation

- [Environment Overview](./overview.md) - Quick setup guide
- [Environment Reference](./reference.md) - All environment variables
- [Logging Documentation](../errors/logging.md) - Logging best practices
- [Security Overview](../security/overview.md) - Security configuration
