/**
 * Write a plan to an org (§139 t-1093): its switches, meter limits and AI
 * budget, each through the writer that owns it, and only what the plan
 * decides.
 *
 * **Idempotent.** Each writer compares with what is stored and writes nothing
 * when it already matches, so re-applying a plan writes nothing and reports
 * `changed: false`. A staff re-assign relies on that to heal a write that did
 * not finish, and t-1094's webhook relies on it so a replayed event is a
 * no-op rather than a fresh audit row.
 *
 * **Three writes, not one transaction.** The switches, limits and caps are
 * separate slices of `Org.settings`, each written by its own serializable
 * transaction. A failure part-way leaves some applied; applying again
 * finishes it, which is why the subscription record's `planAppliedAt` is set
 * only after this returns.
 *
 * It decides nothing about who may: the route asks
 * `mayChangeOrgCommercialSettings()`, and the webhook acts as no person.
 *
 * @see lib/billing/plans.ts — the registry
 * @see .context/billing/billing.md#plans
 */

import type { RegisteredPlan } from '@/lib/billing/plans';
import { forgetOrgCap } from '@/lib/orchestration/llm/spend-caps';
import { setOrgSwitches } from '@/lib/tenancy/entitlements';
import { updateOrgQuotas, writeOrgMeterLimits } from '@/lib/tenancy/org-settings';

/** One slice a plan wrote: what was stored before and after. */
export interface AppliedChange<T> {
  from: T;
  to: T;
}

/** What applying a plan changed. A slice is `null` when nothing in it changed. */
export interface PlanApplied {
  changed: boolean;
  /** The org's stored switch slice, before and after. */
  switches: AppliedChange<unknown> | null;
  /** The org's meter limits, before and after (as stored). */
  meterLimits: AppliedChange<unknown> | null;
  /** The org's monthly AI budget in dollars, `null` for no cap of its own. */
  aiBudgetUsd: AppliedChange<number | null> | null;
}

/**
 * Apply `plan` to `orgId`. Throws what the writers throw: a `P2034` clash
 * with a concurrent settings write (`isSettingsWriteConflict`), or the
 * switches writer's refusal while the app's switches failed to register.
 * Nothing it already wrote is undone; applying again finishes it.
 *
 * @returns what changed, or `null` when the org does not exist.
 */
export async function applyPlan(orgId: string, plan: RegisteredPlan): Promise<PlanApplied | null> {
  const result: PlanApplied = {
    changed: false,
    switches: null,
    meterLimits: null,
    aiBudgetUsd: null,
  };

  const switchEntries = Object.entries(plan.switches);
  if (switchEntries.length > 0) {
    const written = await setOrgSwitches(orgId, {
      on: switchEntries.filter(([, on]) => on).map(([key]) => key),
      off: switchEntries.filter(([, on]) => !on).map(([key]) => key),
    });
    if (written === null) return null;
    if (written.changed) {
      result.switches = {
        from: written.previousStored,
        to: { on: written.stored.on, off: written.stored.off },
      };
    }
  }

  if (Object.keys(plan.meterLimits).length > 0) {
    const written = await writeOrgMeterLimits(orgId, plan.meterLimits);
    if (written === null) return null;
    if (written.changed) {
      result.meterLimits = {
        from: written.previousStored,
        to: Object.keys(written.stored).length === 0 ? null : written.stored,
      };
    }
  }

  if (plan.aiBudgetUsd !== undefined) {
    const written = await updateOrgQuotas(orgId, { monthlyBudgetUsd: plan.aiBudgetUsd });
    if (written === null) return null;
    if (written.changed) {
      // So this process enforces the new budget at once; the others pick it
      // up within the cache's TTL, as for any caps write.
      forgetOrgCap(orgId);
      result.aiBudgetUsd = {
        from: written.previous.monthlyBudgetUsd ?? null,
        to: written.stored.monthlyBudgetUsd ?? null,
      };
    }
  }

  result.changed =
    result.switches !== null || result.meterLimits !== null || result.aiBudgetUsd !== null;
  return result;
}
