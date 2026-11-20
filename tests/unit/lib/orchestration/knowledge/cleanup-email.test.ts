/**
 * sendCleanupReadyEmail — unit tests
 *
 * Tests that the function:
 *   1. Looks up the user by userId, selecting only email
 *   2. Skips sending silently when the user has no email
 *   3. Constructs the cleanup URL from env.BETTER_AUTH_URL + documentId
 *   4. Calls sendEmail with the right to/subject/react args
 *   5. Swallows errors and logs at warn level (fire-and-forget contract)
 *
 * All assertions target what the function DOES with its inputs — not the
 * raw mock return values — to satisfy the anti-green-bar lens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted refs ────────────────────────────────────────────────────────────
// vi.hoisted() ensures these exist before any vi.mock() factory runs.
// mockEnv is a mutable object captured by the @/lib/env factory so that
// individual tests can override BETTER_AUTH_URL without re-importing the module.
const { mockFindUnique, mockSendEmail, mockLoggerWarn, mockEnv } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockSendEmail: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockEnv: {
    BETTER_AUTH_URL: 'https://example.com',
  },
}));

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: {
      findUnique: mockFindUnique,
    },
  },
}));

// The email's language is worked out from the recipient (§138 t-1075), tested
// in tests/unit/lib/email/locale.test.ts; here it is English, with no reads
// of its own, so the assertions below see only this module's reads.
vi.mock('@/lib/email/locale', () => ({
  emailLocaleForUser: vi.fn(async () => ({ locale: 'en', timeZone: 'UTC' })),
  emailLocaleForOrg: vi.fn(async () => ({ locale: 'en', timeZone: 'UTC' })),
  emailLocaleForAddress: vi.fn(async () => ({ locale: 'en', timeZone: 'UTC' })),
}));
vi.mock('@/lib/email/send', () => ({
  sendEmail: mockSendEmail,
}));

// The factory closes over mockEnv, so mutations in beforeEach/tests are visible.
vi.mock('@/lib/env', () => ({
  env: mockEnv,
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Import AFTER mocks ──────────────────────────────────────────────────────
import { render } from '@react-email/render';
import { sendCleanupReadyEmail } from '@/lib/orchestration/knowledge/cleanup-email';

// ── Shared fixtures ─────────────────────────────────────────────────────────

const baseOpts = {
  userId: 'user-abc123',
  documentId: 'doc-xyz789',
  documentName: 'Quarterly Report',
  sizeClass: 'medium' as const,
  sizeTokens: 15_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.BETTER_AUTH_URL = 'https://example.com';
  // Default: user has an email
  mockFindUnique.mockResolvedValue({ email: 'admin@example.com' });
  mockSendEmail.mockResolvedValue({ success: true, status: 'sent' });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('sendCleanupReadyEmail', () => {
  describe('user lookup', () => {
    it('looks up the user by userId and selects only email', async () => {
      // Arrange: mockFindUnique already returns { email: ... } from beforeEach

      // Act
      await sendCleanupReadyEmail(baseOpts);

      // Assert: verify the CODE queries the right user with the right field selection
      expect(mockFindUnique).toHaveBeenCalledTimes(1);
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { id: baseOpts.userId },
        select: { email: true },
      });
    });

    it('skips sending when the user has no email (null email)', async () => {
      // Arrange: user row exists but email is null
      mockFindUnique.mockResolvedValue({ email: null });

      // Act
      await sendCleanupReadyEmail(baseOpts);

      // Assert: function returns silently — sendEmail is never called
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('skips sending when the user row is not found', async () => {
      // Arrange: user doesn't exist in DB
      mockFindUnique.mockResolvedValue(null);

      // Act
      await sendCleanupReadyEmail(baseOpts);

      // Assert: no email dispatched for missing user
      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  describe('URL construction', () => {
    it('constructs the cleanup URL from BETTER_AUTH_URL + documentId and passes it to sendEmail', async () => {
      // Arrange
      mockEnv.BETTER_AUTH_URL = 'https://app.acme.com';

      // Act
      await sendCleanupReadyEmail({ ...baseOpts, documentId: 'doc-11111' });

      // Assert: render the react element that was passed to sendEmail and verify
      // the constructed URL is present in the output — this proves the function
      // assembled BETTER_AUTH_URL + documentId correctly (not a hard-coded string)
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const { react } = mockSendEmail.mock.calls[0][0] as {
        react: React.ReactElement;
      };
      const html = await render(react);
      expect(html).toContain(
        'https://app.acme.com/admin/orchestration/knowledge/doc-11111/cleanup'
      );
    });
  });

  describe('sendEmail call', () => {
    it('calls sendEmail with the user email as the to address', async () => {
      // Arrange
      mockFindUnique.mockResolvedValue({ email: 'ops@company.org' });

      // Act
      await sendCleanupReadyEmail(baseOpts);

      // Assert: the function derives `to` from the DB result, not from opts
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const { to } = mockSendEmail.mock.calls[0][0] as { to: string };
      expect(to).toBe('ops@company.org');
    });

    it('includes the documentName in the email subject', async () => {
      // Act
      await sendCleanupReadyEmail({ ...baseOpts, documentName: 'Annual Summary 2025' });

      // Assert: subject contains the name — proves the function uses opts.documentName
      const { subject } = mockSendEmail.mock.calls[0][0] as { subject: string };
      expect(subject).toContain('Annual Summary 2025');
    });

    it('passes a CleanupReady React element with the right props rendered correctly', async () => {
      // Arrange
      // CleanupReady is called as a function inside sendCleanupReadyEmail (not as JSX),
      // so the element passed to sendEmail is the rendered Html tree. We render it
      // to HTML and assert the transformation the source applied to each opt.
      mockEnv.BETTER_AUTH_URL = 'https://myapp.io';
      const opts = {
        ...baseOpts,
        documentId: 'doc-99',
        documentName: 'Meeting Transcript',
        sizeClass: 'large' as const,
        sizeTokens: 80_000,
      };

      // Act
      await sendCleanupReadyEmail(opts);

      // Assert: render the element that was actually passed to sendEmail
      const { react } = mockSendEmail.mock.calls[0][0] as { react: React.ReactElement };
      const html = await render(react);

      // Each assertion verifies the function used a DIFFERENT opt — not a default
      expect(html).toContain('Meeting Transcript'); // documentName
      expect(html).toContain('https://myapp.io/admin/orchestration/knowledge/doc-99/cleanup'); // cleanupUrl derived from BETTER_AUTH_URL + documentId
      expect(html).toContain('Size class: large'); // sizeClass interpolated (not 'medium' default)
      expect(html).toContain('80,000'); // sizeTokens formatted — proves 80_000 was passed
    });
  });

  describe('error swallowing', () => {
    it('swallows sendEmail errors and logs at warn level', async () => {
      // Arrange: sendEmail throws
      const sendError = new Error('Resend rate limit exceeded');
      mockSendEmail.mockRejectedValue(sendError);

      // Act: must NOT throw despite sendEmail throwing
      await expect(sendCleanupReadyEmail(baseOpts)).resolves.toBeUndefined();

      // Assert: the error was logged at warn, not rethrown
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'cleanup-ready email failed',
        expect.objectContaining({
          err: sendError,
          documentId: baseOpts.documentId,
        })
      );
    });

    it('swallows prisma errors and logs at warn level', async () => {
      // Arrange: DB lookup throws
      const dbError = new Error('Connection refused');
      mockFindUnique.mockRejectedValue(dbError);

      // Act: must NOT propagate
      await expect(sendCleanupReadyEmail(baseOpts)).resolves.toBeUndefined();

      // Assert: error was swallowed and logged
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'cleanup-ready email failed',
        expect.objectContaining({ err: dbError })
      );
    });
  });
});
