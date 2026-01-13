/**
 * Unit Tests: Email Test Helpers
 *
 * Tests the email testing utilities to ensure they work correctly
 * and provide reliable mocking for email functionality in tests.
 *
 * Test Coverage:
 * - mockEmailSuccess() creates success mock
 * - mockEmailFailure() creates failure mock
 * - mockEmailError() creates error mock
 * - resetEmailMock() clears all mocks
 * - Helper functions create proper data structures
 * - Mocks can be properly asserted against
 *
 * @see tests/helpers/email.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mockEmailSuccess,
  mockEmailFailure,
  mockEmailError,
  resetEmailMock,
  createMockEmailResult,
  createMockEmailFailure,
} from '@/tests/helpers/email';
import type { SendEmailResult } from '@/lib/email/send';

// Mock the email module at the top level
vi.mock('@/lib/email/send');

// Import AFTER mocking
import { sendEmail } from '@/lib/email/send';

describe('Email Test Helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mockEmailSuccess', () => {
    it('should configure mock to return success with default id', async () => {
      // Arrange
      mockEmailSuccess(vi.mocked(sendEmail));

      // Act
      const result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });

      // Assert
      expect(result).toEqual({
        success: true,
        status: 'sent',
        id: 'mock-email-id-123',
      });
    });

    it('should configure mock to return success with custom id', async () => {
      // Arrange
      mockEmailSuccess(vi.mocked(sendEmail), 'custom-email-id');

      // Act
      const result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });

      // Assert
      expect(result).toEqual({
        success: true,
        status: 'sent',
        id: 'custom-email-id',
      });
    });

    it('should allow verification of call arguments', async () => {
      // Arrange
      mockEmailSuccess(vi.mocked(sendEmail));
      const options = {
        to: 'user@example.com',
        subject: 'Welcome Email',
        react: null as any,
        from: 'noreply@example.com',
      };

      // Act
      await sendEmail(options);

      // Assert
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(options);
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: expect.stringContaining('Welcome'),
        })
      );
    });

    it('should allow verification of call count', async () => {
      // Arrange
      mockEmailSuccess(vi.mocked(sendEmail));
      const options = {
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      };

      // Act
      await sendEmail(options);
      await sendEmail(options);
      await sendEmail(options);

      // Assert
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(3);
    });
  });

  describe('mockEmailFailure', () => {
    it('should configure mock to return failure with default error', async () => {
      // Arrange
      mockEmailFailure(vi.mocked(sendEmail));

      // Act
      const result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });

      // Assert
      expect(result).toEqual({
        success: false,
        status: 'failed',
        error: 'Email sending failed',
      });
    });

    it('should configure mock to return failure with custom error', async () => {
      // Arrange
      mockEmailFailure(vi.mocked(sendEmail), 'SMTP connection failed');

      // Act
      const result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });

      // Assert
      expect(result).toEqual({
        success: false,
        status: 'failed',
        error: 'SMTP connection failed',
      });
    });

    it('should allow custom error messages', async () => {
      // Arrange
      const customError = 'Invalid recipient email address';
      mockEmailFailure(vi.mocked(sendEmail), customError);

      // Act
      const result = await sendEmail({
        to: 'invalid-email',
        subject: 'Test',
        react: null as any,
      });

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe(customError);
    });
  });

  describe('mockEmailError', () => {
    it('should configure mock to throw an error', async () => {
      // Arrange
      const error = new Error('Network timeout');
      mockEmailError(vi.mocked(sendEmail), error);

      // Act & Assert
      await expect(
        sendEmail({
          to: 'test@example.com',
          subject: 'Test',
          react: null as any,
        })
      ).rejects.toThrow('Network timeout');
    });

    it('should throw the exact error provided', async () => {
      // Arrange
      const customError = new Error('Custom error message');
      customError.name = 'CustomError';
      mockEmailError(vi.mocked(sendEmail), customError);

      // Act & Assert
      await expect(
        sendEmail({
          to: 'test@example.com',
          subject: 'Test',
          react: null as any,
        })
      ).rejects.toThrow(customError);
    });
  });

  describe('resetEmailMock', () => {
    it('should clear all mock call history', async () => {
      // Arrange
      mockEmailSuccess(vi.mocked(sendEmail));
      await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);

      // Act
      resetEmailMock(vi.mocked(sendEmail));

      // Assert
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(0);
    });

    it('should allow reconfiguring mock after reset', async () => {
      // Arrange
      mockEmailSuccess(vi.mocked(sendEmail), 'first-id');
      let result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });
      expect(result.id).toBe('first-id');

      // Act - Reset and reconfigure
      resetEmailMock(vi.mocked(sendEmail));
      mockEmailSuccess(vi.mocked(sendEmail), 'second-id');
      result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });

      // Assert
      expect(result.id).toBe('second-id');
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1); // Only counted after reset
    });
  });

  describe('createMockEmailResult', () => {
    it('should create a successful result with default id', () => {
      // Act
      const result = createMockEmailResult();

      // Assert
      expect(result).toEqual({
        success: true,
        status: 'sent',
        id: 'mock-email-id',
      });
    });

    it('should create a successful result with custom id', () => {
      // Act
      const result = createMockEmailResult('email_123abc');

      // Assert
      expect(result).toEqual({
        success: true,
        status: 'sent',
        id: 'email_123abc',
      });
    });

    it('should have correct type structure', () => {
      // Act
      const result: SendEmailResult = createMockEmailResult();

      // Assert - TypeScript will catch type errors
      expect(result.success).toBe(true);
      expect(result.id).toBeDefined();
    });
  });

  describe('createMockEmailFailure', () => {
    it('should create a failure result with default error', () => {
      // Act
      const result = createMockEmailFailure();

      // Assert
      expect(result).toEqual({
        success: false,
        status: 'failed',
        error: 'Email sending failed',
      });
    });

    it('should create a failure result with custom error', () => {
      // Act
      const result = createMockEmailFailure('Invalid recipient');

      // Assert
      expect(result).toEqual({
        success: false,
        status: 'failed',
        error: 'Invalid recipient',
      });
    });

    it('should have correct type structure', () => {
      // Act
      const result: SendEmailResult = createMockEmailFailure();

      // Assert - TypeScript will catch type errors
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('Integration: Using helpers together', () => {
    afterEach(() => {
      resetEmailMock(vi.mocked(sendEmail));
    });

    it('should support full test workflow', async () => {
      // Arrange - Set up mock
      mockEmailSuccess(vi.mocked(sendEmail), 'workflow-email-id');

      // Act - Simulate sending email
      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Welcome to our app',
        react: null as any,
      });

      // Assert - Verify mock was called correctly
      expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Welcome to our app',
        })
      );
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
      expect(result).toEqual(createMockEmailResult('workflow-email-id'));

      // Cleanup - Reset for next test
      resetEmailMock(vi.mocked(sendEmail));
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(0);
    });

    it('should support testing failure scenarios', async () => {
      // Arrange - Set up failure mock
      mockEmailFailure(vi.mocked(sendEmail), 'Rate limit exceeded');

      // Act
      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Test',
        react: null as any,
      });

      // Assert
      expect(result).toEqual(createMockEmailFailure('Rate limit exceeded'));
      expect(vi.mocked(sendEmail)).toHaveBeenCalled();
    });

    it('should support testing error scenarios', async () => {
      // Arrange - Set up error mock
      const error = new Error('Connection refused');
      mockEmailError(vi.mocked(sendEmail), error);

      // Act & Assert
      await expect(
        sendEmail({
          to: 'user@example.com',
          subject: 'Test',
          react: null as any,
        })
      ).rejects.toThrow('Connection refused');
    });

    it('should support switching between success and failure', async () => {
      // First call - Success
      mockEmailSuccess(vi.mocked(sendEmail), 'success-id');
      let result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });
      expect(result.success).toBe(true);
      expect(result.id).toBe('success-id');

      // Reset and reconfigure
      resetEmailMock(vi.mocked(sendEmail));

      // Second call - Failure
      mockEmailFailure(vi.mocked(sendEmail), 'Something went wrong');
      result = await sendEmail({
        to: 'test@example.com',
        subject: 'Test',
        react: null as any,
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Something went wrong');
    });
  });
});
