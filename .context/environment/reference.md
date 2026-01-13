# Environment Variable Reference

Complete reference for all environment variables used in Sunrise. This document provides detailed information about each variable, including requirements, formats, and usage examples.

## Quick Reference Table

| Variable                                        | Required | Type         | Default       | Phase | Description                  |
| ----------------------------------------------- | -------- | ------------ | ------------- | ----- | ---------------------------- |
| [`DATABASE_URL`](#database_url)                 | ✅ Yes   | URL          | -             | 1.3   | PostgreSQL connection string |
| [`BETTER_AUTH_URL`](#better_auth_url)           | ✅ Yes   | URL          | -             | 1.4   | Application base URL         |
| [`BETTER_AUTH_SECRET`](#better_auth_secret)     | ✅ Yes   | String (32+) | -             | 1.4   | JWT signing secret           |
| [`GOOGLE_CLIENT_ID`](#google_client_id)         | ❌ No    | String       | -             | 1.4   | Google OAuth client ID       |
| [`GOOGLE_CLIENT_SECRET`](#google_client_secret) | ❌ No    | String       | -             | 1.4   | Google OAuth secret          |
| [`RESEND_API_KEY`](#resend_api_key)             | ❌ No    | String       | -             | 3.1   | Resend email API key         |
| [`EMAIL_FROM`](#email_from)                     | ❌ No    | Email        | -             | 3.1   | Sender email address         |
| [`EMAIL_FROM_NAME`](#email_from_name)           | ❌ No    | String       | -             | 3.1   | Sender display name          |
| [`NODE_ENV`](#node_env)                         | ✅ Yes   | Enum         | `development` | 1.1   | Environment name             |
| [`NEXT_PUBLIC_APP_URL`](#next_public_app_url)   | ✅ Yes   | URL          | -             | 1.4   | Public app URL (client-side) |
| [`LOG_LEVEL`](#log_level)                       | ❌ No    | Enum         | Auto          | 2.1   | Minimum log level            |
| [`LOG_SANITIZE_PII`](#log_sanitize_pii)         | ❌ No    | Boolean      | Auto          | 3.1   | PII sanitization in logs     |

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

**How to Obtain:**

1. Create account at [resend.com](https://resend.com)
2. Navigate to **API Keys** in dashboard
3. Click **Create API Key**
4. Choose permission level:
   - **Sending access** - Recommended (send emails only)
   - **Full access** - Use with caution (includes domain management)
5. Name your key (e.g., "Development" or "Production")
6. Copy the key immediately (shown only once)
7. Store securely in environment variables

**Test vs Production Keys:**

**Development/Test Keys:**

- Use Resend's test mode (no actual emails sent)
- Free tier: 100 emails/day, 3,000 emails/month
- No domain verification required for testing
- Sandbox environment for development
- Returns success responses without delivery

**Production Keys:**

- Requires verified domain (SPF, DKIM, DMARC records)
- Paid plan required for higher volume
- Actual email delivery to recipients
- Delivery tracking and analytics
- Bounce and complaint handling
- Different key per environment (staging, production)

**Key Management:**

| Environment | Key Type     | Volume Limit       | Domain Required | Cost         |
| ----------- | ------------ | ------------------ | --------------- | ------------ |
| Development | Test mode    | 100/day            | ❌ No           | Free         |
| Staging     | Test or Live | 3,000/month (free) | ⚠️ Recommended  | Free or Paid |
| Production  | Live         | Based on plan      | ✅ Yes          | Paid         |

**Security Considerations:**

- ⚠️ **Never commit API keys to version control** - Always use `.env.local` or secret manager
- ⚠️ **Use separate keys per environment** - Development, staging, and production should have different keys
- ⚠️ **Rotate keys quarterly** - Generate new keys and invalidate old ones regularly
- ⚠️ **Use minimum required permissions** - Prefer "Sending access" over "Full access"
- ⚠️ **Monitor usage in dashboard** - Set up alerts for unusual activity
- ⚠️ **Revoke compromised keys immediately** - Resend dashboard allows instant revocation
- ⚠️ **Store in secret manager for production** - Use Vercel env vars, AWS Secrets Manager, etc.
- ⚠️ **Audit key usage** - Review API key access logs periodically

**Important Notes:**

- Optional during Phase 1 and Phase 2 development
- Required in Phase 3 when email functionality is implemented
- Free tier available for testing (no credit card required)
- Test mode emails visible in Resend dashboard (not delivered to recipients)

**Troubleshooting:**

- **"Invalid API key" error**: Verify key is copied correctly (starts with `re_`)
- **Rate limit exceeded**: Upgrade plan or wait for limit reset
- **Domain not verified**: Complete domain verification before production use
- **Emails not sending**: Check Resend dashboard logs for delivery status

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

**Format Options:**

Simple format (email only):

```bash
EMAIL_FROM="noreply@example.com"
```

With display name (recommended):

```bash
EMAIL_FROM="Sunrise App <noreply@example.com>"
```

With display name (special characters):

```bash
EMAIL_FROM="\"Sunrise: Your App\" <noreply@example.com>"
```

**Domain Verification Requirements:**

To send emails in production, you **must verify your domain** with Resend. This process proves you own the domain and improves email deliverability.

**Verification Steps:**

1. **Add Domain in Resend Dashboard:**
   - Navigate to **Domains** → **Add Domain**
   - Enter your domain (e.g., `example.com`)
   - Choose subdomain for sending (e.g., `mail.example.com`) or use root domain

2. **Add DNS Records:**
   Resend provides three types of DNS records to add to your domain:

   **SPF Record (Sender Policy Framework):**
   - **Type:** TXT
   - **Name:** `@` or root domain
   - **Value:** `v=spf1 include:resend.com ~all`
   - **Purpose:** Authorizes Resend to send emails on your behalf

   **DKIM Record (DomainKeys Identified Mail):**
   - **Type:** TXT
   - **Name:** `resend._domainkey` (provided by Resend)
   - **Value:** Long public key string (provided by Resend)
   - **Purpose:** Cryptographically signs your emails for authenticity

   **DMARC Record (Domain-based Message Authentication):**
   - **Type:** TXT
   - **Name:** `_dmarc`
   - **Value:** `v=DMARC1; p=none; rua=mailto:dmarc@example.com`
   - **Purpose:** Tells receiving servers how to handle failed authentication

3. **Wait for DNS Propagation:**
   - DNS changes can take 5 minutes to 48 hours
   - Check status in Resend dashboard (shows "Verified" when complete)
   - Use DNS lookup tools to verify records: `dig TXT example.com`

4. **Test Verification:**
   - Send test email from Resend dashboard
   - Check email headers for SPF, DKIM, DMARC pass status

**DNS Provider Examples:**

| Provider       | SPF/DKIM/DMARC Support | Propagation Time | Notes                     |
| -------------- | ---------------------- | ---------------- | ------------------------- |
| Cloudflare     | ✅ Excellent           | 5-30 minutes     | Fast, easy DNS management |
| Route 53       | ✅ Excellent           | 10-60 minutes    | AWS-native, reliable      |
| GoDaddy        | ✅ Good                | 1-24 hours       | Slower propagation        |
| Namecheap      | ✅ Good                | 30 minutes-4 hrs | Simple interface          |
| Google Domains | ✅ Excellent           | 10-60 minutes    | Now part of Squarespace   |

**Sender Reputation Impact:**

Your sender email address and domain directly affect email deliverability and reputation. Follow these best practices:

**Email Deliverability Factors:**

1. **Domain Reputation:**
   - New domains have no reputation (warm up slowly)
   - Consistent sending patterns improve reputation
   - High bounce rates damage reputation
   - Spam complaints severely damage reputation

2. **Email Address Choice:**
   - ✅ **Good:** `noreply@`, `notifications@`, `hello@`, `team@`
   - ⚠️ **Avoid:** `admin@`, `postmaster@`, `abuse@` (reserved addresses)
   - ❌ **Bad:** `no-reply@`, `donotreply@` (poor UX, lower engagement)

3. **Warming Up a New Domain:**
   - Start with low volume (50-100 emails/day)
   - Gradually increase over 2-4 weeks
   - Send to engaged users first
   - Monitor bounce and complaint rates
   - Don't jump from 0 to 10,000 emails/day

**Reputation Monitoring:**

- **Bounce Rate:** Keep below 5% (hard bounces)
- **Complaint Rate:** Keep below 0.1% (spam reports)
- **Engagement:** Higher open/click rates improve reputation
- **Consistency:** Regular sending patterns (not sporadic bursts)

**Reputation Tools:**

- [Google Postmaster Tools](https://postmaster.google.com/) - Gmail reputation metrics
- [Microsoft SNDS](https://sendersupport.olc.protection.outlook.com/snds/) - Outlook reputation
- [MXToolbox](https://mxtoolbox.com/blacklists.aspx) - Check if domain is blacklisted
- Resend Dashboard - Bounce and complaint analytics

**Display Name Best Practices:**

- **Use your app name:** "Sunrise" or "Sunrise App"
- **Add context for transactional emails:** "Sunrise - Account Verification"
- **Be consistent:** Same display name across all emails
- **Avoid spam triggers:** No ALL CAPS, excessive punctuation, or misleading names
- **Keep it short:** 15-30 characters for best mobile display

**Recommended Patterns by Email Type:**

| Email Type           | Sender Address              | Display Name               |
| -------------------- | --------------------------- | -------------------------- |
| Verification         | `noreply@example.com`       | `Sunrise - Verify Email`   |
| Password Reset       | `noreply@example.com`       | `Sunrise - Password Reset` |
| Invitation           | `noreply@example.com`       | `Sunrise - You're Invited` |
| Welcome              | `hello@example.com`         | `Sunrise Team`             |
| Notifications        | `notifications@example.com` | `Sunrise Notifications`    |
| Transactional        | `noreply@example.com`       | `Sunrise`                  |
| Marketing (optional) | `newsletter@example.com`    | `Sunrise Newsletter`       |
| Support              | `support@example.com`       | `Sunrise Support`          |

**Important Notes:**

- ⚠️ Domain must be verified in Resend before production use
- ⚠️ Use `noreply@` for automated emails (verification, reset, etc.)
- ⚠️ Use real mailbox (`support@`, `hello@`) for emails expecting replies
- ⚠️ Display name is optional but **strongly recommended** for better UX
- ⚠️ Email address domain must match verified domain in Resend
- ⚠️ Different email addresses for different purposes improves organization

**Troubleshooting:**

- **"Domain not verified" error**: Complete DNS verification in Resend dashboard
- **Emails going to spam**: Check SPF/DKIM/DMARC records, warm up domain, improve content
- **High bounce rate**: Validate email addresses before sending, clean email list regularly
- **Display name not showing**: Ensure proper quote escaping for special characters
- **Emails rejected**: Verify sender address matches verified domain

#### `EMAIL_FROM_NAME`

- **Purpose:** Display name for the email sender (appears before the email address)
- **Required:** ❌ No
- **Type:** String
- **Format:** Plain text name (e.g., `Sunrise`, `Sunrise App`)
- **Validation:** None (optional)
- **Used By:**
  - `lib/email/client.ts` - Combined with `EMAIL_FROM` to create RFC 5322 sender format
- **Phase:** 3.1 (Email System)

**How It Works:**

When `EMAIL_FROM_NAME` is set, emails are sent with the RFC 5322 format:

```
From: Sunrise <noreply@example.com>
```

Without `EMAIL_FROM_NAME`, only the email address is used:

```
From: noreply@example.com
```

**Examples:**

Simple name:

```bash
EMAIL_FROM_NAME="Sunrise"
# Result: "Sunrise <noreply@example.com>"
```

App name with context:

```bash
EMAIL_FROM_NAME="Sunrise App"
# Result: "Sunrise App <noreply@example.com>"
```

Not set (default):

```bash
# EMAIL_FROM_NAME not set
# Result: "noreply@example.com" (email only)
```

**Best Practices:**

- **Keep it short:** 15-30 characters for best mobile display
- **Use your app/brand name:** Makes emails recognizable
- **Be consistent:** Use the same name across all emails
- **Avoid spam triggers:** No ALL CAPS, excessive punctuation, or misleading names

**Important Notes:**

- This is optional - emails work fine without a display name
- The display name appears in the recipient's inbox before the email address
- Some email clients show only the display name (not the email address)
- Setting a recognizable name improves open rates and trust

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

### Logging

#### `LOG_LEVEL`

- **Purpose:** Controls the minimum log level that will be output
- **Required:** ❌ No
- **Type:** Enum (`debug` | `info` | `warn` | `error`)
- **Default:** `debug` in development, `info` in production
- **Validation:** Must be one of the four allowed values (case-insensitive)
- **Used By:**
  - `lib/logging/index.ts` - Logger configuration
- **Phase:** 2.1 (Developer Experience)

**Examples:**

```bash
# Show all logs including debug
LOG_LEVEL="debug"

# Show info, warn, and error (skip debug)
LOG_LEVEL="info"

# Show only warnings and errors
LOG_LEVEL="warn"

# Show only errors
LOG_LEVEL="error"
```

**Log Level Hierarchy:**

| Level   | Description                         | Includes                 |
| ------- | ----------------------------------- | ------------------------ |
| `debug` | Verbose debugging information       | debug, info, warn, error |
| `info`  | General application flow            | info, warn, error        |
| `warn`  | Warnings about degraded states      | warn, error              |
| `error` | Breaking errors requiring attention | error only               |

**Environment Defaults:**

- **Development:** `debug` (verbose output for debugging)
- **Production:** `info` (balanced output for monitoring)
- **Test:** `debug` (full visibility during tests)

**Important Notes:**

- Case-insensitive (`DEBUG`, `Debug`, `debug` all work)
- Invalid values fall back to environment default
- Can be changed without rebuilding the application

#### `LOG_SANITIZE_PII`

- **Purpose:** Controls whether Personally Identifiable Information (PII) is redacted in logs
- **Required:** ❌ No
- **Type:** Boolean (`true` | `false`)
- **Default:** `true` in production, `false` in development
- **Validation:** Must be `true` or `false` (case-insensitive)
- **Used By:**
  - `lib/logging/index.ts` - PII sanitization in log output
- **Phase:** 3.1 (Email System / GDPR Compliance)

**Examples:**

```bash
# Always sanitize PII (recommended for GDPR/CCPA compliance)
LOG_SANITIZE_PII=true

# Never sanitize PII (use with caution in production)
LOG_SANITIZE_PII=false

# Not set: Auto-detects based on NODE_ENV
# LOG_SANITIZE_PII=
```

**How It Works:**

The logger has two-tier sanitization for security and privacy:

**Tier 1: Secrets (ALWAYS redacted regardless of this setting)**

- `password`, `token`, `apiKey`, `secret`, `credential`, `bearer`, `privateKey`
- `creditCard`, `ssn`, `authorization`
- Output: `[REDACTED]`

**Tier 2: PII (controlled by this setting)**

- `email`, `phone`, `mobile`
- `firstName`, `lastName`, `fullName`
- `address`, `street`, `postcode`, `zipcode`
- `ip`, `ipAddress`, `userAgent`
- Output: `[PII REDACTED]`

**Example Log Output:**

```typescript
logger.info('User created', {
  userId: 'usr_123',
  email: 'user@example.com',
  password: 'secret123',
});

// Development (LOG_SANITIZE_PII=false):
// { userId: 'usr_123', email: 'user@example.com', password: '[REDACTED]' }

// Production (LOG_SANITIZE_PII=true):
// { userId: 'usr_123', email: '[PII REDACTED]', password: '[REDACTED]' }
```

**Environment Defaults:**

| Environment | Default Value | Behavior                        |
| ----------- | ------------- | ------------------------------- |
| Development | `false`       | PII visible for debugging       |
| Production  | `true`        | PII redacted (GDPR compliant)   |
| Test        | `false`       | PII visible for test assertions |

**GDPR/CCPA Compliance:**

For GDPR and CCPA compliance, it's recommended to:

1. **Set `LOG_SANITIZE_PII=true` in production** - This is the default
2. **Use `userId` instead of `email` for log correlation** - IDs are not PII
3. **Review logs sent to third-party services** - Ensure PII is sanitized
4. **Document your logging practices** - Include in privacy policy

**Best Practices:**

```typescript
// ✅ GOOD - Use userId for tracing
logger.info('User action', { userId: user.id, action: 'purchase' });

// ⚠️ OK - Email included but will be redacted in production
logger.info('User created', { userId: user.id, email: user.email });

// ❌ AVOID - Logging PII unnecessarily
logger.info('Login', { email, password: '***' }); // Use userId instead
```

**Important Notes:**

- Secrets (passwords, tokens, API keys) are ALWAYS redacted regardless of this setting
- Case-insensitive (`TRUE`, `True`, `true` all work)
- Changes take effect immediately (no rebuild needed)
- Consider using `LOG_SANITIZE_PII=true` even in development for GDPR-strict projects

**Troubleshooting:**

- **PII still visible in production logs:** Verify `LOG_SANITIZE_PII` is not set to `false`
- **Can't see emails during debugging:** Set `LOG_SANITIZE_PII=false` in `.env.local`
- **Third-party log aggregation showing PII:** Logs are sanitized before output; check if the aggregation service processes raw logs differently

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
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: '...' }),
  BETTER_AUTH_URL: z.string().url({ message: '...' }),
  BETTER_AUTH_SECRET: z.string().min(32, { message: '...' }),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  NEXT_PUBLIC_APP_URL: z.string().url({ message: '...' }),
});
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
'use client';

export function ClientComponent() {
  // ✅ Correct: Access NEXT_PUBLIC_* directly
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  // ❌ Wrong: Don't import env in client code
  // import { env } from '@/lib/env' // This causes errors!
}
```

**Example of correct usage:**

```typescript
// ✅ Server component - import env
import { env } from '@/lib/env';

export default async function Dashboard() {
  const dbUrl = env.DATABASE_URL; // Type-safe, validated
  // ...
}

// ✅ Client component - use process.env
('use client');

export function LoginButton() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
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
    message: 'NEW_API_KEY must be at least 10 characters',
  }),
});
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
const secret = process.env.BETTER_AUTH_SECRET || 'fallback';
```

**After:**

```typescript
// Server component or API route
import { env } from '@/lib/env';

const secret = env.BETTER_AUTH_SECRET; // No fallback needed, validated
```

**Benefits:**

- Type safety (no `| undefined`)
- Validation (fails at startup, not runtime)
- Autocomplete in IDE
- No need for fallback values

### Client-Side Code (No Migration Needed)

**For client-side code (client components), continue using `process.env` directly:**

```typescript
'use client';

export function ClientComponent() {
  // ✅ Correct: Keep using process.env for client code
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

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
