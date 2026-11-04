/**
 * The waitlist config (§125): what a fork declares in `lib/app/waitlist-config.ts`,
 * and the one place core reads it.
 *
 * **The config is the on switch.** `waitlistConfig = null` (what Sunrise ships)
 * means the app has no waitlist: the routes answer 404 and nothing writes.
 * Having a waitlist is a decision the fork's developers make with the form,
 * copy and fields that go with it, so it ships with the code rather than
 * living in an env var that staging and production could disagree on.
 *
 * **Taking joins is a separate switch**: per org and per list, in the
 * `WaitlistListState` table, opened and closed by an admin. The config only
 * sets each list's starting state ({@link WaitlistListDeclaration.startsClosed}).
 *
 * **A plain value, not a registry.** The seam is a `const` export — like
 * `lib/app/emails.ts` — so there is no init to run, nothing a throw could
 * half-apply, and no realm that might read an empty map. It is validated
 * once on first read; an invalid config switches the waitlist off and logs
 * why, rather than half-working.
 *
 * @see .context/waitlist/overview.md
 */

import { z } from 'zod';
import { logger } from '@/lib/logging';
import { waitlistConfig as appWaitlistConfig } from '@/lib/app/waitlist-config';
import type { WaitlistFieldShape } from '@/lib/validations/waitlist';

/** The list every waitlist has unless the fork declares its own. */
export const DEFAULT_WAITLIST_LIST = 'default';

/**
 * One extra question on the form, declared by the fork: its key in
 * `WaitlistEntry.details`, its label (form, admin column, CSV header), optional
 * help text, how the form renders it (`text`, `textarea`, or `select` with
 * `options`), whether it is `required`, and its `maxLength` (default 200 for
 * text, 2000 for a textarea). Every answer is stored as a string.
 */
export type WaitlistField = WaitlistFieldShape;

/** One named list. */
export interface WaitlistListDeclaration {
  /** The list key a join names and an entry is stored under. */
  key: string;
  /**
   * Start the list closed until an admin opens it. Default: open — the change
   * that declares a list is already the deliberate act, and its copy and
   * privacy notice ship in the same change. Once an admin has opened or closed
   * the list, the stored state wins.
   */
  startsClosed?: boolean;
}

/** What `screen()` is shown about a join. Nothing here is stored by core. */
export interface WaitlistScreenInput {
  email: string;
  name: string | null;
  list: string;
  details: Readonly<Record<string, string>>;
  /** The caller's IP, for a fork's own repeat-address check. */
  ip: string | null;
}

/** Accept the join, or keep it but hold it back for an admin to look at. */
export type WaitlistScreenResult = { action: 'accept' } | { action: 'flag'; reason: string };

/** Everything a fork declares to have a waitlist. */
export interface WaitlistConfig {
  /**
   * The version of the consent text the form is shown under — whatever the
   * fork's privacy notice calls it ("2026-11-01", "v3"). Stored on every entry
   * with the moment of joining, so any later use of the list can tell what
   * each person agreed to.
   */
  consentVersion: string;
  /** Extra questions, in form order. Default: none — core keeps email and name. */
  fields?: readonly WaitlistField[];
  /** Named lists. Default: one list, `'default'`. */
  lists?: readonly WaitlistListDeclaration[];
  /**
   * Decide whether a join looks suspicious (a throwaway domain, a repeated IP,
   * a bot signal). A flagged entry is kept but left out of bulk invites and
   * counts; the joiner gets the same answer either way. Core ships no
   * blocklist. A throw flags the entry with `screen-error`.
   */
  screen?: (input: WaitlistScreenInput) => WaitlistScreenResult | Promise<WaitlistScreenResult>;
  /**
   * How long each state is kept before the retention job deletes it. Your
   * privacy notice should say the same. Every window has a default.
   */
  retention?: WaitlistRetention;
}

/** Retention windows (§125). Each is optional; the defaults are the spec's. */
export interface WaitlistRetention {
  /** Days a removed entry is kept after its removal. Default 90. */
  removedDays?: number;
  /** Months a closed list's entries are kept after it closed. Default 12. */
  closedListMonths?: number;
}

/** The spec's windows, used for any the config leaves out. */
export const DEFAULT_WAITLIST_RETENTION: Required<WaitlistRetention> = {
  removedDays: 90,
  closedListMonths: 12,
};

/** The config, validated and with its defaults filled in. */
export interface ResolvedWaitlistConfig {
  consentVersion: string;
  fields: readonly WaitlistField[];
  lists: readonly WaitlistListDeclaration[];
  screen: WaitlistConfig['screen'] | null;
  retention: Required<WaitlistRetention>;
}

const KEY = /^[a-z][a-z0-9_-]{0,39}$/i;

/** Field keys a fork may not take: they are the join body's own names. */
const RESERVED_FIELD_KEYS = new Set(['email', 'name', 'list', 'website', 'referrer']);

const fieldSchema = z
  .object({
    key: z
      .string()
      .regex(KEY, 'a field key is a letter then up to 39 letters, digits, - or _')
      .refine((k) => !RESERVED_FIELD_KEYS.has(k.toLowerCase()), 'that field key is reserved')
      // `constructor`, `toString`…: an absent answer would read the inherited
      // member, and the join would refuse it as not a string.
      .refine((k) => !(k in Object.prototype), 'a field key may not name an Object member'),
    label: z.string().trim().min(1),
    help: z.string().optional(),
    kind: z.enum(['text', 'textarea', 'select']),
    options: z
      .array(z.object({ value: z.string().min(1).max(200), label: z.string().min(1) }))
      .min(1)
      .optional(),
    required: z.boolean().optional(),
    maxLength: z.number().int().min(1).max(10_000).optional(),
  })
  .refine((f) => (f.kind === 'select') === (f.options !== undefined), {
    message: 'a select field needs options, and only a select field takes them',
  });

const configSchema = z.object({
  consentVersion: z.string().trim().min(1).max(100),
  fields: z
    .array(fieldSchema)
    .max(30)
    .optional()
    .refine((fs) => !fs || new Set(fs.map((f) => f.key)).size === fs.length, {
      message: 'field keys must be unique',
    }),
  lists: z
    .array(
      z.object({
        key: z.string().regex(KEY, 'a list key is a letter then up to 39 letters, digits, - or _'),
        startsClosed: z.boolean().optional(),
      })
    )
    .min(1)
    .max(50)
    .optional()
    .refine((ls) => !ls || new Set(ls.map((l) => l.key)).size === ls.length, {
      message: 'list keys must be unique',
    }),
  screen: z.unknown().optional(),
  retention: z
    .object({
      removedDays: z.number().int().min(1).max(3650).optional(),
      closedListMonths: z.number().int().min(1).max(120).optional(),
    })
    .strict()
    .optional(),
});

type Cached = { resolved: ResolvedWaitlistConfig | null };
let cache: Cached | null = null;

/**
 * Validate a declared config. `null` in, `null` out (no waitlist). An invalid
 * config also answers `null` — the waitlist is off — and logs each problem,
 * so a fork sees why its form 404s rather than getting half a waitlist.
 */
export function resolveWaitlistConfig(
  config: WaitlistConfig | null
): ResolvedWaitlistConfig | null {
  if (config === null) return null;
  const parsed = configSchema.safeParse(config);
  if (!parsed.success || (config.screen !== undefined && typeof config.screen !== 'function')) {
    logger.error('Waitlist config is invalid; the waitlist is off until it is fixed', {
      issues: parsed.success
        ? [{ path: 'screen', message: 'screen must be a function' }]
        : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return null;
  }
  return {
    consentVersion: parsed.data.consentVersion,
    // The fork's own objects, not the parse's copies: the declaration is the
    // contract, and nothing here transforms it.
    fields: config.fields ?? [],
    lists: config.lists ?? [{ key: DEFAULT_WAITLIST_LIST }],
    screen: config.screen ?? null,
    retention: { ...DEFAULT_WAITLIST_RETENTION, ...parsed.data.retention },
  };
}

/**
 * The app's waitlist config, or `null` when it has none. Read this at the top
 * of every waitlist route, page and job; nothing in core reads the scaffold
 * directly.
 */
export function getWaitlistConfig(): ResolvedWaitlistConfig | null {
  cache ??= { resolved: resolveWaitlistConfig(appWaitlistConfig) };
  return cache.resolved;
}

/** True when the app has a waitlist. */
export function isWaitlistEnabled(): boolean {
  return getWaitlistConfig() !== null;
}

/** Test-only: forget the validated config so a re-mocked scaffold is read again. */
export function __resetWaitlistConfigForTests(): void {
  cache = null;
}
