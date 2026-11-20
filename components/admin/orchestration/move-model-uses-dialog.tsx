'use client';

/**
 * MoveModelUsesDialog (§136 t-1066)
 *
 * On a provider model's page: move everything that uses the model to a
 * replacement on the same provider, in one action. The dialog previews the
 * move (`POST …/move-uses/preview`) for the chosen replacement, then runs it
 * (`POST …/move-uses`) and shows what happened, org by org: moved, skipped
 * (an org whose own key failed its test against the replacement) or failed
 * (its changes rolled back), and what was left and why.
 *
 * Other orgs' uses are counts: the dialog names the org, never its agents or
 * workflows. Hidden from anyone who cannot change shared settings, as the
 * move writes the install's settings.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SaveError } from '@/components/forms/form-error';
import { useSharedSettingsReadOnly } from '@/components/admin/shared-settings-access';
import type { ReplacementOption } from '@/components/admin/orchestration/provider-model-form';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import {
  LEFT_REASON_TEXT,
  type LeftReason,
  type SettingsMovePlan,
} from '@/lib/orchestration/model-lifecycle/move-plan';
import type { SettingsPinSlot } from '@/lib/orchestration/model-lifecycle/settings-pins';

interface LeftStep {
  workflowId: string;
  stepId: string;
  reason: LeftReason;
}

/** One org in the preview, as the route answers it. */
export interface OrgPreview {
  orgId: string;
  name: string;
  agents: number;
  inactiveAgents: number;
  workflows: number;
  left: LeftStep[];
  ownKey: boolean;
}

export interface MovePreview {
  replacement: { id: string; name: string; modelId: string };
  orgs: OrgPreview[];
  settings: SettingsMovePlan;
  suspendedOrgs: number;
}

/** One org in the result. */
export interface OrgResult {
  orgId: string;
  name: string;
  status: 'moved' | 'skipped' | 'failed';
  reason?: string;
  agents: number;
  workflows: number;
  left: LeftStep[];
}

export interface MoveResult {
  replacement: { id: string; name: string; modelId: string };
  orgs: OrgResult[];
  settings: SettingsMovePlan;
  suspendedOrgs: number;
  totals: { agents: number; workflows: number; settings: number; skipped: number; failed: number };
}

const SLOT_LABEL: Record<SettingsPinSlot, string> = {
  routing: 'Default model for routing',
  chat: 'Default model for chat',
  reasoning: 'Default model for reasoning',
  embeddings: 'Default model for embeddings',
  audio: 'Default model for audio',
  confidential: 'Model for confidential messages',
  active_embedding: 'Active embedding model',
};

const STATUS_LABEL: Record<OrgResult['status'], string> = {
  moved: 'Moved',
  skipped: 'Skipped',
  failed: 'Failed',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What was left in one org, grouped by reason. */
function LeftList({ left }: { left: LeftStep[] }) {
  if (left.length === 0) return null;
  const byReason = new Map<LeftReason, number>();
  for (const step of left) byReason.set(step.reason, (byReason.get(step.reason) ?? 0) + 1);
  return (
    <ul className="text-muted-foreground mt-1 space-y-1 text-xs">
      {[...byReason].map(([reason, count]) => (
        <li key={reason}>
          {plural(count, 'workflow step')} left: {LEFT_REASON_TEXT[reason]}
        </li>
      ))}
    </ul>
  );
}

function SettingsList({ settings, done }: { settings: SettingsMovePlan; done: boolean }) {
  if (settings.moved.length + settings.left.length === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-muted-foreground text-xs font-medium uppercase">Settings</h3>
      <ul className="space-y-1 text-sm">
        {settings.moved.map((slot) => (
          <li key={slot.slot}>
            {SLOT_LABEL[slot.slot]}: {done ? 'moved' : 'moves'}
            {slot.source === 'suggested' && (
              <span className="text-muted-foreground">
                {' '}
                (the system&apos;s suggestion, saved as the replacement)
              </span>
            )}
          </li>
        ))}
        {settings.left.map((slot) => (
          <li key={slot.slot}>
            {SLOT_LABEL[slot.slot]}: left
            <p className="text-muted-foreground text-xs">{LEFT_REASON_TEXT[slot.reason]}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface MoveModelUsesDialogProps {
  /** The catalogue row id of the model whose uses move. */
  modelId: string;
  modelName: string;
  /** The same-provider models it may move to (the page's replacement options). */
  replacementOptions: ReplacementOption[];
  /** The stored replacement, chosen first when there is one. */
  replacementId: string | null;
  /**
   * Whether anything uses the model. When nothing does, the trigger is not
   * offered; an open dialog stays, since a move's own refresh makes this false
   * while its result is still to be read.
   */
  hasUses: boolean;
}

export function MoveModelUsesDialog({
  modelId,
  modelName,
  replacementOptions,
  replacementId,
  hasUses,
}: MoveModelUsesDialogProps) {
  const router = useRouter();
  const readOnly = useSharedSettingsReadOnly();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(replacementId ?? replacementOptions[0]?.id ?? '');
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const [result, setResult] = useState<MoveResult | null>(null);
  const failure = useSaveFailure({ fallback: 'The move could not be run. Try again.' });
  const { report, clear } = failure;

  const loadPreview = useCallback(
    async (replacement: string) => {
      if (!replacement) return;
      setLoading(true);
      setPreview(null);
      clear();
      try {
        const data = await apiClient.post<MovePreview>(
          API.ADMIN.ORCHESTRATION.providerModelMoveUsesPreview(modelId),
          { body: { replacementId: replacement } }
        );
        setPreview(data);
      } catch (err) {
        report(err, 'Couldn’t preview the move');
      } finally {
        setLoading(false);
      }
    },
    [modelId, report, clear]
  );

  const runMove = async () => {
    clear();
    setMoving(true);
    try {
      const data = await apiClient.post<MoveResult>(
        API.ADMIN.ORCHESTRATION.providerModelMoveUses(modelId),
        { body: { replacementId: chosen } }
      );
      setResult(data);
      router.refresh();
    } catch (err) {
      report(err);
    } finally {
      setMoving(false);
    }
  };

  const dialog = useCommittedDialog({
    open,
    pending: moving,
    onOpen: () => {
      setOpen(true);
      void loadPreview(chosen);
    },
    onClose: () => {
      setOpen(false);
      setPreview(null);
      setResult(null);
    },
    clear,
  });

  if (readOnly || replacementOptions.length === 0 || (!open && !hasUses)) return null;

  const nothingToMove =
    preview !== null &&
    preview.orgs.every((o) => o.agents + o.workflows === 0) &&
    preview.settings.moved.length === 0;

  return (
    <Dialog open={open} onOpenChange={dialog.onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Move uses…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Move everything that uses {modelName}</DialogTitle>
          <DialogDescription>
            Agents, workflows and settings in every organisation move to the replacement, on the
            same provider. Each agent gets a new version and each workflow a new published version,
            and every change is in the audit log.
          </DialogDescription>
        </DialogHeader>

        {!result && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="move-replacement" className="flex items-center text-xs">
                Replacement{' '}
                <FieldHelp title="Replacement">
                  A model on the same provider, turned on, not itself being retired, with every
                  capability this one has. Moving to another provider is a change made per agent in
                  the agent form, since it changes what each organisation may use and who pays.
                </FieldHelp>
              </Label>
              <Select
                value={chosen}
                onValueChange={(next) => {
                  setChosen(next);
                  void loadPreview(next);
                }}
                disabled={moving}
              >
                <SelectTrigger id="move-replacement">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent>
                  {replacementOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name} ({o.modelId})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {loading && <p className="text-muted-foreground text-sm">Working out what moves…</p>}

            {preview && (
              <div className="space-y-4">
                {preview.orgs.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No agent or workflow in any organisation uses this model.
                  </p>
                ) : (
                  <div className="space-y-1">
                    <h3 className="text-muted-foreground text-xs font-medium uppercase">
                      Organisations
                    </h3>
                    <ul className="space-y-2 text-sm">
                      {preview.orgs.map((org) => (
                        <li key={org.orgId}>
                          <span className="font-medium">{org.name}</span>:{' '}
                          {plural(org.agents, 'agent')}
                          {org.inactiveAgents > 0
                            ? ` (${org.inactiveAgents} turned off)`
                            : ''}, {plural(org.workflows, 'workflow')}
                          {org.ownKey && (
                            <p className="text-muted-foreground text-xs">
                              Uses its own key for this provider. The key is sent one short test
                              message to {preview.replacement.name} first, billed to it, and the
                              organisation is skipped if that fails.
                            </p>
                          )}
                          <LeftList left={org.left} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <SettingsList settings={preview.settings} done={false} />
                {preview.suspendedOrgs > 0 && (
                  <p className="text-muted-foreground text-xs">
                    {plural(preview.suspendedOrgs, 'suspended organisation')} not looked at: nothing
                    is changed in an organisation while it is suspended.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {result && (
          <div className="space-y-4" role="status">
            <p className="text-sm">
              Moved {plural(result.totals.agents, 'agent')},{' '}
              {plural(result.totals.workflows, 'workflow')} and{' '}
              {plural(result.totals.settings, 'setting')} to {result.replacement.name}.
              {result.totals.skipped > 0 &&
                ` ${plural(result.totals.skipped, 'organisation')} skipped.`}
              {result.totals.failed > 0 &&
                ` ${plural(result.totals.failed, 'organisation')} failed; run the move again for them.`}
            </p>
            {result.orgs.length > 0 && (
              <ul className="space-y-2 text-sm">
                {result.orgs.map((org) => (
                  <li key={org.orgId}>
                    <span className="font-medium">{org.name}</span>: {STATUS_LABEL[org.status]}
                    {org.status === 'moved' &&
                      ` (${plural(org.agents, 'agent')}, ${plural(org.workflows, 'workflow')})`}
                    {org.reason && <p className="text-muted-foreground text-xs">{org.reason}</p>}
                    <LeftList left={org.left} />
                  </li>
                ))}
              </ul>
            )}
            <SettingsList settings={result.settings} done />
          </div>
        )}

        <DialogFooter className="items-center gap-2">
          <SaveError failure={failure.failure} />
          {result ? (
            <Button onClick={() => dialog.onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => dialog.onOpenChange(false)}
                {...dialog.cancelProps}
              >
                Cancel
              </Button>
              <Button
                onClick={(e) => dialog.confirm(e, runMove)}
                {...dialog.actionProps({ disabled: !preview || loading || nothingToMove })}
              >
                {moving ? 'Moving…' : 'Move uses'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
