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

### `PORT`

- **Purpose:** TCP port the server listens on
- **Required:** ❌ No
- **Type:** Integer
- **Default:** `3000`
- **Used By:**
  - `scripts/dev-server.mjs` — reads it for `npm run dev` / `npm run start`
  - `Dockerfile` / `docker-compose.prod.yml` — set in the container environment
  - Next's standalone server (`node server.js`) reads it directly

**Resolution order** (highest first):

| Source                    | Example                          |
| ------------------------- | -------------------------------- |
| Explicit CLI flag         | `npm run dev -- -p 4100`         |
| Real environment variable | `PORT=4100 npm run dev`, Docker  |
| `.env.<NODE_ENV>.local`   | `.env.development.local`         |
| `.env.local`              | per-developer override           |
| `.env.<NODE_ENV>`         | `.env.development` — committable |
| `.env`                    | —                                |
| Next.js default           | `3000`                           |

**Why a launcher script:** Next's CLI binds `--port` to `PORT` at argument-parse
time, before it loads any `.env` file — so a `PORT=` line in `.env.local` is
visible to the app but not to the server hosting it. `scripts/dev-server.mjs`
reads only the port variable out of those files and passes it to the child
process. Nothing else about env loading changes.

**Running several Sunrise apps at once:** give each fork its own port in a
committed `.env.development` (the one env file `.gitignore` permits), and
`npm run dev` needs no arguments in any of them. The port is independent of the
URL the app is served on — behind a reverse proxy, bind the loopback port here
and point [`NEXT_PUBLIC_APP_URL`](#next_public_app_url) / `BETTER_AUTH_URL` at
the proxied hostname:

```bash
# myapp/.env.development — committed, contains no secrets
PORT=3021
NEXT_PUBLIC_APP_URL="https://myapp.test"
BETTER_AUTH_URL="https://myapp.test"
```

better-auth derives its trusted origin from `BETTER_AUTH_URL`, so the proxied
hostname needs no separate allow-listing. `ALLOWED_ORIGINS` stays unset unless
a _different_ origin calls the API.

**Sunrise ships `PORT=3010` in a committed `.env.development`.** A fork should
change it — two Sunrise-derived apps that both keep the default collide the
moment they run together. See
[`CUSTOMIZATION.md`](../../CUSTOMIZATION.md#claiming-your-own-dev-port).

**Deployment is unaffected.** Two rules make this safe:

1. A real environment variable always outranks a file.
2. `.env.<NODE_ENV>` is only read in that mode — nothing loads
   `.env.development` in production.

| Target                       | Behaviour                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Docker (prod)                | Runtime image copies only the standalone build — `.env.development` and `scripts/` are never in it. `ENV PORT=3000`. |
| Docker (dev / compose)       | `Dockerfile.dev` sets `ENV PORT=3000`; the real variable wins over the file. Compose still maps `3000:3000`.         |
| Vercel                       | Runs `next build`, never `npm start`. The platform assigns the port.                                                 |
| Any PaaS running `npm start` | Production mode reads `.env.production*` / `.env` only.                                                              |

**Not validated by `lib/env.ts`** — the port is consumed before the app boots.

### `EMAIL_PORT`

- **Purpose:** Port for the React Email preview server (`npm run email:dev`)
- **Required:** ❌ No
- **Type:** Integer
- **Default:** `3000`
- **Used By:** `scripts/dev-server.mjs`

React Email's dev server also defaults to 3000 and has no env binding of its
own, so the launcher passes `-p` for it. Set this when the preview server would
otherwise collide with an app dev server. Same resolution order as `PORT`.

### `INTERNAL_API_URL`

- **Purpose:** Base URL server components use to call **this app's own** API
- **Required:** ❌ No
- **Type:** URL
- **Default:** `http://127.0.0.1:$PORT` in development; `BETTER_AUTH_URL` otherwise
- **Used By:** `lib/api/server-fetch.ts` → `getBaseUrl()`

The address the _server_ can reach is not always the address the _browser_ uses.
A local reverse proxy terminating TLS with a certificate Node does not trust
(Herd, Valet, mkcert) is the common case: the browser is happy, while every
server-side self-call fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Because most
pages catch fetch errors and render an empty result, this shows up as tables
that say "none found" rather than as an error.

Development defaults to loopback, so a proxied local setup needs nothing here.
Set the variable when the same split appears elsewhere:

```bash
# Public hostname resolves to a load balancer the app cannot call back through
INTERNAL_API_URL="http://127.0.0.1:3000"
```

> Do not point this at a _different_ application. It is the app's own address —
> anything else sends cookie-bearing internal requests to a third party.

### `ALLOWED_DEV_ORIGINS`

- **Purpose:** Extra hosts allowed to reach Next's **development** endpoints —
  the HMR socket and `/_next/*` dev resources
- **Required:** ❌ No
- **Type:** String (comma-separated hosts, `*` wildcards allowed)
- **Default:** the hostnames of `NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL`
- **Used By:** `next.config.js` → `allowedDevOrigins`

> **Not [`ALLOWED_ORIGINS`](#allowed_origins).** That one is CORS for the API in
> every environment. This one is hot reload in `next dev`, and Next ignores it
> in production builds.

Next allows only `localhost` / `*.localhost` to load its dev resources and
blocks the rest. An app served through a local reverse proxy therefore renders
fine but never hot-reloads, logging:

```
⚠ Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr from "myapp.test".
```

`next.config.js` heads this off by deriving the allowlist from the URLs the app
is already configured to be served on, so **a fork that sets its URLs to the
proxied hostname needs nothing here** — and never has to edit `next.config.js`.
Restart the dev server after changing either URL; the config reads them at
startup.

Use this variable for hosts those URLs don't cover:

```bash
# Testing on a phone against your machine's LAN address
ALLOWED_DEV_ORIGINS="192.168.0.18"

# Serving tenants on subdomains in development
ALLOWED_DEV_ORIGINS="*.myapp.test"
```

**Not validated by `lib/env.ts`** — read at config-load time, before the app
boots.

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
