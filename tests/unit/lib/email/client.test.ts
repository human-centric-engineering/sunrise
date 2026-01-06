import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getResendClient, isEmailEnabled, getDefaultSender } from '@/lib/email/client';

// Mock dependencies
vi.mock('resend', () => {
  const MockResend = vi.fn(function (this: any, _apiKey: string) {
    this.emails = {
      send: vi.fn(),
    };
  });
  return {
    Resend: MockResend,
  };
});

vi.mock('@/lib/env', () => ({
  env: {
    RESEND_API_KEY: '',
    EMAIL_FROM: '',
    NODE_ENV: 'test',
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('lib/email/client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getResendClient', () => {
    it('should return null when RESEND_API_KEY is not configured', async () => {
      const { env } = await import('@/lib/env');
      const { logger } = await import('@/lib/logging');

      env.RESEND_API_KEY = '';

      const client = getResendClient();

      expect(client).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        'RESEND_API_KEY not configured - email sending disabled'
      );
    });

    it('should create Resend client when RESEND_API_KEY is configured', async () => {
      const { env } = await import('@/lib/env');
      const { Resend } = await import('resend');
      const { logger } = await import('@/lib/logging');

      env.RESEND_API_KEY = 're_test_key_123';

      const client = getResendClient();

      expect(client).not.toBeNull();
      expect(Resend).toHaveBeenCalledWith('re_test_key_123');
      expect(logger.debug).toHaveBeenCalledWith('Resend client initialized');
    });

    it('should return singleton instance on subsequent calls', async () => {
      const { env } = await import('@/lib/env');

      env.RESEND_API_KEY = 're_test_key_789';

      const client1 = getResendClient();
      const client2 = getResendClient();

      // Both calls should return the exact same instance (singleton)
      expect(client1).toBe(client2);
      expect(client1).not.toBeNull();
      expect(client2).not.toBeNull();
    });
  });

  describe('isEmailEnabled', () => {
    it('should return false when both RESEND_API_KEY and EMAIL_FROM are missing', async () => {
      const { env } = await import('@/lib/env');
      const { logger } = await import('@/lib/logging');

      env.RESEND_API_KEY = '';
      env.EMAIL_FROM = '';

      const result = isEmailEnabled();

      expect(result).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith('Email system not fully configured', {
        hasApiKey: false,
        hasEmailFrom: false,
      });
    });

    it('should return false when only RESEND_API_KEY is configured', async () => {
      const { env } = await import('@/lib/env');
      const { logger } = await import('@/lib/logging');

      env.RESEND_API_KEY = 're_test_key_123';
      env.EMAIL_FROM = '';

      const result = isEmailEnabled();

      expect(result).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith('Email system not fully configured', {
        hasApiKey: true,
        hasEmailFrom: false,
      });
    });

    it('should return false when only EMAIL_FROM is configured', async () => {
      const { env } = await import('@/lib/env');
      const { logger } = await import('@/lib/logging');

      env.RESEND_API_KEY = '';
      env.EMAIL_FROM = 'test@example.com';

      const result = isEmailEnabled();

      expect(result).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith('Email system not fully configured', {
        hasApiKey: false,
        hasEmailFrom: true,
      });
    });

    it('should return true when both RESEND_API_KEY and EMAIL_FROM are configured', async () => {
      const { env } = await import('@/lib/env');
      const { logger } = await import('@/lib/logging');

      env.RESEND_API_KEY = 're_test_key_123';
      env.EMAIL_FROM = 'test@example.com';

      const result = isEmailEnabled();

      expect(result).toBe(true);
      expect(logger.debug).not.toHaveBeenCalled();
    });
  });

  describe('getDefaultSender', () => {
    it('should return fallback when EMAIL_FROM is not configured', async () => {
      const { env } = await import('@/lib/env');
      const { logger } = await import('@/lib/logging');

      env.EMAIL_FROM = '';

      const result = getDefaultSender();

      expect(result).toBe('noreply@localhost');
      expect(logger.warn).toHaveBeenCalledWith(
        'EMAIL_FROM not configured - using fallback sender',
        {
          sender: 'noreply@localhost',
        }
      );
    });

    it('should return EMAIL_FROM when configured', async () => {
      const { env } = await import('@/lib/env');
      const { logger } = await import('@/lib/logging');

      env.EMAIL_FROM = 'noreply@sunrise.com';

      const result = getDefaultSender();

      expect(result).toBe('noreply@sunrise.com');
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
