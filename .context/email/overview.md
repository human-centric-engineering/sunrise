# Email System Overview

**Version**: 1.0.0
**Last Updated**: 2026-02-05
**Status**: Production-ready

## Architecture

Sunrise uses Resend for production email delivery and React Email for template rendering. The system gracefully degrades in development/test environments (logs instead of sends) and fails explicitly in production if not configured.

## Email Types

### Transactional

**Welcome Email**

- Sent after user accepts invitation
- Template: `emails/welcome.tsx`
- Props: `userName`, `userEmail`, `baseUrl`
- Non-blocking: Failure doesn't prevent invitation acceptance

**Email Verification**

- Sent during self-signup (environment-based)
- Only sent in production (disabled in development by default)
- Template: `emails/verify-email.tsx`
- Props: `userName`, `verificationUrl`, `expiresAt`
- Triggered by better-auth email verification flow

**Password Reset**

- Sent when user requests password reset via better-auth
- Template: `emails/reset-password.tsx`
- Props: `userName`, `resetUrl`, `expiresAt`

**User Invitation**

- Sent when admin invites new user via `POST /api/v1/users/invite`
- Template: `emails/invitation.tsx`
- Props: `inviterName`, `inviteeName`, `inviteeEmail`, `invitationUrl`, `expiresAt`
- Non-blocking: Failure doesn't prevent invitation creation

**Contact Notification**

- Sent to admin when contact form is submitted via `POST /api/v1/contact`
- Template: `emails/contact-notification.tsx`
- Props: `name`, `email`, `subject`, `message`, `submittedAt`
- Recipient: `CONTACT_EMAIL` environment variable (falls back to `EMAIL_FROM`)
- Non-blocking: Failure doesn't prevent contact submission success response

## Configuration

### Required Environment Variables

**Production Only (Optional in Dev/Test):**

- `RESEND_API_KEY` - API key from resend.com for sending emails
- `EMAIL_FROM` - Default sender email address (e.g., "noreply@yourdomain.com")
- `EMAIL_FROM_NAME` - (Optional) Display name for sender (e.g., "Sunrise" produces "Sunrise <noreply@yourdomain.com>")

### Behavior by Environment

**Development (`NODE_ENV=development`):**

- Logs email details to console with structured logger
- Returns mock success result (`id: "mock-{timestamp}"`)
- Does not require Resend configuration

**Test (`NODE_ENV=test`):**

- Logs warning to console
- Returns mock success result (`id: "mock-test-{timestamp}"`)
- Tests use mocked `sendEmail` function via `tests/helpers/email.ts`

**Production (`NODE_ENV=production`):**

- Throws error if `RESEND_API_KEY` or `EMAIL_FROM` not configured
- Sends real emails via Resend API
- Logs all email operations with structured logging

## Components

### Infrastructure

**`lib/email/client.ts`**

- `getResendClient()` - Singleton Resend client initialization
- `isEmailEnabled()` - Check if email is fully configured (API key + sender)
- `getDefaultSender()` - Get sender address, with optional display name (RFC 5322)
- `validateEmailConfig()` - Startup validation, warns if email verification required but email not configured (idempotent)

**`lib/email/send.ts`**

- `sendEmail(options)` - Core send function with graceful degradation by environment
- React component rendering to HTML via `@react-email/render`
- Structured logging for all operations (success, failure, warnings)

Exports: `sendEmail()`, `SendEmailOptions`, `SendEmailResult`, `EmailStatus`

**SendEmailOptions:**

| Property  | Type                 | Required | Description                                                    |
| --------- | -------------------- | -------- | -------------------------------------------------------------- |
| `to`      | `string \| string[]` | Yes      | Recipient email address(es)                                    |
| `subject` | `string`             | Yes      | Email subject line                                             |
| `react`   | `React.ReactElement` | Yes      | React Email template component                                 |
| `from`    | `string`             | No       | Override default sender (uses `getDefaultSender()` if omitted) |
| `replyTo` | `string`             | No       | Reply-to address (used by contact form)                        |

### Templates

All templates use React Email components (`Html`, `Head`, `Preview`, `Body`, etc.) with inline CSS styling.

**`emails/welcome.tsx`**

- Welcome message with dashboard link
- Props: `userName`, `userEmail`, `baseUrl`

**`emails/verify-email.tsx`**

- Email verification with security notice and expiration warning
- Props: `userName`, `verificationUrl`, `expiresAt`

**`emails/reset-password.tsx`**

- Password reset link with security guidance
- Props: `userName`, `resetUrl`, `expiresAt`

**`emails/invitation.tsx`**

- User invitation from existing user with personalized message
- Props: `inviterName`, `inviteeName`, `inviteeEmail`, `invitationUrl`, `expiresAt`

**`emails/contact-notification.tsx`**

- Admin notification of contact form submission
- Props: `name`, `email`, `subject`, `message`, `submittedAt`

## User Creation Integration

Sunrise supports two user creation patterns with different email behaviors:

**Self-Signup (User-Initiated):**

- User signs up via `POST /api/auth/sign-up/email`
- Email verification sent (production only, disabled in development)
- User must verify email before login (production)
- Template: `emails/verify-email.tsx`

**Invitation-Based (Admin-Initiated):**

- Admin invites user via `POST /api/v1/users/invite`
- Invitation email sent with accept link
- User accepts and sets password
- Welcome email sent after acceptance
- Email auto-verified (no separate verification step)
- Templates: `emails/invitation.tsx`, `emails/welcome.tsx`

**For complete user creation flows**, see [User Creation Patterns](../auth/user-creation.md)

### Integration Points

**`POST /api/v1/users/invite`**

- Sends invitation email to new user
- Non-blocking (logs error but returns success if email fails)
- Template: `emails/invitation.tsx`

**`POST /api/auth/accept-invite`**

- Sends welcome email after invitation acceptance
- Non-blocking (logs error but returns success if email fails)
- Template: `emails/welcome.tsx`

**`lib/auth/config.ts`**

- better-auth integration for email verification and password reset flows
- Uses `sendEmail()` for verification and reset templates
- Environment-based email verification (`REQUIRE_EMAIL_VERIFICATION`)

## Testing

### Unit Tests

**Mock Strategy:**

- All tests mock the `sendEmail` module using Vitest's `vi.mock()`
- No actual emails sent during tests

**Test Helpers (`tests/helpers/email.ts`):**

| Helper                         | Purpose                           | Default                  |
| ------------------------------ | --------------------------------- | ------------------------ |
| `mockEmailSuccess(mock, id?)`  | Configure mock to return success  | `'mock-email-id-123'`    |
| `mockEmailFailure(mock, msg?)` | Configure mock to return failure  | `'Email sending failed'` |
| `mockEmailError(mock, error)`  | Configure mock to throw exception | (none)                   |
| `resetEmailMock(mock)`         | Clear mock state between tests    | —                        |
| `createMockEmailResult(id?)`   | Create typed success result       | `'mock-email-id'`        |
| `createMockEmailFailure(msg?)` | Create typed failure result       | `'Email sending failed'` |

### Integration Tests

**Behavior Verification:**

- Tests verify `sendEmail` called with correct parameters (to, subject, template)
- Tests check graceful failure handling (non-blocking errors)
- Tests validate environment-specific behavior (dev/test/prod)

**Example Pattern:**

```typescript
vi.mock('@/lib/email/send');
import { sendEmail } from '@/lib/email/send';

beforeEach(() => {
  mockEmailSuccess(vi.mocked(sendEmail));
});

it('sends welcome email after user creation', async () => {
  await POST(mockRequest);

  expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
    expect.objectContaining({
      to: 'user@example.com',
      subject: expect.stringContaining('Welcome'),
    })
  );
});
```

## Key Principles

**Non-blocking:**

- Email failures never block user operations (registration succeeds even if welcome email fails)
- Errors logged but not thrown to calling code

**Graceful Degradation:**

- Development/test environments work without Resend configuration
- Production fails explicitly if misconfigured (fail fast)

**Template-based:**

- All emails use React Email components for consistent styling
- Templates receive typed props for type safety

**Environment-aware:**

- Behavior adapts to `NODE_ENV` (dev logs, test mocks, prod sends)
- Configuration validation ensures production reliability

**Structured Logging:**

- All operations logged with context (recipient, subject, result)
- PII-aware logging via structured logger (`lib/logging`)

## References

- **API Endpoints**: `.context/api/endpoints.md`
- **Authentication**: `.context/auth/overview.md` (better-auth integration)
- **Template Examples**: `emails/` directory
- **Test Helpers**: `tests/helpers/email.ts`
- **Environment Config**: `.context/environment/validation.md`
- **Logging**: `.context/errors/logging.md`
