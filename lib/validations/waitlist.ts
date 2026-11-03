/**
 * Waitlist join validation (§125).
 *
 * The schema is built from the fork's declared fields and lists, so the server
 * route and the client form validate the same shape. Client-safe: it takes the
 * plain field descriptors, never the config's `screen()`.
 *
 * The honeypot (`website`) is NOT in this schema. It is decided on its value,
 * in the handler, before validation: deciding it on a validation error turns
 * a `website: null` into "you're on the list" with no row written.
 */

import { z } from 'zod';
import { emailSchema } from '@/lib/validations/auth';

/** The parts of a waitlist field the schema needs: serialisable, so a page can hand them to the form. */
export interface WaitlistFieldShape {
  key: string;
  label: string;
  help?: string;
  kind: 'text' | 'textarea' | 'select';
  options?: readonly { value: string; label: string }[];
  required?: boolean;
  maxLength?: number;
}

/** Default longest answer per kind, when the field does not say. */
export const WAITLIST_FIELD_MAX_LENGTH = { text: 200, textarea: 2000, select: 200 } as const;

/** UTM values and the like are labels, not prose. */
const ATTRIBUTION_MAX = 100;

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

function answerSchema(field: WaitlistFieldShape): z.ZodType<string | undefined> {
  if (field.kind === 'select') {
    const values = (field.options ?? []).map((o) => o.value);
    const choice = z.string().refine((v) => values.includes(v), {
      message: `Choose one of the options for ${field.label}`,
    });
    return field.required ? choice : choice.optional();
  }
  const max = field.maxLength ?? WAITLIST_FIELD_MAX_LENGTH[field.kind];
  const text = z.string().trim().max(max, `${field.label} must be ${max} characters or fewer`);
  return field.required
    ? text.min(1, `${field.label} is required`)
    : text.optional().transform((v) => (v ? v : undefined));
}

/**
 * The answers to the fork's fields, keyed by field key. Unknown keys are
 * refused rather than stored: an answer the fork did not declare has no
 * label, no column and no place in the privacy notice.
 */
export function buildWaitlistDetailsSchema(
  fields: readonly WaitlistFieldShape[]
): z.ZodObject<Record<string, z.ZodType<string | undefined>>, z.core.$strict> {
  const shape: Record<string, z.ZodType<string | undefined>> = {};
  for (const field of fields) shape[field.key] = answerSchema(field);
  return z.object(shape).strict();
}

function joinSchema(fields: readonly WaitlistFieldShape[], lists: readonly string[]) {
  const [only] = lists;
  const listSchema = z.string().refine((v) => lists.includes(v), { message: 'Unknown waitlist' });

  return z.object({
    email: emailSchema,
    name: optionalTrimmed(100),
    list:
      lists.length === 1 && only !== undefined ? listSchema.optional().default(only) : listSchema,
    details: buildWaitlistDetailsSchema(fields)
      .optional()
      .default({})
      .transform((d) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(d)) if (typeof v === 'string') out[k] = v;
        return out;
      }),
    utm_source: optionalTrimmed(ATTRIBUTION_MAX),
    utm_medium: optionalTrimmed(ATTRIBUTION_MAX),
    utm_campaign: optionalTrimmed(ATTRIBUTION_MAX),
    /** The page the visitor arrived from (`document.referrer`); only its host is kept. */
    referrer: optionalTrimmed(2048),
  });
}

/** The join body schema's type. */
export type WaitlistJoinSchema = ReturnType<typeof joinSchema>;

/**
 * The join body for a waitlist with these fields and lists. `list` may be
 * omitted only when there is exactly one list.
 */
export function buildWaitlistJoinSchema(
  fields: readonly WaitlistFieldShape[],
  lists: readonly string[]
): WaitlistJoinSchema {
  return joinSchema(fields, lists);
}

export type WaitlistJoinBody = z.infer<WaitlistJoinSchema>;
