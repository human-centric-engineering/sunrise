import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendEmail } from '@/lib/email/send';
import type { SendEmailOptions, SendEmailResult } from '@/lib/email/send';

// Mock dependencies
vi.mock('@react-email/render', () => ({
  render: vi.fn().mockResolvedValue('<html>Mock email HTML</html>'),
}));

vi.mock('@/lib/email/client', () => ({
  getResendClient: vi.fn(),
  isEmailEnabled: vi.fn(),
  getDefaultSender: vi.fn().mockReturnValue('noreply@sunrise.com'),
}));

vi.mock('@/lib/env', () => ({
  env: {
    RESEND_API_KEY: '',
    EMAIL_FROM: '',
    NODE_ENV: 'test',
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('lib/email/send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockEmail = (): React.ReactElement => {
    return React.createElement('div', {}, 'Test Email');
  };

  describe('sendEmail - when email is enabled', () => {
    it('should send email successfully with single recipient', async () => {
      const { isEmailEnabled, getResendClient } = await import('@/lib/email/client');
      const { render } = await import('@react-email/render');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isEmailEnabled).mockReturnValue(true);
      const mockSend = vi.fn().mockResolvedValue({
        data: { id: 'email-123' },
      });
      vi.mocked(getResendClient).mockReturnValue({
        emails: { send: mockSend },
      } as any);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
      };

      const result: SendEmailResult = await sendEmail(options);

      expect(result.success).toBe(true);
      expect(result.id).toBe('email-123');
      expect(render).toHaveBeenCalledWith(options.react);
      expect(mockSend).toHaveBeenCalledWith({
        from: 'noreply@sunrise.com',
        to: ['user@example.com'],
        subject: 'Test Email',
        html: '<html>Mock email HTML</html>',
      });
      expect(logger.info).toHaveBeenCalledWith(
        'Email sent successfully',
        expect.objectContaining({
          id: 'email-123',
          to: 'user@example.com',
          subject: 'Test Email',
        })
      );
    });

    it('should send email successfully with multiple recipients', async () => {
      const { isEmailEnabled, getResendClient } = await import('@/lib/email/client');

      vi.mocked(isEmailEnabled).mockReturnValue(true);
      const mockSend = vi.fn().mockResolvedValue({
        data: { id: 'email-456' },
      });
      vi.mocked(getResendClient).mockReturnValue({
        emails: { send: mockSend },
      } as any);

      const options: SendEmailOptions = {
        to: ['user1@example.com', 'user2@example.com'],
        subject: 'Test Email',
        react: createMockEmail(),
      };

      const result: SendEmailResult = await sendEmail(options);

      expect(result.success).toBe(true);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ['user1@example.com', 'user2@example.com'],
        })
      );
    });

    it('should use custom from address when provided', async () => {
      const { isEmailEnabled, getResendClient } = await import('@/lib/email/client');

      vi.mocked(isEmailEnabled).mockReturnValue(true);
      const mockSend = vi.fn().mockResolvedValue({
        data: { id: 'email-789' },
      });
      vi.mocked(getResendClient).mockReturnValue({
        emails: { send: mockSend },
      } as any);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
        from: 'custom@example.com',
      };

      await sendEmail(options);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'custom@example.com',
        })
      );
    });

    it('should include replyTo when provided', async () => {
      const { isEmailEnabled, getResendClient } = await import('@/lib/email/client');

      vi.mocked(isEmailEnabled).mockReturnValue(true);
      const mockSend = vi.fn().mockResolvedValue({
        data: { id: 'email-999' },
      });
      vi.mocked(getResendClient).mockReturnValue({
        emails: { send: mockSend },
      } as any);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
        replyTo: 'support@example.com',
      };

      await sendEmail(options);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          replyTo: 'support@example.com',
        })
      );
    });

    it('should handle Resend API error response', async () => {
      const { isEmailEnabled, getResendClient } = await import('@/lib/email/client');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isEmailEnabled).mockReturnValue(true);
      const mockSend = vi.fn().mockResolvedValue({
        error: {
          message: 'Invalid API key',
          name: 'validation_error',
        },
      });
      vi.mocked(getResendClient).mockReturnValue({
        emails: { send: mockSend },
      } as any);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
      };

      const result: SendEmailResult = await sendEmail(options);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid API key');
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to send email via Resend',
        expect.objectContaining({ message: 'Invalid API key' }),
        expect.any(Object)
      );
    });

    it('should handle unexpected errors during email sending', async () => {
      const { isEmailEnabled, getResendClient } = await import('@/lib/email/client');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isEmailEnabled).mockReturnValue(true);
      const mockSend = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.mocked(getResendClient).mockReturnValue({
        emails: { send: mockSend },
      } as any);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
      };

      const result: SendEmailResult = await sendEmail(options);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
      expect(logger.error).toHaveBeenCalledWith(
        'Error sending email',
        expect.any(Error),
        expect.any(Object)
      );
    });

    it('should handle Resend client not available', async () => {
      const { isEmailEnabled, getResendClient } = await import('@/lib/email/client');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isEmailEnabled).mockReturnValue(true);
      vi.mocked(getResendClient).mockReturnValue(null);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
      };

      const result: SendEmailResult = await sendEmail(options);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Resend client not available');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('sendEmail - when email is not enabled', () => {
    it('should return mock success in development environment', async () => {
      const { env } = await import('@/lib/env');
      const { isEmailEnabled } = await import('@/lib/email/client');
      const { logger } = await import('@/lib/logging');

      env.NODE_ENV = 'development';
      vi.mocked(isEmailEnabled).mockReturnValue(false);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
      };

      const result: SendEmailResult = await sendEmail(options);

      expect(result.success).toBe(true);
      expect(result.id).toMatch(/^mock-\d+$/);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('returning mock success in development'),
        expect.any(Object)
      );
    });

    it('should return mock success in test environment', async () => {
      const { env } = await import('@/lib/env');
      const { isEmailEnabled } = await import('@/lib/email/client');
      const { logger } = await import('@/lib/logging');

      env.NODE_ENV = 'test';
      vi.mocked(isEmailEnabled).mockReturnValue(false);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
      };

      const result: SendEmailResult = await sendEmail(options);

      expect(result.success).toBe(true);
      expect(result.id).toMatch(/^mock-test-\d+$/);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('returning mock success in test environment'),
        expect.any(Object)
      );
    });

    it('should throw error in production environment', async () => {
      const { env } = await import('@/lib/env');
      const { isEmailEnabled } = await import('@/lib/email/client');
      const { logger } = await import('@/lib/logging');

      env.NODE_ENV = 'production';
      vi.mocked(isEmailEnabled).mockReturnValue(false);

      const options: SendEmailOptions = {
        to: 'user@example.com',
        subject: 'Test Email',
        react: createMockEmail(),
      };

      await expect(sendEmail(options)).rejects.toThrow('Email system not configured');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('email cannot be sent in production')
      );
    });
  });

  describe('sendEmail - logging', () => {
    it('should log email attempt with correct metadata', async () => {
      const { isEmailEnabled, getResendClient } = await import('@/lib/email/client');
      const { logger } = await import('@/lib/logging');

      vi.mocked(isEmailEnabled).mockReturnValue(true);
      const mockSend = vi.fn().mockResolvedValue({
        data: { id: 'email-log-test' },
      });
      vi.mocked(getResendClient).mockReturnValue({
        emails: { send: mockSend },
      } as any);

      const options: SendEmailOptions = {
        to: ['user1@example.com', 'user2@example.com'],
        subject: 'Log Test',
        react: createMockEmail(),
      };

      await sendEmail(options);

      expect(logger.info).toHaveBeenCalledWith(
        'Sending email',
        expect.objectContaining({
          to: 'user1@example.com, user2@example.com',
          subject: 'Log Test',
          from: 'noreply@sunrise.com',
          emailEnabled: true,
        })
      );
    });
  });
});
