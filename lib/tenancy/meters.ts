/**
 * Meters: counting what an org uses, and refusing past a limit (§135 t-1035).
 *
 * §110 could cap an org's AI spend and nothing else. An app with plans has to
 * cap what only it can count (conversations a month, questionnaires, people),
 * and without this each app would build its own count and its own store of
 * limits. Here the platform owns the mechanism and the app owns every
 * interpretation:
 *
 * - **What counts** is the app's `count` (`registerMeter()` in
 *   `lib/tenancy/entitlements.ts`, called from `lib/app/entitlements.ts`).
 * - **Over which window** is the app's `period`: a UTC month, a standing
 *   count, or a window the app works out per org (a billing cycle).
 * - **The limit** is per org, set by platform staff (`PATCH
 *   /api/v1/admin/orgs/[id]/meters`) or the app's own billing code
 *   (`writeOrgMeterLimits()`), stored at `Org.settings.quotas.meters`.
 * - **What a refusal does** is the app's call: {@link checkMeterQuota}
 *   answers the question and changes nothing.
 *
 * **Seats are the platform's own meter**, because the platform owns the ways
 * a person joins an org: members who are not platform staff, plus open
 * invitations into it. An app that reads a seat differently (not counting
 * invitations, or one role) registers `seats` with its own count, which
 * replaces this one everywhere, the platform's own refusals included.
 *
 * **Fails open, and says so in the log.** A count that throws, a window that
 * cannot be worked out, or a limit that cannot be read answers allowed: a
 * broken meter must not stop an org working, and §110's AI budget still
 * bounds what it can spend. With nothing registered and no limit set nothing
 * is counted and nothing is refused.
 *
 * **Tenancy posture:** stateless; nothing is cached. The limits are on `Org`
 * and the seats count reads `OrgMembership` and `Verification`, all system
 * models, filtered on the org id.
 *
 * @see lib/tenancy/entitlements.ts — `registerMeter()` and the registry
 * @see lib/tenancy/org-settings.ts — the stored limits
 * @see .context/tenancy/entitlements.md
 */

import type { PrismaClient } from '@prisma/client';

import { APIError, ErrorCodes } from '@/lib/api/errors';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  entitlementSwitchesFailed,
  registeredMeters,
  type MeterPeriod,
  type MeterWindow,
  type RegisteredMeter,
} from '@/lib/tenancy/entitlements';
import { countNonStaffMembers } from '@/lib/tenancy/membership';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { loadOrgMeterLimits } from '@/lib/tenancy/org-settings';
import { INVITATION_IDENTIFIER_PREFIX, invitationOrgSlot } from '@/lib/utils/invitation-token';

/** The platform's own meter: the people in an org, and those invited into it. */
export const SEATS_METER_KEY = 'seats';

/**
 * `details.reason` on a refusal for a meter at its limit, so a client can
 * tell it from any other 403. The platform's seats refusal carries it; an app
 * refusing on its own meter may use it too.
 */
export const METER_LIMIT_REASON = 'meter_limit_reached';

/** A meter as this module answers for it: an app's, or the platform's seats. */
export interface Meter extends RegisteredMeter {
  /** The platform's own count, rather than one an app registered. */
  core: boolean;
}

/** What {@link checkMeterQuota} answers. */
export interface MeterQuotaCheck {
  /** Whether the org may add what was asked about. */
  allowed: boolean;
  /** How many the org has within the window; `null` when nothing was counted. */
  used: number | null;
  /** The org's limit; `null` when it has none, so nothing was counted. */
  limit: number | null;
  /** The meter's label, for a refusal to name it; the key when it is unknown. */
  label: string;
  /** The window counted within; `null` when nothing was counted. */
  window: MeterWindow | null;
}

/** The platform's own seats count, used unless the app registers `seats`. */
const CORE_SEATS: Meter = Object.freeze({
  key: SEATS_METER_KEY,
  label: 'Seats',
  description: 'Members who are not platform staff, plus open invitations into the organisation.',
  period: 'standing' as const,
  count: ({ orgId }: { orgId: string }) => countSeats(orgId),
  core: true,
});

/**
 * Every meter, the platform's seats first: the app's `seats` if it registers
 * one, else the platform's. On vanilla Sunrise that is seats alone.
 */
export function allMeters(): readonly Meter[] {
  const appMeters = registeredMeters();
  const appSeats = appMeters.find((m) => m.key === SEATS_METER_KEY);
  return [
    appSeats ? { ...appSeats, core: false } : CORE_SEATS,
    ...appMeters.filter((m) => m.key !== SEATS_METER_KEY).map((m) => ({ ...m, core: false })),
  ];
}

/** One meter by key, or `undefined` for a key nothing registers. */
export function meterOf(key: string): Meter | undefined {
  return allMeters().find((m) => m.key === key);
}

/**
 * Members who are not platform staff (support entering an org does not take
 * one of its seats), plus unexpired invitations into the org. An invitation
 * with no org, or naming the install org, is the install org's.
 */
export async function countSeats(
  orgId: string,
  db: Pick<PrismaClient, 'orgMembership' | 'verification'> = prisma
): Promise<number> {
  const now = new Date();
  const pendingWhere = {
    identifier: { startsWith: INVITATION_IDENTIFIER_PREFIX },
    expiresAt: { gt: now },
  };
  const invitations =
    orgId === INSTALL_ORG_ID
      ? // The install org's invitations may not name it, which a JSON filter
        // cannot match, so they are read and sorted here. A platform's own
        // pending invitations are few.
        (
          await db.verification.findMany({ where: pendingWhere, select: { metadata: true } })
        ).filter((row) => invitationOrgSlot(orgIdIn(row.metadata)) === null).length
      : await db.verification.count({
          where: { ...pendingWhere, metadata: { path: ['orgId'], equals: orgId } },
        });
  return (await countNonStaffMembers(orgId, db)) + invitations;
}

function orgIdIn(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const orgId: unknown = (metadata as Record<string, unknown>).orgId;
  return typeof orgId === 'string' ? orgId : null;
}

/**
 * The window a meter counts within for one org at `now`. Throws when an
 * app's window function throws or answers something that is not a window;
 * the callers here catch it and read the meter as allowed.
 */
export async function meterWindow(
  period: MeterPeriod,
  orgId: string,
  now: Date = new Date()
): Promise<MeterWindow> {
  if (period === 'standing') return { from: null, to: null };
  if (period === 'month') {
    return {
      from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }
  const window: unknown = await period({ orgId, now });
  if (!isWindow(window)) {
    throw new Error(
      'The meter window function did not return { from, to } as dates, from before to'
    );
  }
  return window;
}

function isWindow(value: unknown): value is MeterWindow {
  if (typeof value !== 'object' || value === null) return false;
  const { from, to } = value as Record<string, unknown>;
  return (
    from instanceof Date &&
    to instanceof Date &&
    !Number.isNaN(from.getTime()) &&
    !Number.isNaN(to.getTime()) &&
    from < to
  );
}

/** One meter's count for one org: its window and how many. Throws as the app's code does. */
async function countIn(
  meter: Meter,
  orgId: string,
  now: Date
): Promise<{ used: number; window: MeterWindow }> {
  const window = await meterWindow(meter.period, orgId, now);
  const used: unknown = await meter.count({ orgId, from: window.from, to: window.to });
  if (typeof used !== 'number' || !Number.isInteger(used) || used < 0) {
    throw new Error(
      `The count answered ${JSON.stringify(used)}, not a whole number of zero or more`
    );
  }
  return { used, window };
}

/**
 * May this org add `adding` more (default one) to a meter without passing its
 * limit? The app calls it wherever it refuses, and decides what a refusal
 * does; this changes nothing.
 *
 * Allowed, without counting, when the org has no limit for the meter.
 * Refused when what is counted within the window, plus `adding`, would pass
 * the limit; `adding: 0` asks whether the org is within it now. A meter
 * nothing registers, a count that throws or answers nonsense, a window that
 * cannot be worked out, and a limit that cannot be read all answer allowed,
 * and are logged. Never throws.
 */
export async function checkMeterQuota(
  orgId: string,
  key: string,
  options: { adding?: number; now?: Date } = {}
): Promise<MeterQuotaCheck> {
  const adding = options.adding ?? 1;
  const now = options.now ?? new Date();
  const meter = meterOf(key);
  if (!meter) {
    logger.warn('meters: checked a meter nothing registers; allowed', {
      orgId,
      key,
      registrationFailed: entitlementSwitchesFailed(),
    });
    return { allowed: true, used: null, limit: null, label: key, window: null };
  }
  const open = { allowed: true, used: null, limit: null, label: meter.label, window: null };
  if (!Number.isInteger(adding) || adding < 0) {
    logger.warn('meters: asked to add something that is not a whole number; allowed', {
      orgId,
      key,
      adding,
    });
    return open;
  }
  let limit: number | undefined;
  try {
    limit = (await loadOrgMeterLimits(orgId))?.[key];
  } catch (error) {
    logger.error("meters: could not read an org's meter limits; allowed", {
      orgId,
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return open;
  }
  if (limit === undefined) return open;
  try {
    const { used, window } = await countIn(meter, orgId, now);
    return { allowed: used + adding <= limit, used, limit, label: meter.label, window };
  } catch (error) {
    logger.error('meters: a meter could not be counted; allowed', {
      orgId,
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...open, limit };
  }
}

/**
 * What a refusal for a meter at its limit says: the meter by its label, the
 * limit, and who can change it. Apps refusing on their own meters may use it
 * so every refusal reads the same.
 */
export function meterLimitMessage(check: Pick<MeterQuotaCheck, 'label' | 'limit'>): string {
  return `Your organisation has reached its limit of ${check.limit ?? 0} for ${check.label}. Ask whoever manages your organisation's account to raise it.`;
}

/**
 * Refuse a new seat in an org at its seats limit: the check the org's own
 * invitation and add-member routes make before either adds one. Throws a 403
 * whose `details.reason` is {@link METER_LIMIT_REASON}.
 *
 * **Platform staff are not refused** (`platformAdmin`): the vendor setting an
 * org up, or putting one right, must not be stopped by the limit it sold.
 * The platform's own invite route does not call this for the same reason.
 * With no seats limit set nothing is counted.
 */
export async function refuseOverSeatsLimit(
  orgId: string,
  actor: { platformAdmin: boolean }
): Promise<void> {
  if (actor.platformAdmin) return;
  const check = await checkMeterQuota(orgId, SEATS_METER_KEY);
  if (check.allowed) return;
  logger.info('meters: refused a seat over the org seats limit', {
    orgId,
    used: check.used,
    limit: check.limit,
  });
  throw new APIError(meterLimitMessage(check), ErrorCodes.FORBIDDEN, 403, {
    reason: METER_LIMIT_REASON,
    meter: SEATS_METER_KEY,
    used: check.used,
    limit: check.limit,
  });
}

/** One meter's usage for one org, as the admin page shows it. */
export interface MeterUsage {
  key: string;
  label: string;
  description: string;
  /** `'custom'` for a window the app works out. */
  period: 'month' | 'standing' | 'custom';
  core: boolean;
  limit: number | null;
  /** `null` when it could not be counted. */
  used: number | null;
  window: MeterWindow | null;
  countFailed: boolean;
}

/**
 * Every meter's usage and limit for one org, counted whether or not a limit
 * is set, for the admin page. A meter that cannot be counted says so
 * (`countFailed`) and is logged. Limits stored for keys nothing registers
 * are returned apart, so the page can say they are kept.
 */
export async function loadOrgMeterUsage(
  orgId: string,
  now: Date = new Date()
): Promise<{ meters: MeterUsage[]; unregistered: Record<string, number> } | null> {
  const limits = await loadOrgMeterLimits(orgId);
  if (limits === null) return null;
  const meters = allMeters();
  const usage = await Promise.all(
    meters.map(async (meter): Promise<MeterUsage> => {
      const base = {
        key: meter.key,
        label: meter.label,
        description: meter.description,
        period: typeof meter.period === 'function' ? ('custom' as const) : meter.period,
        core: meter.core,
        limit: limits[meter.key] ?? null,
      };
      try {
        const { used, window } = await countIn(meter, orgId, now);
        return { ...base, used, window, countFailed: false };
      } catch (error) {
        logger.error('meters: a meter could not be counted for the admin page', {
          orgId,
          key: meter.key,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ...base, used: null, window: null, countFailed: true };
      }
    })
  );
  const known = new Set(meters.map((m) => m.key));
  const unregistered = Object.fromEntries(
    Object.entries(limits).filter(([key]) => !known.has(key))
  );
  return { meters: usage, unregistered };
}
