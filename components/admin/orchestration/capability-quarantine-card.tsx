'use client';

/**
 * CapabilityQuarantineCard
 *
 * Incident-response control on the capability detail page. Two states:
 *
 * - Active: shows mode/reason/expiry fields and a Quarantine button.
 *   Clicking opens a confirmation dialog naming every agent that binds
 *   this capability so admins see the blast radius before they confirm.
 *
 * - Quarantined: shows the current mode, reason, when it started, and
 *   optional expiry. A "Lift quarantine" button restores normal dispatch.
 *
 * Submits to POST /capabilities/[id]/{quarantine,unquarantine}. Save
 * scope is independent of the parent CapabilityForm — quarantine is
 * incident response, not a routine edit, and bundling it would let an
 * admin accidentally quarantine while saving an unrelated typo fix.
 *
 * Help copy follows the contextual-help directive in `.context/ui/contextual-help.md`.
 */

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ShieldOff, ShieldCheck } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

type QuarantineMode = 'quarantined-soft' | 'quarantined-hard';

export interface QuarantineCapabilityState {
  /** Stored state, not the read-time-effective state. */
  quarantineState: 'active' | QuarantineMode;
  quarantineReason: string | null;
  /** ISO 8601 timestamp (or null for indefinite). */
  quarantineUntil: string | null;
}

export interface QuarantineCapabilityCardProps {
  capabilityId: string;
  capabilityName: string;
  state: QuarantineCapabilityState;
  /** Agents currently binding this capability — drives the confirmation blast-radius copy. */
  affectedAgents: Array<{ id: string; name: string; slug: string }>;
}

const MODE_LABELS: Record<QuarantineMode, string> = {
  'quarantined-soft': 'Soft — agent sees "unavailable", can try a different approach',
  'quarantined-hard': 'Hard — agent cannot call the tool at all',
};

const MAX_REASON_LENGTH = 500;

export function CapabilityQuarantineCard({
  capabilityId,
  capabilityName,
  state,
  affectedAgents,
}: QuarantineCapabilityCardProps): React.ReactElement {
  const isQuarantined = state.quarantineState !== 'active';
  return isQuarantined ? (
    <QuarantinedView
      capabilityId={capabilityId}
      capabilityName={capabilityName}
      state={state}
      affectedAgents={affectedAgents}
    />
  ) : (
    <ActiveView
      capabilityId={capabilityId}
      capabilityName={capabilityName}
      affectedAgents={affectedAgents}
    />
  );
}

// ─── Active view (no quarantine in place) ──────────────────────────────────

function ActiveView({
  capabilityId,
  capabilityName,
  affectedAgents,
}: {
  capabilityId: string;
  capabilityName: string;
  affectedAgents: QuarantineCapabilityCardProps['affectedAgents'];
}): React.ReactElement {
  const [mode, setMode] = React.useState<QuarantineMode>('quarantined-soft');
  const [reason, setReason] = React.useState('');
  const [expiresAt, setExpiresAt] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  function validate(): string | null {
    if (reason.trim().length === 0) return 'Add a reason. It will appear in the audit log.';
    if (reason.length > MAX_REASON_LENGTH)
      return `Reason is too long (${reason.length}/${MAX_REASON_LENGTH}).`;
    if (expiresAt) {
      const ts = Date.parse(expiresAt);
      if (Number.isNaN(ts) || ts <= Date.now()) {
        return 'Auto-lift time must be in the future. Leave blank for no auto-lift.';
      }
    }
    return null;
  }

  function openConfirm(): void {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setConfirmOpen(true);
  }

  async function submit(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.capabilityQuarantine(capabilityId), {
        body: {
          mode,
          reason: reason.trim(),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        },
      });
      // Hard reload so the page-level server fetch re-reads the
      // quarantined state and re-renders QuarantinedView. Simpler than
      // threading new state up through the parent server component.
      window.location.reload();
    } catch (e) {
      setError(e instanceof APIClientError ? e.message : 'Failed to quarantine capability');
      setSaving(false);
      setConfirmOpen(false);
    }
  }

  return (
    <Card className="border-amber-200 dark:border-amber-900/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden />
          Emergency disable (quarantine)
          <FieldHelp title="What is quarantine?">
            <p>
              Quarantine is for incidents — a vendor API has gone down, a tool is sending wrong
              data, you need every agent to stop calling it now. The audit log records quarantine
              separately from routine deactivation so post-incident review can find the response
              window.
            </p>
            <p className="mt-2">
              For routine deactivation (deprecating a tool, beta-gating one) use the existing{' '}
              <strong>Active</strong> toggle in the form below instead.
            </p>
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="space-y-1">
          <Label htmlFor="quarantine-mode" className="flex items-center gap-1 text-xs">
            Mode
            <FieldHelp title="Soft vs hard">
              <p>
                <strong>Soft:</strong> the agent gets a structured &quot;tool unavailable&quot;
                error. It can try a different approach. Use this when the tool is missing but not
                wrong — a vendor outage, a rate-limit storm.
              </p>
              <p className="mt-2">
                <strong>Hard:</strong> the agent cannot call the tool at all and the model&apos;s
                tool loop stops. Use this when the tool is sending wrong data and you don&apos;t
                want the agent to retry.
              </p>
            </FieldHelp>
          </Label>
          <Select value={mode} onValueChange={(v) => setMode(v as QuarantineMode)}>
            <SelectTrigger id="quarantine-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="quarantined-soft">{MODE_LABELS['quarantined-soft']}</SelectItem>
              <SelectItem value="quarantined-hard">{MODE_LABELS['quarantined-hard']}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="quarantine-reason" className="flex items-center gap-1 text-xs">
            Reason
            <FieldHelp title="What goes in the reason?">
              <p>
                A short note explaining why. Goes into the audit log, the hook event payload, and
                the banner shown on every agent that binds this tool.
              </p>
              <p className="mt-2">
                Good examples: &quot;Stripe charges returning 500s since 14:32 UTC&quot;, &quot;Tool
                returning wrong city names — investigating geocoding endpoint&quot;.
              </p>
            </FieldHelp>
          </Label>
          <Textarea
            id="quarantine-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={MAX_REASON_LENGTH}
            placeholder="e.g. Stripe charges returning 500s since 14:32 UTC"
            rows={3}
          />
          <p className="text-muted-foreground text-right text-[10px]">
            {reason.length}/{MAX_REASON_LENGTH}
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="quarantine-expires" className="flex items-center gap-1 text-xs">
            Auto-lift at (optional)
            <FieldHelp title="Auto-lift">
              <p>
                A future timestamp. The dispatcher treats the capability as active once this time
                passes — no need to remember to lift the quarantine manually.
              </p>
              <p className="mt-2">
                Leave blank for indefinite. The stored state is preserved either way; an explicit{' '}
                <strong>Lift quarantine</strong> click also clears all three fields.
              </p>
            </FieldHelp>
          </Label>
          <Input
            id="quarantine-expires"
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">
            Will affect{' '}
            <strong>
              {affectedAgents.length} agent{affectedAgents.length === 1 ? '' : 's'}
            </strong>{' '}
            currently using this capability.
          </p>
          <Button
            type="button"
            variant="destructive"
            onClick={openConfirm}
            disabled={saving || reason.trim().length === 0}
          >
            <ShieldOff className="mr-1 h-3 w-3" />
            Quarantine
          </Button>
        </div>
      </CardContent>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Quarantine &ldquo;{capabilityName}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              {mode === 'quarantined-hard'
                ? 'Hard mode: every agent will stop calling this tool. The model will not retry.'
                : 'Soft mode: every agent will see a tool-unavailable error and can route around it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {affectedAgents.length > 0 && (
            <div className="rounded-md border border-amber-500/50 bg-amber-50 p-3 text-xs dark:bg-amber-950/30">
              <p className="mb-2 font-medium">
                {affectedAgents.length} agent{affectedAgents.length === 1 ? '' : 's'} affected:
              </p>
              <ul className="space-y-0.5 pl-4">
                {affectedAgents.slice(0, 8).map((a) => (
                  <li key={a.id} className="list-disc">
                    {a.name}{' '}
                    <span className="text-muted-foreground font-mono text-[11px]">({a.slug})</span>
                  </li>
                ))}
                {affectedAgents.length > 8 && (
                  <li className="text-muted-foreground list-disc">
                    …and {affectedAgents.length - 8} more
                  </li>
                )}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void submit()} disabled={saving}>
              {saving ? 'Quarantining…' : 'Confirm quarantine'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ─── Quarantined view ──────────────────────────────────────────────────────

function QuarantinedView({
  capabilityId,
  state,
  affectedAgents,
}: {
  capabilityId: string;
  capabilityName: string;
  state: QuarantineCapabilityState;
  affectedAgents: QuarantineCapabilityCardProps['affectedAgents'];
}): React.ReactElement {
  const [lifting, setLifting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Snapshot 'now' once per mount so the expiry-has-passed check is a
  // pure render. React 19's react-hooks/purity rule disallows Date.now()
  // mid-render; useState lazy init is allowed.
  const [renderedAt] = React.useState<number>(() => Date.now());

  const expiry = state.quarantineUntil ? new Date(state.quarantineUntil) : null;
  const expiryHasPassed = expiry !== null && expiry.getTime() <= renderedAt;
  const mode = state.quarantineState as QuarantineMode;

  async function lift(): Promise<void> {
    setLifting(true);
    setError(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.capabilityUnquarantine(capabilityId), {});
      window.location.reload();
    } catch (e) {
      setError(e instanceof APIClientError ? e.message : 'Failed to lift quarantine');
      setLifting(false);
    }
  }

  return (
    <Card className="border-red-300 bg-red-50/30 dark:border-red-900/60 dark:bg-red-950/10">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden />
          Quarantined
          <Badge variant={mode === 'quarantined-hard' ? 'destructive' : 'secondary'}>
            {mode === 'quarantined-hard' ? 'Hard' : 'Soft'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && (
          <p className="text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        {state.quarantineReason && (
          <div>
            <p className="text-muted-foreground text-xs">Reason</p>
            <p>{state.quarantineReason}</p>
          </div>
        )}

        {expiry && (
          <div className="text-xs">
            <p className="text-muted-foreground">Auto-lift {expiryHasPassed ? 'was' : ''}</p>
            <p>{expiry.toLocaleString()}</p>
            {expiryHasPassed && (
              <p className="text-amber-700 dark:text-amber-300">
                Already in the past — dispatcher is treating this as active. Lifting now clears the
                stored fields too.
              </p>
            )}
          </div>
        )}

        <AffectedAgentsPopover affectedAgents={affectedAgents} />

        <Button
          type="button"
          variant="outline"
          onClick={() => void lift()}
          disabled={lifting}
          className="w-full sm:w-auto"
        >
          <ShieldCheck className="mr-1 h-3 w-3" />
          {lifting ? 'Lifting…' : 'Lift quarantine'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Shared: clickable count + popover listing affected agents ─────────────

/**
 * Renders "N agents affected" as a clickable button. Click opens a
 * popover listing every affected agent with a link to its detail page.
 * Mirrors the "agents using this capability" Popover pattern from
 * capabilities-table.tsx so admins encounter one consistent affordance
 * across the orchestration surfaces.
 */
function AffectedAgentsPopover({
  affectedAgents,
}: {
  affectedAgents: QuarantineCapabilityCardProps['affectedAgents'];
}): React.ReactElement {
  const count = affectedAgents.length;
  if (count === 0) {
    return (
      <p className="text-muted-foreground text-xs">No agents currently use this capability.</p>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        >
          {count} agent{count === 1 ? '' : 's'} affected →
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="border-b px-3 py-2">
          <p className="text-sm font-medium">
            {count} agent{count === 1 ? '' : 's'} affected
          </p>
        </div>
        <ul className="max-h-64 overflow-y-auto py-1">
          {affectedAgents.map((agent) => (
            <li key={agent.id}>
              <Link
                href={`/admin/orchestration/agents/${agent.id}`}
                className="hover:bg-muted flex items-center gap-2 px-3 py-1.5 text-sm transition-colors"
              >
                <span className="truncate">{agent.name}</span>
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
                  {agent.slug}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
