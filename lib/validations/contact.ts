/**
 * Contact Form Validation Schemas
 *
 * Zod schemas for contact form submissions.
 * Used by both client-side forms and server-side API validation.
 *
 * Phase 3.5: Landing Page & Marketing
 */

import { z } from 'zod';
import { createEmailSchema } from '@/lib/validations/auth';
import { englishValidation, type ValidationT } from '@/lib/validations/messages';

/**
 * Contact form submission schema
 *
 * Validates contact form data:
 * - Name: Required, max 100 chars
 * - Email: Valid email format
 * - Subject: Required, max 200 chars
 * - Message: Required, min 10 chars, max 5000 chars
 */
/** The contact form's fields. */
type ContactShape = {
  name: z.ZodString;
  email: z.ZodString;
  subject: z.ZodString;
  message: z.ZodString;
};

export function createContactSchema(t: ValidationT): z.ZodObject<ContactShape> {
  return z.object({
    name: z.string().trim().min(1, t('nameRequired')).max(100, t('nameTooLong')),
    email: createEmailSchema(t),
    subject: z.string().trim().min(1, t('subjectRequired')).max(200, t('subjectTooLong')),
    message: z.string().trim().min(10, t('messageTooShort')).max(5000, t('messageTooLong')),
  });
}
export const contactSchema = createContactSchema(englishValidation);

/**
 * Contact form with honeypot field (client-side)
 *
 * Extends contactSchema with honeypot field for spam prevention.
 * Client-side allows any value - the check happens server-side.
 */
export function createContactClientSchema(
  t: ValidationT
): z.ZodObject<ContactShape & { website: z.ZodOptional<z.ZodString> }> {
  return createContactSchema(t).extend({ website: z.string().optional() });
}
export const contactClientSchema = createContactClientSchema(englishValidation);

/**
 * Contact form with honeypot field (server-side)
 *
 * Server-side schema that validates honeypot must be empty.
 * The honeypot field should be empty (hidden from real users, filled by bots).
 */
export const contactWithHoneypotSchema = contactSchema.extend({
  website: z.string().max(0, 'Invalid submission').optional(),
});

/**
 * TypeScript types inferred from schemas
 */
export type ContactInput = z.infer<typeof contactSchema>;
export type ContactClientInput = z.infer<typeof contactClientSchema>;
export type ContactWithHoneypotInput = z.infer<typeof contactWithHoneypotSchema>;
