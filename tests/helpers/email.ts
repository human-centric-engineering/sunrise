/**
 * Email Testing Helpers
 *
 * This module provides utilities for mocking email functionality in tests.
 *
 * Usage Examples:
 *
 * Basic mocking in test file:
 * ```typescript
 * import { getEmailMock, mockEmailSuccess } from '@/tests/helpers/email';
 *
 * // At top of test file, mock the module
 * vi.mock('@/lib/email/send');
 *
 * // Import AFTER mocking
 * import { sendEmail } from '@/lib/email/send';
 *
 * describe('My Test', () => {
 *   beforeEach(() => {
 *     mockEmailSuccess();
 *   });
 *
 *   it('should send welcome email', async () => {
 *     // ... trigger email sending
 *
 *     expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
 *       expect.objectContaining({
 *         to: 'user@example.com',
 *         subject: expect.stringContaining('Welcome'),
 *       })
 *     );
 *   });
 * });
 * ```
 *
 * Testing email failures:
 * ```typescript
 * import { mockEmailFailure } from '@/tests/helpers/email';
 *
 * vi.mock('@/lib/email/send');
 * import { sendEmail } from '@/lib/email/send';
 *
 * it('should handle email failure gracefully', async () => {
 *   mockEmailFailure('SMTP connection failed');
 *
 *   // ... test error handling
 * });
 * ```
 */

import { vi } from 'vitest';
import type { SendEmailResult } from '@/lib/email/send';

/**
 * Mock email service to return success
 *
 * Configures the sendEmail mock to return a successful result.
 * Call this in beforeEach() or at the start of your test.
 *
 * IMPORTANT: You must call vi.mock('@/lib/email/send') and import the module
 * before using this helper.
 *
 * @param sendEmailMock - The mocked sendEmail function (use vi.mocked(sendEmail))
 * @param id - Optional email ID to return (default: 'mock-email-id-123')
 *
 * @example
 * ```ts
 * vi.mock('@/lib/email/send');
 * import { sendEmail } from '@/lib/email/send';
 *
 * beforeEach(() => {
 *   mockEmailSuccess(vi.mocked(sendEmail), 'email_abc123');
 * });
 * ```
 */
export function mockEmailSuccess(
  sendEmailMock: ReturnType<typeof vi.fn>,
  id = 'mock-email-id-123'
) {
  sendEmailMock.mockResolvedValue({
    success: true,
    status: 'sent',
    id,
  } as SendEmailResult);
}

/**
 * Mock email service to return failure
 *
 * Configures the sendEmail mock to return a failed result.
 * Useful for testing error handling when email sending fails but doesn't throw.
 *
 * @param sendEmailMock - The mocked sendEmail function (use vi.mocked(sendEmail))
 * @param errorMessage - The error message to return (default: 'Email sending failed')
 *
 * @example
 * ```ts
 * vi.mock('@/lib/email/send');
 * import { sendEmail } from '@/lib/email/send';
 *
 * it('should handle email failure gracefully', async () => {
 *   mockEmailFailure(vi.mocked(sendEmail), 'SMTP connection failed');
 *
 *   // ... test that your code handles the failure appropriately
 * });
 * ```
 */
export function mockEmailFailure(
  sendEmailMock: ReturnType<typeof vi.fn>,
  errorMessage = 'Email sending failed'
) {
  sendEmailMock.mockResolvedValue({
    success: false,
    status: 'failed',
    error: errorMessage,
  } as SendEmailResult);
}

/**
 * Mock email service to throw an error
 *
 * Configures the sendEmail mock to throw an exception.
 * Useful for testing unexpected failures like network timeouts or configuration issues.
 *
 * @param sendEmailMock - The mocked sendEmail function (use vi.mocked(sendEmail))
 * @param error - The error to throw
 *
 * @example
 * ```ts
 * vi.mock('@/lib/email/send');
 * import { sendEmail } from '@/lib/email/send';
 *
 * it('should handle email service crash', async () => {
 *   mockEmailError(vi.mocked(sendEmail), new Error('Network timeout'));
 *
 *   // ... test that your code handles the exception
 * });
 * ```
 */
export function mockEmailError(sendEmailMock: ReturnType<typeof vi.fn>, error: Error) {
  sendEmailMock.mockRejectedValue(error);
}

/**
 * Reset email mock
 *
 * Clears the mock's call history and configured behavior.
 * Call this in afterEach() to clean up between tests.
 *
 * @param sendEmailMock - The mocked sendEmail function (use vi.mocked(sendEmail))
 *
 * @example
 * ```ts
 * vi.mock('@/lib/email/send');
 * import { sendEmail } from '@/lib/email/send';
 *
 * afterEach(() => {
 *   resetEmailMock(vi.mocked(sendEmail));
 * });
 * ```
 */
export function resetEmailMock(sendEmailMock: ReturnType<typeof vi.fn>) {
  sendEmailMock.mockClear();
}

/**
 * Create a mock successful email result
 *
 * Helper function to create a properly typed email result for testing.
 *
 * @param id - Optional email ID (default: 'mock-email-id')
 * @returns A successful SendEmailResult
 *
 * @example
 * ```ts
 * const result = createMockEmailResult('email_123');
 * expect(result).toEqual({ success: true, id: 'email_123' });
 * ```
 */
export function createMockEmailResult(id = 'mock-email-id'): SendEmailResult {
  return {
    success: true,
    status: 'sent',
    id,
  };
}

/**
 * Create a mock failed email result
 *
 * Helper function to create a properly typed failed email result for testing.
 *
 * @param errorMessage - The error message (default: 'Email sending failed')
 * @returns A failed SendEmailResult
 *
 * @example
 * ```ts
 * const result = createMockEmailFailure('Invalid recipient');
 * expect(result).toEqual({ success: false, error: 'Invalid recipient' });
 * ```
 */
export function createMockEmailFailure(errorMessage = 'Email sending failed'): SendEmailResult {
  return {
    success: false,
    status: 'failed',
    error: errorMessage,
  };
}
