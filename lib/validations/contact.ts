/**
 * Contact Form Validation Schemas
 *
 * Zod schemas for contact form submissions.
 * Used by both client-side forms and server-side API validation.
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { z } from 'zod';
import { emailSchema } from './auth';

/**
 * Contact form submission schema
 *
 * Validates contact form data:
 * - Name: Required, max 100 chars
 * - Email: Valid email format
 * - Subject: Required, max 200 chars
 * - Message: Required, min 10 chars, max 5000 chars
 */
export const contactSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),
  email: emailSchema,
  subject: z
    .string()
    .min(1, 'Subject is required')
    .max(200, 'Subject must be less than 200 characters')
    .trim(),
  message: z
    .string()
    .min(10, 'Message must be at least 10 characters')
    .max(5000, 'Message must be less than 5000 characters')
    .trim(),
});

/**
 * Contact form with honeypot field
 *
 * Extends contactSchema with honeypot field for spam prevention.
 * The honeypot field should be empty (hidden from real users, filled by bots).
 */
export const contactWithHoneypotSchema = contactSchema.extend({
  website: z.string().max(0, 'Invalid submission').optional(),
});

/**
 * TypeScript types inferred from schemas
 */
export type ContactInput = z.infer<typeof contactSchema>;
export type ContactWithHoneypotInput = z.infer<typeof contactWithHoneypotSchema>;
