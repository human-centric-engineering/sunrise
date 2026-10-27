'use client';

/**
 * PlatformBindingOwner — who decides a platform agent's provider and model
 * (t-818).
 *
 * Shown on the agent form's Model tab for a platform agent whose definition
 * picks its own binding (in core, the clean-up agent; `platformAgent
 * .picksOwnBinding` from `GET /agents/:id`). While the platform owns the
 * binding (`AiAgent.bindingOwner`, t-798) it keeps the agent on the strongest
 * model the org can reach and moves it when that changes. Once an admin sets
 * provider or model, the binding is the org's and the platform stops moving
 * it; this is where they hand it back, with `PATCH { bindingOwner: 'platform' }`.
 * The API tries to reconcile the org before it responds, and returns the row
 * as it then stands, which `onHandedBack` is given: on the platform's pick, or,
 * if the platform could not pick just then, where it was, until the next
 * maintenance pass moves it.
 *
 * The hand-back is offered only with nothing unsaved on the form. The API
 * refuses a hand-back that also changes provider or model, and the form
 * re-seeds itself from the row afterwards, which would make any other
 * unsaved edit look saved.
 *
 * @see .context/orchestration/platform-agents.md — "What an org's admin can change"
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface PlatformBindingOwnerProps {
  agentId: string;
  /** `AiAgent.bindingOwner`: `'platform'`, `'org'`, or `null` while unclassified. */
  bindingOwner: string | null;
  /** The form has unsaved changes, so the hand-back is not offered yet. */
  hasUnsavedChanges: boolean;
  /** Called after a successful hand-back with the row's provider and model as they now stand. */
  onHandedBack: (agent: { provider: string; model: string }) => void;
}

export function PlatformBindingOwner({
  agentId,
  bindingOwner,
  hasUnsavedChanges,
  onHandedBack,
}: PlatformBindingOwnerProps) {
  const [handingBack, setHandingBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const platformDecides = bindingOwner === 'platform';

  async function handBack() {
    setHandingBack(true);
    setError(null);
    try {
      const agent = await apiClient.patch<{ provider: string; model: string }>(
        API.ADMIN.ORCHESTRATION.agentById(agentId),
        { body: { bindingOwner: 'platform' } }
      );
      onHandedBack(agent);
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not hand the provider and model back. Try again in a moment.'
      );
    } finally {
      setHandingBack(false);
    }
  }

  return (
    <div
      data-testid="platform-binding-owner"
      className="bg-muted/40 space-y-2 rounded-md border p-3 text-sm"
    >
      <p className="flex items-center gap-1 font-medium">
        Who picks the provider and model{' '}
        <FieldHelp title="Who picks the provider and model">
          While the platform picks them, it keeps this agent on the strongest tool-using model this
          organisation can reach, and moves it when that changes. Saving your own provider or model
          makes them this organisation&apos;s, and the platform leaves them alone. &ldquo;Let the
          platform choose&rdquo; hands them back: the agent moves at once, or on the next
          maintenance pass if the platform can&apos;t pick just then.
        </FieldHelp>
      </p>
      {platformDecides ? (
        <p data-testid="binding-owner-platform" className="text-muted-foreground">
          The platform picks them: the strongest model this organisation can reach. Choosing a
          provider or model below and saving makes them this organisation&apos;s.
        </p>
      ) : (
        <>
          <p data-testid="binding-owner-org" className="text-muted-foreground">
            {bindingOwner === 'org'
              ? 'Set by this organisation. The platform no longer moves them.'
              : 'Not yet decided. The platform settles this on its next maintenance pass.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={hasUnsavedChanges || handingBack}
              onClick={() => void handBack()}
            >
              {handingBack && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Let the platform choose
            </Button>
            {hasUnsavedChanges && (
              <span data-testid="binding-owner-unsaved" className="text-muted-foreground text-xs">
                Save your changes first.
              </span>
            )}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
