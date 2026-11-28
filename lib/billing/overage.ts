/**
 * The overage rule: what happens when an org uses more of a metered item than
 * its plan allows (§139 t-1097).
 *
 * A plan could limit a meter but not charge for using more. A metered item
 * gives a plan's meter an allowance and one of three rules, the app's choice
 * per item:
 *
 * | Rule       | At the allowance                          | Reported to the provider          |
 * | ---------- | ----------------------------------------- | --------------------------------- |
 * | `warn`     | The org is told near and at it; nothing stops | Nothing: a notice, not a charge |
 * | `soft_cap` | Usage continues                           | The excess, once per period       |
 * | `hard_cap` | `checkMeterQuota()` refuses past it       | Nothing: there is no excess       |
 *
 * **The allowance lives on the plan, in one place.** The provider's price is
 * per unit of excess, so the two never have to agree on an allowance. Only a
 * hard cap writes it as the meter's limit; warn and soft cap clear the limit,
 * or `checkMeterQuota()` would refuse what they allow (and a limit an earlier
 * hard-cap plan wrote would stay behind). A purely usage-based item is a
 * soft cap with an allowance of zero.
 *
 * **AI spend is a platform meter, in cents** ({@link AI_SPEND_METER_KEY}): the
 * org's AI cost within the period, leaving out calls on its own provider key.
 * It is not one of the org's meters (it has no limit of its own; §110's budget
 * caps it), so it may be warned on or billed, never hard-capped.
 *
 * **Who is told, and how, is the app's** ({@link setUsageNoticeHandler}).
 * With no handler the platform emails the org's owners. The billing page
 * shows the same state either way.
 *
 * @see lib/billing/plans.ts — where a plan's metered items are registered
 * @see lib/billing/usage-report.ts — the per-period report
 * @see lib/billing/usage-notices.ts — the warn rule's notices
 * @see .context/billing/billing.md#usage-reporting
 */

import { allMeters } from '@/lib/tenancy/meters';
import { meterLimitSchema } from '@/lib/validations/tenancy';

/** What happens past a metered item's allowance. */
export type OverageRule = 'warn' | 'soft_cap' | 'hard_cap';

export const OVERAGE_RULES: readonly OverageRule[] = ['warn', 'soft_cap', 'hard_cap'];

/** The platform's AI spend meter: the org's AI cost within the period, in whole cents. */
export const AI_SPEND_METER_KEY = 'ai_spend_cents';

/** A `warn` item's "near" threshold when the app names none: this share of the allowance. */
export const DEFAULT_WARN_AT_PERCENT = 80;

/** A metered item as an app writes it in a plan, keyed by meter. */
export interface MeteredItemDefinition {
  overage: OverageRule;
  /** How many the plan includes in a period: a whole number. At least 1 for `warn`. */
  allowance: number;
  /**
   * The provider's name for the meter the excess is reported to (Stripe's
   * meter `event_name`). Required for `soft_cap`, and only used there.
   */
  providerMeter?: string;
  /**
   * `warn` only: the org is told it is near the allowance once usage reaches
   * this percentage of it, from 1 to 99. Defaults to {@link DEFAULT_WARN_AT_PERCENT}.
   */
  warnAtPercent?: number;
}

/** A metered item as registered: checked, frozen, with its meter key. */
export interface MeteredItem {
  readonly meterKey: string;
  readonly overage: OverageRule;
  readonly allowance: number;
  /** Set for `soft_cap`; `null` otherwise. */
  readonly providerMeter: string | null;
  /** Set for `warn`; `null` otherwise. */
  readonly warnAtPercent: number | null;
}

/** Stripe's meter event names allow letters, digits, `_`, `-`, `.` and `:`. */
const PROVIDER_METER_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check a plan's metered items and freeze them. Throws, naming the plan and
 * the item, on anything an app could get wrong: a meter nothing registers, a
 * rule that is not one, an allowance that is not a whole number, a soft cap
 * with no provider meter or on a plan with no price, a hard cap on AI spend,
 * or a meter the plan also gives a limit of its own.
 */
export function checkMeteredItems(
  planKey: string,
  raw: unknown,
  context: { priced: boolean; meterLimitKeys: readonly string[] }
): Readonly<Record<string, MeteredItem>> {
  if (raw === undefined) return Object.freeze({});
  if (!isRecord(raw)) throw new Error(`Plan "${planKey}" has meteredItems that is not an object`);
  const meterKeys = new Set(allMeters().map((m) => m.key));
  const items: Record<string, MeteredItem> = {};
  for (const [meterKey, value] of Object.entries(raw)) {
    const where = `Plan "${planKey}" metered item "${meterKey}"`;
    if (meterKey !== AI_SPEND_METER_KEY && !meterKeys.has(meterKey)) {
      throw new Error(
        `${where} names a meter nothing registers. Register it in lib/app/entitlements.ts, check the spelling, or use "${AI_SPEND_METER_KEY}" for AI spend`
      );
    }
    if (!isRecord(value)) throw new Error(`${where} must be an object`);
    const overage = value.overage;
    if (typeof overage !== 'string' || !OVERAGE_RULES.includes(overage as OverageRule)) {
      throw new Error(
        `${where} has overage ${JSON.stringify(overage)}; it must be ${OVERAGE_RULES.map((r) => `'${r}'`).join(', ')}`
      );
    }
    const rule = overage as OverageRule;
    const allowance = value.allowance;
    if (typeof allowance !== 'number' || !meterLimitSchema.safeParse(allowance).success) {
      throw new Error(
        `${where} has allowance ${JSON.stringify(allowance)}; it must be a whole number from 0 to 1,000,000,000`
      );
    }
    if (rule === 'warn' && allowance < 1) {
      // Zero would be "reached" at no usage at all, every period.
      throw new Error(`${where} warns at an allowance of 0; a warn allowance must be at least 1`);
    }
    if (context.meterLimitKeys.includes(meterKey)) {
      throw new Error(
        `${where} is also in the plan's meterLimits; the allowance is the item's alone (a hard cap writes it as the limit)`
      );
    }
    if (rule === 'hard_cap' && meterKey === AI_SPEND_METER_KEY) {
      throw new Error(
        `${where} hard-caps AI spend; cap it with the plan's aiBudgetUsd instead, which the AI calls already enforce`
      );
    }
    let providerMeter: string | null = null;
    if (rule === 'soft_cap') {
      const named = value.providerMeter;
      if (typeof named !== 'string' || !PROVIDER_METER_PATTERN.test(named)) {
        throw new Error(
          `${where} has providerMeter ${JSON.stringify(named)}; a soft cap needs the provider's meter name: letters, digits and _ . : -, at most 100 characters`
        );
      }
      if (!context.priced) {
        throw new Error(
          `${where} is a soft cap on a plan with no priceLookupKey; only a plan paid through the provider can be billed for its excess`
        );
      }
      providerMeter = named;
    }

    let warnAtPercent: number | null = null;
    if (rule === 'warn') {
      const pct = value.warnAtPercent ?? DEFAULT_WARN_AT_PERCENT;
      if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 1 || pct > 99) {
        throw new Error(
          `${where} has warnAtPercent ${JSON.stringify(pct)}; it must be a whole number from 1 to 99`
        );
      }
      warnAtPercent = pct;
    }

    items[meterKey] = Object.freeze({
      meterKey,
      overage: rule,
      allowance,
      providerMeter,
      warnAtPercent,
    });
  }
  return Object.freeze(items);
}

/**
 * The meter limits a plan's metered items write: a hard cap's allowance as
 * the limit; no limit for warn and soft cap, so the meter never refuses what
 * they allow. AI spend has no meter limit, so it writes nothing.
 */
export function meteredItemLimits(
  items: Readonly<Record<string, MeteredItem>>
): Record<string, number | null> {
  const limits: Record<string, number | null> = {};
  for (const item of Object.values(items)) {
    if (item.meterKey === AI_SPEND_METER_KEY) continue;
    limits[item.meterKey] = item.overage === 'hard_cap' ? item.allowance : null;
  }
  return limits;
}

/** Where usage stands against a metered item's allowance. */
export type AllowanceState = 'within' | 'near' | 'reached';

/**
 * `reached` at or past the allowance; `near` from a warn item's threshold;
 * `within` otherwise. A soft or hard cap has no "near". A soft cap is
 * `reached` only past its allowance, where there is an excess to bill: at it,
 * nothing is billed, and an allowance of 0 (purely usage-based) is not
 * "billed" at no use.
 */
export function allowanceState(item: MeteredItem, used: number): AllowanceState {
  if (item.overage === 'soft_cap') return excessOver(item, used) > 0 ? 'reached' : 'within';
  if (used >= item.allowance) return 'reached';
  if (item.warnAtPercent !== null && used * 100 >= item.allowance * item.warnAtPercent) {
    return 'near';
  }
  return 'within';
}

/** The excess a soft cap reports: what was used past the allowance. */
export function excessOver(item: Pick<MeteredItem, 'allowance'>, used: number): number {
  return Math.max(0, used - item.allowance);
}

/** What a `warn` item's notice says, as a handler receives it. */
export interface UsageNotice {
  orgId: string;
  planKey: string;
  meterKey: string;
  /** The meter's label, or "AI spend" for {@link AI_SPEND_METER_KEY}. */
  label: string;
  /** `near`: past the warn threshold. `reached`: at or past the allowance. */
  threshold: 'near' | 'reached';
  used: number;
  allowance: number;
  /** The window counted in: the billing period, or the meter's own window. */
  periodStart: Date;
  periodEnd: Date | null;
}

/** Tells the org a warn item is near or at its allowance. */
export type UsageNoticeHandler = (notice: UsageNotice) => void | Promise<void>;

const handlerSlot: { handler: UsageNoticeHandler | null } = { handler: null };

/**
 * Decide how an org is told it is near or at a `warn` item's allowance. Call
 * from `initAppBilling()` in `lib/app/billing.ts`; a later call replaces it.
 * With none set the platform emails the org's owners. A handler that throws
 * is retried on a later maintenance run; one that returns has told the org,
 * and that notice is not sent again for the period. It runs as the org
 * (`runAsOrg`), so what it reads and writes is confined to that org. To send
 * nothing, set a handler that does nothing; the billing page still shows the
 * state.
 */
export function setUsageNoticeHandler(handler: UsageNoticeHandler): void {
  if (typeof handler !== 'function') {
    throw new Error('setUsageNoticeHandler takes a function');
  }
  handlerSlot.handler = handler;
}

/** The registry's slot, for the billing init gate's snapshot and the notices job. */
export function usageNoticeHandlerSlot(): { handler: UsageNoticeHandler | null } {
  return handlerSlot;
}
