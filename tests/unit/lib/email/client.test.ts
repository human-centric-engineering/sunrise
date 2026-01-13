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

  describe('validateEmailConfig', () => {
    beforeEach(async () => {
      // Reset the startupWarningLogged flag between tests
      // We need to reimport the module to reset internal state
      vi.resetModules();
    });

    it('should log warning when email verification is required but email is not configured (production default)', async () => {
      // Set up environment for production
      const envModule = await import('@/lib/env');
      envModule.env.NODE_ENV = 'production';
      envModule.env.REQUIRE_EMAIL_VERIFICATION = undefined;
      envModule.env.RESEND_API_KEY = '';
      envModule.env.EMAIL_FROM = '';

      const { logger } = await import('@/lib/logging');
      const { validateEmailConfig } = await import('@/lib/email/client');

      validateEmailConfig();

      expect(logger.warn).toHaveBeenCalledWith(
        'Email verification is required but email provider is not configured',
        {
          requireEmailVerification: true,
          hasResendApiKey: false,
          hasEmailFrom: false,
          nodeEnv: 'production',
          recommendation:
            'Set RESEND_API_KEY and EMAIL_FROM, or set REQUIRE_EMAIL_VERIFICATION=false',
        }
      );
    });

    it('should log warning when REQUIRE_EMAIL_VERIFICATION is explicitly true but email is not configured', async () => {
      // Set up environment with explicit verification requirement
      const envModule = await import('@/lib/env');
      envModule.env.NODE_ENV = 'development';
      envModule.env.REQUIRE_EMAIL_VERIFICATION = true;
      envModule.env.RESEND_API_KEY = '';
      envModule.env.EMAIL_FROM = '';

      const { logger } = await import('@/lib/logging');
      const { validateEmailConfig } = await import('@/lib/email/client');

      validateEmailConfig();

      expect(logger.warn).toHaveBeenCalledWith(
        'Email verification is required but email provider is not configured',
        {
          requireEmailVerification: true,
          hasResendApiKey: false,
          hasEmailFrom: false,
          nodeEnv: 'development',
          recommendation:
            'Set RESEND_API_KEY and EMAIL_FROM, or set REQUIRE_EMAIL_VERIFICATION=false',
        }
      );
    });

    it('should not log warning when email verification is disabled and email is not configured', async () => {
      // Set up environment with verification disabled
      const envModule = await import('@/lib/env');
      envModule.env.NODE_ENV = 'development';
      envModule.env.REQUIRE_EMAIL_VERIFICATION = false;
      envModule.env.RESEND_API_KEY = '';
      envModule.env.EMAIL_FROM = '';

      const { logger } = await import('@/lib/logging');
      const { validateEmailConfig } = await import('@/lib/email/client');

      validateEmailConfig();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should not log warning when email is fully configured (even if verification required)', async () => {
      // Set up environment with verification required and email configured
      const envModule = await import('@/lib/env');
      envModule.env.NODE_ENV = 'production';
      envModule.env.REQUIRE_EMAIL_VERIFICATION = true;
      envModule.env.RESEND_API_KEY = 're_test_key_123';
      envModule.env.EMAIL_FROM = 'test@example.com';

      const { logger } = await import('@/lib/logging');
      const { validateEmailConfig } = await import('@/lib/email/client');

      validateEmailConfig();

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should be idempotent and only log once on subsequent calls', async () => {
      // Set up environment to trigger warning
      const envModule = await import('@/lib/env');
      envModule.env.NODE_ENV = 'production';
      envModule.env.REQUIRE_EMAIL_VERIFICATION = true;
      envModule.env.RESEND_API_KEY = '';
      envModule.env.EMAIL_FROM = '';

      const { logger } = await import('@/lib/logging');
      const { validateEmailConfig } = await import('@/lib/email/client');

      // Call multiple times
      validateEmailConfig();
      validateEmailConfig();
      validateEmailConfig();

      // Should only log once
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('should log warning when verification required with partial email config (only API key)', async () => {
      // Set up environment with only API key
      const envModule = await import('@/lib/env');
      envModule.env.NODE_ENV = 'production';
      envModule.env.REQUIRE_EMAIL_VERIFICATION = undefined; // defaults to true in production
      envModule.env.RESEND_API_KEY = 're_test_key_123';
      envModule.env.EMAIL_FROM = '';

      const { logger } = await import('@/lib/logging');
      const { validateEmailConfig } = await import('@/lib/email/client');

      validateEmailConfig();

      expect(logger.warn).toHaveBeenCalledWith(
        'Email verification is required but email provider is not configured',
        {
          requireEmailVerification: true,
          hasResendApiKey: true,
          hasEmailFrom: false,
          nodeEnv: 'production',
          recommendation:
            'Set RESEND_API_KEY and EMAIL_FROM, or set REQUIRE_EMAIL_VERIFICATION=false',
        }
      );
    });

    it('should log warning when verification required with partial email config (only EMAIL_FROM)', async () => {
      // Set up environment with only EMAIL_FROM
      const envModule = await import('@/lib/env');
      envModule.env.NODE_ENV = 'production';
      envModule.env.REQUIRE_EMAIL_VERIFICATION = undefined; // defaults to true in production
      envModule.env.RESEND_API_KEY = '';
      envModule.env.EMAIL_FROM = 'test@example.com';

      const { logger } = await import('@/lib/logging');
      const { validateEmailConfig } = await import('@/lib/email/client');

      validateEmailConfig();

      expect(logger.warn).toHaveBeenCalledWith(
        'Email verification is required but email provider is not configured',
        {
          requireEmailVerification: true,
          hasResendApiKey: false,
          hasEmailFrom: true,
          nodeEnv: 'production',
          recommendation:
            'Set RESEND_API_KEY and EMAIL_FROM, or set REQUIRE_EMAIL_VERIFICATION=false',
        }
      );
    });
  });
});
