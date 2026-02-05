# Email Environment Variables

Configuration for Resend email service and email sending.

## `RESEND_API_KEY`

- **Purpose:** API key for Resend email service
- **Required:** ❌ No (Phase 1), ✅ Yes (Phase 3)
- **Type:** String
- **Format:** Resend-issued API key (starts with `re_`)
- **Used By:**
  - `lib/email/client.ts` - Resend client initialization
  - Email sending functionality

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

**Test vs Production Keys:**

| Environment | Key Type     | Volume Limit       | Domain Required | Cost         |
| ----------- | ------------ | ------------------ | --------------- | ------------ |
| Development | Test mode    | 100/day            | ❌ No           | Free         |
| Staging     | Test or Live | 3,000/month (free) | ⚠️ Recommended  | Free or Paid |
| Production  | Live         | Based on plan      | ✅ Yes          | Paid         |

**Security Notes:**

- ⚠️ **Never commit API keys to version control**
- ⚠️ **Use separate keys per environment**
- ⚠️ **Rotate keys quarterly**
- ⚠️ **Use minimum required permissions** (prefer "Sending access")

## `EMAIL_FROM`

- **Purpose:** Sender email address for all transactional emails
- **Required:** ❌ No (Phase 1), ✅ Yes (Phase 3)
- **Type:** Email address
- **Format:** `name@domain.com` or `Name <name@domain.com>`
- **Used By:**
  - `lib/email/client.ts` - Default sender configuration (`getDefaultSender()`)
  - All email templates

**Format Options:**

```bash
# Simple format (email only)
EMAIL_FROM="noreply@example.com"

# With display name (recommended)
EMAIL_FROM="Sunrise App <noreply@example.com>"
```

**Domain Verification:**

For production, you must verify your domain with Resend:

1. Add domain in Resend Dashboard
2. Add DNS records:
   - **SPF:** `v=spf1 include:resend.com ~all`
   - **DKIM:** Provided by Resend
   - **DMARC:** `v=DMARC1; p=none; rua=mailto:dmarc@example.com`
3. Wait for DNS propagation (5 min - 48 hours)

**Recommended Patterns by Email Type:**

| Email Type     | Sender Address        | Display Name               |
| -------------- | --------------------- | -------------------------- |
| Verification   | `noreply@example.com` | `Sunrise - Verify Email`   |
| Password Reset | `noreply@example.com` | `Sunrise - Password Reset` |
| Invitation     | `noreply@example.com` | `Sunrise - You're Invited` |
| Welcome        | `hello@example.com`   | `Sunrise Team`             |
| Support        | `support@example.com` | `Sunrise Support`          |

## `EMAIL_FROM_NAME`

- **Purpose:** Display name for the email sender
- **Required:** ❌ No
- **Type:** String
- **Default:** None (email address only)
- **Used By:**
  - `lib/email/client.ts` - Combined with `EMAIL_FROM`

**Examples:**

```bash
# Simple name
EMAIL_FROM_NAME="Sunrise"
# Result: "Sunrise <noreply@example.com>"

# App name with context
EMAIL_FROM_NAME="Sunrise App"
# Result: "Sunrise App <noreply@example.com>"
```

**Best Practices:**

- Keep it short (15-30 characters)
- Use your app/brand name
- Be consistent across all emails
- Avoid ALL CAPS or excessive punctuation

## `CONTACT_EMAIL`

- **Purpose:** Email address to receive contact form submissions
- **Required:** ❌ No
- **Type:** Email address
- **Default:** Falls back to `EMAIL_FROM` if not set
- **Used By:**
  - `app/api/v1/contact/route.ts` - Contact form notifications

**Examples:**

```bash
# Dedicated support address
CONTACT_EMAIL="support@example.com"

# Not set - falls back to EMAIL_FROM
# CONTACT_EMAIL=
```

**Important Notes:**

- If neither `CONTACT_EMAIL` nor `EMAIL_FROM` is set, no notification email is sent (submission is still stored in database)
- Consider using a monitored inbox (not `noreply@`)

## Environment-Specific Values

| Environment | `RESEND_API_KEY`         | `EMAIL_FROM`               |
| ----------- | ------------------------ | -------------------------- |
| Development | Optional (emails logged) | Optional                   |
| Production  | Required                 | Required (verified domain) |

## Troubleshooting

**"Invalid API key" error:**

- Verify key is copied correctly (starts with `re_`)

**Emails going to spam:**

- Complete domain verification (SPF/DKIM/DMARC)
- Warm up domain gradually
- Improve email content

**"Domain not verified" error:**

- Complete DNS verification in Resend dashboard
- Wait for DNS propagation

## Related Documentation

- [Environment Overview](./overview.md) - Quick setup guide
- [Environment Reference](./reference.md) - All environment variables
- [Email Overview](../email/overview.md) - Email system documentation
