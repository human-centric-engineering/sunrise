/**
 * Contact Form Submission Endpoint (Public)
 *
 * POST /api/v1/contact - Submit a contact form message
 *
 * Authentication: None (public endpoint)
 *
 * Request Body:
 *   - name: Sender's name (required)
 *   - email: Sender's email address (required)
 *   - subject: Message subject (required)
 *   - message: Message content (required, min 10 chars)
 *   - website: Honeypot field (must be empty)
 *
 * Rate Limiting: 5 submissions per hour per IP
 *
 * Flow:
 * 1. Check rate limit
 * 2. Validate request body (including honeypot check)
 * 3. Store submission in database
 * 4. Send email notification to admin
 * 5. Return success response
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError, handleAPIError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { contactWithHoneypotSchema } from '@/lib/validations/contact';
import {
  contactLimiter,
  createRateLimitResponse,
  getRateLimitHeaders,
} from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { sendEmail } from '@/lib/email/send';
import ContactNotificationEmail from '@/emails/contact-notification';
import { isRecord } from '@/lib/utils';
import { getRouteLogger } from '@/lib/api/context';
import { env } from '@/lib/env';

/**
 * POST /api/v1/contact
 *
 * Submits a contact form message.
 * Stores in database and sends email notification.
 *
 * @example
 * POST /api/v1/contact
 * {
 *   "name": "John Doe",
 *   "email": "john@example.com",
 *   "subject": "Question about Sunrise",
 *   "message": "I'd like to learn more about..."
 * }
 *
 * @returns Success message
 * @throws ValidationError if invalid request body or honeypot triggered
 * @throws RateLimitError if too many submissions
 */
export async function POST(request: NextRequest) {
  const log = await getRouteLogger(request);

  try {
    // 1. Check rate limit
    const clientIP = getClientIP(request);
    const rateLimitResult = contactLimiter.check(clientIP);

    if (!rateLimitResult.success) {
      log.warn('Contact form rate limit exceeded', {
        ip: clientIP,
        remaining: rateLimitResult.remaining,
        reset: rateLimitResult.reset,
      });
      return createRateLimitResponse(rateLimitResult);
    }

    // 2. Validate request body (including honeypot check)
    const body = await validateRequestBody(request, contactWithHoneypotSchema);

    // Check honeypot field - if filled, it's likely a bot
    if (body.website && body.website.length > 0) {
      log.warn('Contact form honeypot triggered', {
        ip: clientIP,
        email: body.email,
      });
      // Return success to not tip off the bot, but don't process
      return successResponse(
        { message: 'Thank you for your message. We will get back to you soon.' },
        undefined,
        { headers: getRateLimitHeaders(rateLimitResult) }
      );
    }

    // 3. Store submission in database
    const submission = await prisma.contactSubmission.create({
      data: {
        name: body.name,
        email: body.email,
        subject: body.subject,
        message: body.message,
      },
    });

    log.info('Contact form submission created', {
      id: submission.id,
      email: body.email,
      subject: body.subject,
    });

    // 4. Send email notification to admin (non-blocking)
    const adminEmail = env.CONTACT_EMAIL || env.EMAIL_FROM;

    if (!adminEmail) {
      log.warn('No CONTACT_EMAIL or EMAIL_FROM configured, skipping notification', {
        submissionId: submission.id,
      });
    } else {
      sendEmail({
        to: adminEmail,
        subject: `[Sunrise Contact] ${body.subject}`,
        react: ContactNotificationEmail({
          name: body.name,
          email: body.email,
          subject: body.subject,
          message: body.message,
          submittedAt: submission.createdAt,
        }),
        replyTo: body.email,
      })
        .then((result) => {
          if (result.success) {
            log.info('Contact notification email sent', {
              submissionId: submission.id,
              emailId: result.id,
            });
          } else {
            log.warn('Failed to send contact notification email', {
              submissionId: submission.id,
              error: result.error,
            });
          }
        })
        .catch((error) => {
          log.error('Error sending contact notification email', error, {
            submissionId: submission.id,
          });
        });
    }

    // 5. Return success response
    return successResponse(
      { message: 'Thank you for your message. We will get back to you soon.' },
      undefined,
      { headers: getRateLimitHeaders(rateLimitResult) }
    );
  } catch (error) {
    // Special handling for honeypot validation error (to not reveal the field)
    if (error instanceof ValidationError && error.details) {
      const details = error.details;
      if (
        Array.isArray(details.errors) &&
        details.errors.some((e: unknown) => isRecord(e) && e.path === 'website')
      ) {
        log.warn('Contact form honeypot validation failed', {
          ip: getClientIP(request),
        });
        return successResponse({
          message: 'Thank you for your message. We will get back to you soon.',
        });
      }
    }

    return handleAPIError(error);
  }
}
