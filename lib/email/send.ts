import * as React from 'react';
import { render } from '@react-email/render';
import { getResendClient, isEmailEnabled, getDefaultSender } from './client';
import { logger } from '@/lib/logging';
import { env } from '@/lib/env';

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  react: React.ReactElement;
  from?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * Send an email using Resend
 *
 * Graceful degradation:
 * - Development: Logs email details and returns mock success
 * - Test: Logs warning and returns mock success
 * - Production: Throws error if not configured, returns actual result if configured
 *
 * @param options Email options including recipient, subject, and React component
 * @returns Result with success status, email ID, or error message
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { to, subject, react, from, replyTo } = options;
  const sender = from || getDefaultSender();

  // Log email attempt
  logger.info('Sending email', {
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    from: sender,
    emailEnabled: isEmailEnabled(),
    nodeEnv: env.NODE_ENV,
  });

  // Check if email is enabled
  if (!isEmailEnabled()) {
    const message = 'Email system not configured (missing RESEND_API_KEY or EMAIL_FROM)';

    // Development: Log and return mock success
    if (env.NODE_ENV === 'development') {
      logger.debug(message + ' - returning mock success in development', {
        to,
        subject,
        from: sender,
      });
      return {
        success: true,
        id: `mock-${Date.now()}`,
      };
    }

    // Test: Warn and return mock success
    if (env.NODE_ENV === 'test') {
      logger.warn(message + ' - returning mock success in test environment', {
        to,
        subject,
      });
      return {
        success: true,
        id: `mock-test-${Date.now()}`,
      };
    }

    // Production: Throw error
    logger.error(message + ' - email cannot be sent in production');
    throw new Error('Email system not configured');
  }

  try {
    // Render React component to HTML
    const html = await render(react);

    // Get Resend client
    const resend = getResendClient();
    if (!resend) {
      throw new Error('Resend client not available');
    }

    // Send email via Resend
    const result = await resend.emails.send({
      from: sender,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo && { replyTo }),
    });

    // Check for error in response
    if ('error' in result && result.error) {
      logger.error('Failed to send email via Resend', result.error, {
        to,
        subject,
        from: sender,
      });
      return {
        success: false,
        error: result.error.message || 'Failed to send email',
      };
    }

    // Success - result has data property
    const emailId = result.data?.id;
    logger.info('Email sent successfully', {
      id: emailId,
      to,
      subject,
      from: sender,
    });

    return {
      success: true,
      id: emailId,
    };
  } catch (error) {
    // Log error but don't throw (non-blocking)
    logger.error('Error sending email', error, {
      to,
      subject,
      from: sender,
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error sending email',
    };
  }
}
