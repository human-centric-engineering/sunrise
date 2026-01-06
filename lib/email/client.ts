import { Resend } from 'resend';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';

let resendClient: Resend | null = null;

/**
 * Get Resend client instance (singleton pattern)
 * Returns null if RESEND_API_KEY is not configured
 */
export function getResendClient(): Resend | null {
  // Check if Resend is configured
  if (!env.RESEND_API_KEY) {
    logger.warn('RESEND_API_KEY not configured - email sending disabled');
    return null;
  }

  // Create singleton instance
  if (!resendClient) {
    resendClient = new Resend(env.RESEND_API_KEY);
    logger.debug('Resend client initialized');
  }

  return resendClient;
}

/**
 * Check if email system is fully configured and enabled
 * Requires both RESEND_API_KEY and EMAIL_FROM to be set
 */
export function isEmailEnabled(): boolean {
  const enabled = !!(env.RESEND_API_KEY && env.EMAIL_FROM);

  if (!enabled) {
    logger.debug('Email system not fully configured', {
      hasApiKey: !!env.RESEND_API_KEY,
      hasEmailFrom: !!env.EMAIL_FROM,
    });
  }

  return enabled;
}

/**
 * Get default email sender address
 * Returns EMAIL_FROM if configured, otherwise fallback
 */
export function getDefaultSender(): string {
  const sender = env.EMAIL_FROM || 'noreply@localhost';

  if (!env.EMAIL_FROM) {
    logger.warn('EMAIL_FROM not configured - using fallback sender', { sender });
  }

  return sender;
}
