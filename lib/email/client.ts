import { Resend } from 'resend';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';

let resendClient: Resend | null = null;
let startupWarningLogged = false;

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
 * If EMAIL_FROM_NAME is set, returns "Name <email>" format (RFC 5322)
 */
export function getDefaultSender(): string {
  const email = env.EMAIL_FROM || 'noreply@localhost';

  if (!env.EMAIL_FROM) {
    logger.warn('EMAIL_FROM not configured - using fallback sender', { sender: email });
  }

  // If a name is configured, use RFC 5322 format: "Name <email>"
  if (env.EMAIL_FROM_NAME) {
    return `${env.EMAIL_FROM_NAME} <${email}>`;
  }

  return email;
}

/**
 * Validate email configuration at startup
 *
 * Checks for configuration mismatches and logs warnings:
 * - Email verification required but no email provider configured
 *
 * This function is idempotent (only logs once) and should be called
 * during application initialization.
 */
export function validateEmailConfig(): void {
  // Only log once
  if (startupWarningLogged) {
    return;
  }

  startupWarningLogged = true;

  // Determine if email verification is required
  const requireEmailVerification = env.REQUIRE_EMAIL_VERIFICATION ?? env.NODE_ENV === 'production';

  // Check for mismatch: verification required but email not configured
  if (requireEmailVerification && !isEmailEnabled()) {
    logger.warn('Email verification is required but email provider is not configured', {
      requireEmailVerification,
      hasResendApiKey: !!env.RESEND_API_KEY,
      hasEmailFrom: !!env.EMAIL_FROM,
      nodeEnv: env.NODE_ENV,
      recommendation: 'Set RESEND_API_KEY and EMAIL_FROM, or set REQUIRE_EMAIL_VERIFICATION=false',
    });
  }
}
