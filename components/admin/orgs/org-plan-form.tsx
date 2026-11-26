'use client';

/**
 * OrgPlanForm — which plan an org is on, assigned by hand (§139 t-1093)
 *
 * The admin UI for `/api/v1/admin/orgs/[id]/plan`. Each plan the app
 * registers is listed with what it decides; a platform admin picks one and
 * saves, and the plan's switches, limits and AI budget are written to the
 * org. The page is then refreshed, so the Entitlements and Limits sections
 * below show what the plan wrote.
 *
 * What it says rather than hides:
 *  - **Not fully applied**: the record names a plan whose write did not
 *    finish. Saving the same plan again finishes it.
 *  - **Paid through a provider**: the plan follows that subscription and
 *    cannot be changed here.
 *  - **Cannot change here**: at `multi`, from a customer's org, the plan is
 *    shown but can only be changed from the install organisation.
 *  - **Registration failed**: the app's plans could not be registered.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import { SaveError } from '@/components/forms/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** `GET /api/v1/admin/orgs/[id]/plan`, as the route reports it (dates as ISO strings). */
export interface OrgPlanView {
  orgId: string;
  enabled: boolean;
  multiTenant: boolean;
  registrationFailed: boolean;
  mayChange: boolean;
  plans: {
    key: string;
    label: string;
    description: string;
    priced: boolean;
    switches: Record<string, boolean>;
    meterLimits: Record<string, number | null>;
    aiBudgetUsd: number | null;
    decidesAiBudget: boolean;
  }[];
  fallbackPlanKey: string | null;
  subscription: {
    planKey: string | null;
    provider: string | null;
    providerManaged: boolean;
    status: string;
    planAppliedAt: string | null;
    updatedAt: string;
  } | null;
}

export interface OrgPlanFormProps {
  orgId: string;
  plan: OrgPlanView;
}

/** The radio value for "no plan". Not a plan key: keys start with a letter. */
const NO_PLAN = '';

/** Why the plan is read-only from a customer's org, for the shared notice. */
const PLAN_READ_ONLY =
  'An organisation’s plan can only be changed from the install organisation, so that no organisation can choose its own.';

type Plan = OrgPlanView['plans'][number];

/** What a plan decides, in a line: "reports on, leads off · seats 25 · AI budget $100". */
function summary(plan: Plan): string {
  const parts: string[] = [];
  const switches = Object.entries(plan.switches);
  if (switches.length > 0) {
    parts.push(switches.map(([key, on]) => `${key} ${on ? 'on' : 'off'}`).join(', '));
  }
  const limits = Object.entries(plan.meterLimits);
  if (limits.length > 0) {
    parts.push(
      limits.map(([key, limit]) => `${key} ${limit === null ? 'no limit' : limit}`).join(', ')
    );
  }
  if (plan.decidesAiBudget) {
    parts.push(plan.aiBudgetUsd === null ? 'no AI budget cap' : `AI budget $${plan.aiBudgetUsd}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Decides nothing';
}

export function OrgPlanForm({ orgId, plan: initial }: OrgPlanFormProps) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const current = view.subscription?.planKey ?? NO_PLAN;
  const [chosen, setChosen] = useState(current);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const saveFailure = useSaveFailure({
    fallback: 'Could not assign the plan',
    fields: NO_SERVER_FIELDS,
  });

  const subscription = view.subscription;
  // Only a plan staff can save again: a provider's record is not theirs to finish.
  const unfinished =
    subscription !== null &&
    subscription.planKey !== null &&
    !subscription.providerManaged &&
    subscription.planAppliedAt === null;
  // A key the app no longer registers: no option shows it, so say it here.
  const unregisteredPlan =
    subscription?.planKey && !view.plans.some((p) => p.key === subscription.planKey)
      ? subscription.planKey
      : null;
  const locked = !view.mayChange || subscription?.providerManaged === true || !view.enabled;
  // Saving the current plan again is how an unfinished write is finished.
  const canSave = chosen !== current || (unfinished && chosen !== NO_PLAN);

  const save = async () => {
    saveFailure.clear();
    setSaving(true);
    setDone(null);
    try {
      const updated = await apiClient.patch<OrgPlanView>(API.ADMIN.orgPlan(orgId), {
        body: { planKey: chosen === NO_PLAN ? null : chosen },
      });
      setView(updated);
      setChosen(updated.subscription?.planKey ?? NO_PLAN);
      setDone(chosen === NO_PLAN ? 'Plan removed' : 'Plan assigned');
      // The switches, limits and budget sections read what the plan wrote.
      router.refresh();
    } catch (err) {
      saveFailure.report(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {view.registrationFailed && (
        <p className="text-destructive text-sm">
          The app&apos;s plans could not be registered, so none can be assigned. The server log says
          why.
        </p>
      )}
      {!view.registrationFailed && !view.multiTenant && (
        <p className="text-muted-foreground text-sm">
          Plans apply only when the install runs with <code>TENANCY_MODE=multi</code>.
        </p>
      )}
      {!view.mayChange && <SharedSettingsReadOnlyNotice reason={PLAN_READ_ONLY} />}
      {subscription?.providerManaged && (
        <p className="text-muted-foreground text-sm">
          This organisation pays for its plan through {subscription.provider}, so its plan follows
          that subscription and cannot be changed here.
        </p>
      )}
      {unregisteredPlan && (
        <p className="text-muted-foreground text-sm">
          This organisation is on <span className="font-mono">{unregisteredPlan}</span>, which the
          app no longer registers. Its switches, limits and budget stay as that plan left them until
          another plan is assigned.
        </p>
      )}
      {unfinished && !unregisteredPlan && (
        <p className="text-destructive text-sm">
          The plan&apos;s settings were not all written to this organisation. Save the plan again to
          finish.
        </p>
      )}

      <fieldset className="grid gap-2" disabled={saving || locked}>
        <legend className="mb-2 text-sm font-medium">
          Plan{' '}
          <FieldHelp title="Plan">
            <p>
              A plan is a set of switches, limits and an AI budget that the app defines. Assigning
              one writes what the plan decides to this organisation, replacing those values in the
              Entitlements and Limits sections. Anything the plan does not mention is left as it is.
            </p>
            <p className="mt-2">
              Choosing &ldquo;No plan&rdquo; stops naming a plan and leaves the switches, limits and
              budget as they are. Its own admins cannot change this.
            </p>
          </FieldHelp>
        </legend>
        <div className="divide-y rounded-md border">
          <label className="flex cursor-pointer items-start gap-3 p-3 text-sm">
            <input
              type="radio"
              name="plan"
              className="mt-1"
              value={NO_PLAN}
              checked={chosen === NO_PLAN}
              onChange={() => {
                setDone(null);
                setChosen(NO_PLAN);
              }}
            />
            <span>
              No plan
              <span className="text-muted-foreground block text-xs">
                Switches, limits and budget are set by hand.
              </span>
            </span>
          </label>
          {view.plans.map((plan) => (
            <label key={plan.key} className="flex cursor-pointer items-start gap-3 p-3 text-sm">
              <input
                type="radio"
                name="plan"
                className="mt-1"
                value={plan.key}
                checked={chosen === plan.key}
                onChange={() => {
                  setDone(null);
                  setChosen(plan.key);
                }}
              />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  {plan.label}
                  <span className="text-muted-foreground font-mono text-xs">{plan.key}</span>
                  {current === plan.key && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      current
                    </Badge>
                  )}
                  {view.fallbackPlanKey === plan.key && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      fallback
                    </Badge>
                  )}
                  {plan.priced && (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                      paid
                    </Badge>
                  )}
                </span>
                {plan.description && (
                  <span className="text-muted-foreground block text-xs">{plan.description}</span>
                )}
                <span className="block text-xs" data-testid={`plan-summary-${plan.key}`}>
                  {summary(plan)}
                </span>
              </span>
            </label>
          ))}
        </div>
        {subscription?.planAppliedAt && (
          <p className="text-muted-foreground text-xs">
            Last applied <ClientDate date={subscription.planAppliedAt} showTime />.
          </p>
        )}
      </fieldset>

      {!locked && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={saving || !canSave}>
              {saving ? 'Saving…' : 'Save plan'}
            </Button>
            {done && <span className="text-sm text-green-600">{done}</span>}
          </div>
          <SaveError failure={saveFailure.failure} />
        </div>
      )}
    </div>
  );
}
