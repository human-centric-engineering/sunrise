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
import { paginationQuerySchema, queryBooleanSchema } from '@/lib/validations/common';

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
    if (field.required) return choice;
    // Unanswered is '' from the form (every field defaults to it) or absent
    // from an API caller; either is no answer, not an invalid choice.
    return z.preprocess((v) => (v === '' ? undefined : v), choice.optional());
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
    // Absent details are parsed as `{}`, not defaulted past the schema: a
    // zod `.default()` skips the inner parse, so a required field would pass.
    details: z
      .preprocess((v) => v ?? {}, buildWaitlistDetailsSchema(fields))
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

/** Only the serialisable parts of a declared field: what a form needs, and nothing a fork attached. */
export function toWaitlistFieldShape(f: WaitlistFieldShape): WaitlistFieldShape {
  return {
    key: f.key,
    label: f.label,
    kind: f.kind,
    ...(f.help !== undefined ? { help: f.help } : {}),
    ...(f.options !== undefined
      ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) }
      : {}),
    ...(f.required !== undefined ? { required: f.required } : {}),
    ...(f.maxLength !== undefined ? { maxLength: f.maxLength } : {}),
  };
}

// ── Admin (§125 t-976) ──────────────────────────────────────────────────────

/**
 * The most rows one export carries. The export's filename says so when it
 * bites, and the page says so beside the button.
 */
export const WAITLIST_EXPORT_MAX_ROWS = 10_000;

/** A list key as the config declares it (`lib/waitlist/config.ts`). */
const listKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/, 'Not a list key');

/**
 * The filters `GET /api/v1/admin/waitlist` and its export share. By default
 * only confirmed, active entries: unconfirmed, removed and joined ones are
 * shown only when asked for.
 */
export const waitlistAdminFilterSchema = z.object({
  list: listKeySchema.optional(),
  q: z.string().trim().max(200).optional(),
  includeUnconfirmed: queryBooleanSchema.optional(),
  includeRemoved: queryBooleanSchema.optional(),
  includeJoined: queryBooleanSchema.optional(),
  flaggedOnly: queryBooleanSchema.optional(),
});

/**
 * The admin list's page size and default order: the route's defaults, the
 * page's server-rendered first page and the table's requests all read these,
 * so the first page and the next one cannot disagree about what a page is.
 */
export const WAITLIST_ADMIN_PAGE_SIZE = 25;
export const WAITLIST_ADMIN_DEFAULT_SORT = { sortBy: 'createdAt', sortOrder: 'desc' } as const;

export const waitlistAdminListQuerySchema = waitlistAdminFilterSchema.extend({
  page: paginationQuerySchema.shape.page,
  limit: z.coerce.number().int().positive().max(100).default(WAITLIST_ADMIN_PAGE_SIZE),
  sortBy: z.enum(['createdAt', 'email', 'confirmedAt']).default(WAITLIST_ADMIN_DEFAULT_SORT.sortBy),
  sortOrder: z.enum(['asc', 'desc']).default(WAITLIST_ADMIN_DEFAULT_SORT.sortOrder),
});

/** `PATCH /api/v1/admin/waitlist/:id` — the state to reach. */
export const waitlistEntryPatchSchema = z.object({ removed: z.boolean() }).strict();

/** `PATCH /api/v1/admin/waitlist/lists/:key` — the state to reach. */
export const waitlistListPatchSchema = z.object({ open: z.boolean() }).strict();

/** A list key in a route path. */
export const waitlistListKeySchema = listKeySchema;

// ── Invites (§125 t-978) ────────────────────────────────────────────────────

/**
 * The most entries one invite wave sends to (decision 7: a wave has its own
 * cap). Each is an email from the app's sender, sent in turn inside the
 * request; the page states it beside the button.
 */
export const WAITLIST_INVITE_WAVE_MAX = 50;

const waveCountSchema = z.number().int().min(1).max(WAITLIST_INVITE_WAVE_MAX);

/** Narrow a `next` or `sample` wave: one list, and/or one answer to a declared field. */
const waveNarrowing = {
  list: listKeySchema.optional(),
  answer: z
    .object({
      field: z.string().min(1).max(40),
      value: z.string().min(1).max(200),
    })
    .strict()
    .optional(),
};

/**
 * `POST /api/v1/admin/waitlist/invite` — who a wave invites: the rows the
 * admin ticked (`ids`), the next `count` by join date (`next`), or `count`
 * chosen at random (`sample`) among those not yet invited.
 */
export const waitlistInviteWaveSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('ids'),
      ids: z.array(z.string().min(1).max(100)).min(1).max(WAITLIST_INVITE_WAVE_MAX),
    })
    .strict(),
  z.object({ mode: z.literal('next'), count: waveCountSchema, ...waveNarrowing }).strict(),
  z.object({ mode: z.literal('sample'), count: waveCountSchema, ...waveNarrowing }).strict(),
]);

export type WaitlistInviteWaveInput = z.infer<typeof waitlistInviteWaveSchema>;

/**
 * `POST /api/v1/waitlist/confirm` (§125 t-977). Shape only: a token that is
 * well-formed but wrong gets the same answer as an expired or used one.
 */
export const waitlistConfirmSchema = z.object({
  entry: z.string().trim().min(1).max(100),
  // Lowercased before the check: the stored hash is of the lowercase hex the
  // email carries, so an uppercased copy of the link still works.
  token: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[0-9a-f]{64}$/, 'Invalid token'),
});

/** `POST /api/v1/waitlist/leave` (§125 t-977). The signature is checked in the handler. */
export const waitlistLeaveSchema = z.object({
  token: z.string().trim().min(1).max(1000),
});
