'use client';

/**
 * Setup Wizard
 *
 * Four-step config-oriented flow for developers setting up a fresh
 * Sunrise instance:
 *
 *   1. Configure a provider   — env-var detection cards (one-click) plus
 *                                a "Configure manually →" link out to
 *                                /providers/new for custom or self-hosted
 *                                endpoints.
 *   2. Confirm default models — chat + embedding model selectors written
 *                                to `AiOrchestrationSettings.defaultModels`.
 *   3. Smoke test              — `/providers/:id/test` followed by
 *                                `/providers/:id/test-model` against the
 *                                configured default chat model. Proves
 *                                the provider → API key → LLM chain
 *                                round-trips without touching agents or
 *                                the knowledge base.
 *   4. Done                    — links out to /agents/new, /knowledge,
 *                                and /workflows/new.
 *
 * Provider-agnostic: never assumes Anthropic. The 5 system-seeded agents
 * (pattern-advisor, quiz-master, mcp-system, model-auditor) ship with
 * empty `provider`/`model` and resolve dynamically through the operator's
 * choice — the wizard's only job is to wire the provider, set defaults,
 * and prove the chain works.
 *
 * Errors never throw out of the dialog. Fetch failures become friendly
 * inline messages — the raw `err.message` from a fetch is not forwarded
 * to the UI (could leak provider SDK internals). Detailed errors are
 * logged to the server via `logger.error` in the underlying API routes.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Loader2, X } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { useWizard } from '@/lib/hooks/use-wizard';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';

// Bumped v2 → v3 because the layout changed shape: 6 steps → 4 steps,
// agentDraft and createdAgentSlug removed from persisted state.
const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v3';
const TOTAL_STEPS = 4;

// Sunrise envelope shape for every wizard fetch. Every step validates
// the response through Zod before reading any field — the wizard runs
// against a freshly-installed instance whose admin endpoints could be
// proxied or version-skewed, and unvalidated `as` casts let bad shapes
// propagate silently into setState calls.
function envelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.boolean().optional(),
    data: dataSchema.optional(),
  });
}

const defaultModelsStoredSchema = z.object({
  defaultModelsStored: z.record(z.string(), z.string()).optional(),
});

const defaultModelsSchema = z.object({
  defaultModels: z.record(z.string(), z.string()).optional(),
});

const providerTestResultSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
});

const modelTestResultSchema = z.object({
  ok: z.boolean().optional(),
  latencyMs: z.number().optional(),
});

interface ProviderDraft {
  name: string;
  slug: string;
  apiKeyEnvVar: string;
  /** `providerType` value from KNOWN_PROVIDERS — anthropic, openai-compatible, voyage. */
  providerType: 'anthropic' | 'openai-compatible' | 'voyage' | '';
  /** Optional baseUrl (required for openai-compatible). */
  baseUrl: string;
  /** Suggested chat model id from the detection registry, written to settings on success. */
  suggestedDefaultChatModel: string;
  /** Suggested embedding model id, written to settings on success. */
  suggestedEmbeddingModel: string;
}

interface WizardState {
  stepIndex: number;
  providerDraft: ProviderDraft;
}

const DEFAULT_STATE: WizardState = {
  stepIndex: 0,
  providerDraft: {
    name: '',
    slug: '',
    apiKeyEnvVar: '',
    providerType: '',
    baseUrl: '',
    suggestedDefaultChatModel: '',
    suggestedEmbeddingModel: '',
  },
};

export interface SetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Triggered from the dashboard's fresh-install banner when no
   * provider has been configured yet. Currently informational —
   * Phase 4 will use it to skip the persisted "completed" marker so
   * the wizard re-opens until setup is genuinely done.
   */
  forceOpen?: boolean;
}

export function SetupWizard({ open, onOpenChange, forceOpen: _forceOpen }: SetupWizardProps) {
  const [state, setState, clearState] = useLocalStorage<WizardState>(STORAGE_KEY, DEFAULT_STATE);
  const wiz = useWizard({ totalSteps: TOTAL_STEPS, initialIndex: state.stepIndex });

  // Mirror `wiz.stepIndex` into persisted state when the user advances. Two
  // skips keep us out of trouble:
  //   1. The mount-time firing — at that point both indices are at their
  //      initial values, and writing would clobber the stored value before
  //      useLocalStorage's post-mount hydration has read it back.
  //   2. Already-in-sync cases — when `state.stepIndex` already matches
  //      `wiz.stepIndex` we skip the write. That handles the reconcile path
  //      (after hydration the next effect calls wiz.goTo to match state, and
  //      we don't want to round-trip that back) and the clearState-on-Finish
  //      path (clearState removes storage, then reconcile snaps wiz to 0,
  //      and this skip prevents us re-creating the row).
  const writeBackInitialisedRef = useRef(false);
  useEffect(() => {
    if (!writeBackInitialisedRef.current) {
      writeBackInitialisedRef.current = true;
      return;
    }
    if (wiz.stepIndex === state.stepIndex) return;
    setState((prev) => ({ ...prev, stepIndex: wiz.stepIndex }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiz.stepIndex]);

  // useLocalStorage starts with the default value at hydration time and reads
  // from storage in a post-mount effect — so `state.stepIndex` may flip from
  // its initial 0 to the stored value on the second render. `useWizard` locks
  // in its starting step from `state.stepIndex` once and ignores later
  // changes, so a divergence between the two strands them. Reconcile here:
  // whenever the persisted step disagrees with the wizard's current step,
  // sync the wizard. The other effect (`[wiz.stepIndex]`) handles the
  // reverse direction, so there's no loop — they only fire when their own
  // dependency actually changes.
  useEffect(() => {
    if (state.stepIndex !== wiz.stepIndex) {
      wiz.goTo(state.stepIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.stepIndex]);

  // Probe the backend once on open to auto-advance past completed steps.
  const [probed, setProbed] = useState(false);
  const [probingError, setProbingError] = useState<string | null>(null);

  // Latest state in a ref so the async probe closure below can read the
  // post-hydration step index rather than the closure-captured initial value.
  // (Adding `state.stepIndex` to the effect dep array would refire the probe
  // on every step change, which we don't want.)
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!open || probed) return;
    let cancelled = false;

    void (async () => {
      try {
        const providerRes = await fetch(
          `${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=1&isActive=true`,
          { credentials: 'include' }
        );

        if (cancelled) return;

        const hasProvider = await paginatedTotalGt0(providerRes);

        // 4-step layout:
        //   0 provider · 1 defaults · 2 smoke test · 3 done
        //
        // Without a provider configured, the only valid step is 0
        // (Provider). Snap back if persisted state points further —
        // typically because the dialog was closed mid-flow or the
        // operator deleted the provider after wizard progress was
        // saved.
        if (!hasProvider && stateRef.current.stepIndex > 0) {
          wiz.goTo(0);
        }
      } catch {
        if (!cancelled)
          setProbingError(
            'Could not check your current setup. You can still walk the wizard manually.'
          );
      } finally {
        if (!cancelled) setProbed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleFinish = useCallback(() => {
    clearState();
    onOpenChange(false);
  }, [clearState, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Set up AI Orchestration</DialogTitle>
          <DialogDescription>
            Step {wiz.stepIndex + 1} of {TOTAL_STEPS} — {STEP_LABELS[wiz.stepIndex] ?? 'Setup'}
          </DialogDescription>
        </DialogHeader>

        {probingError && (
          <div className="text-muted-foreground mb-2 rounded-md border border-dashed p-2 text-xs">
            {probingError}
          </div>
        )}

        <WizardStepIndicator currentIndex={wiz.stepIndex} onJump={(idx) => wiz.goTo(idx)} />

        <div className="min-h-[300px] py-4">
          {wiz.stepIndex === 0 && (
            <StepProvider
              draft={state.providerDraft}
              setDraft={(draft) => setState((prev) => ({ ...prev, providerDraft: draft }))}
              onComplete={() => wiz.next()}
            />
          )}
          {wiz.stepIndex === 1 && <StepDefaultModels onComplete={() => wiz.next()} />}
          {wiz.stepIndex === 2 && <StepSmokeTest onNext={() => wiz.next()} />}
          {wiz.stepIndex === 3 && <StepDone />}
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {!wiz.isFirst && (
              <Button variant="ghost" size="sm" onClick={() => wiz.prev()}>
                Back
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleClose}>
              <X className="mr-1 h-4 w-4" aria-hidden="true" />
              Close
            </Button>
            {wiz.isLast ? (
              <Button size="sm" onClick={handleFinish}>
                Finish
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STEP_LABELS: Record<number, string> = {
  0: 'Configure a provider',
  1: 'Confirm default models',
  2: 'Smoke test the wiring',
  3: "What's next",
};

/**
 * Short labels for the inline progress indicator. The full labels live
 * in `STEP_LABELS` (used by the dialog description); the pill row needs
 * compact text so all 4 fit comfortably in the 2xl dialog.
 */
const STEP_PILL_LABELS: Record<number, string> = {
  0: 'Provider',
  1: 'Defaults',
  2: 'Smoke test',
  3: 'Done',
};

interface WizardStepIndicatorProps {
  currentIndex: number;
  /** Called when the user clicks a completed step (current/upcoming are not clickable). */
  onJump: (index: number) => void;
}

/**
 * Horizontal stepper above the wizard content. Each pill shows
 *   - ✓ + label for steps already completed (clickable to revisit)
 *   - ● + label for the current step
 *   - ○ + label for upcoming steps (disabled)
 *
 * "Completed" is defined as `index < currentIndex` — the wizard's
 * step machine only advances past a step on success, so this is a
 * safe proxy for "this step has been satisfied".
 */
function WizardStepIndicator({
  currentIndex,
  onJump,
}: WizardStepIndicatorProps): React.ReactElement {
  return (
    <ol
      aria-label="Setup progress"
      className="flex flex-wrap items-center gap-1 text-xs sm:gap-1.5"
    >
      {Array.from({ length: TOTAL_STEPS }, (_, i) => {
        const status: 'completed' | 'current' | 'upcoming' =
          i < currentIndex ? 'completed' : i === currentIndex ? 'current' : 'upcoming';
        const label = STEP_PILL_LABELS[i] ?? `Step ${i + 1}`;
        const fullLabel = STEP_LABELS[i] ?? '';
        const clickable = status === 'completed';

        return (
          <li key={i} className="flex items-center gap-1 sm:gap-1.5">
            <button
              type="button"
              aria-current={status === 'current' ? 'step' : undefined}
              aria-label={`Step ${i + 1}: ${fullLabel}${
                status === 'completed' ? ' (completed)' : status === 'current' ? ' (current)' : ''
              }`}
              disabled={!clickable}
              onClick={clickable ? () => onJump(i) : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors',
                status === 'completed' &&
                  'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer',
                status === 'current' &&
                  'border-primary bg-primary text-primary-foreground font-medium',
                status === 'upcoming' &&
                  'border-muted-foreground/20 text-muted-foreground cursor-not-allowed'
              )}
            >
              {status === 'completed' ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : status === 'current' ? (
                <span className="bg-primary-foreground inline-block h-1.5 w-1.5 rounded-full" />
              ) : (
                <span className="border-muted-foreground/40 inline-block h-1.5 w-1.5 rounded-full border" />
              )}
              <span>{label}</span>
            </button>
            {i < TOTAL_STEPS - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'h-px w-2 sm:w-3',
                  i < currentIndex ? 'bg-primary/40' : 'bg-muted-foreground/20'
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

async function paginatedTotalGt0(res: Response): Promise<boolean> {
  if (!res.ok) return false;
  try {
    const body = (await res.json()) as { success?: boolean; meta?: { total?: number } };
    return body.success === true && typeof body.meta?.total === 'number' && body.meta.total > 0;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Step 1 — Provider configuration
// ----------------------------------------------------------------------------

interface StepProviderProps {
  draft: ProviderDraft;
  setDraft: (draft: ProviderDraft) => void;
  onComplete: () => void;
}

interface DetectionRow {
  slug: string;
  name: string;
  providerType: 'anthropic' | 'openai-compatible' | 'voyage';
  defaultBaseUrl: string | null;
  apiKeyEnvVar: string | null;
  apiKeyPresent: boolean;
  alreadyConfigured: boolean;
  isLocal: boolean;
  suggestedDefaultChatModel: string | null;
  suggestedRoutingModel: string | null;
  suggestedReasoningModel: string | null;
  suggestedEmbeddingModel: string | null;
}

const detectionRowSchema: z.ZodType<DetectionRow> = z.object({
  slug: z.string(),
  name: z.string(),
  providerType: z.enum(['anthropic', 'openai-compatible', 'voyage']),
  defaultBaseUrl: z.string().nullable(),
  apiKeyEnvVar: z.string().nullable(),
  apiKeyPresent: z.boolean(),
  alreadyConfigured: z.boolean(),
  isLocal: z.boolean(),
  suggestedDefaultChatModel: z.string().nullable(),
  suggestedRoutingModel: z.string().nullable(),
  suggestedReasoningModel: z.string().nullable(),
  suggestedEmbeddingModel: z.string().nullable(),
});

const detectionResultSchema = z.object({
  detected: z.array(detectionRowSchema).optional(),
});

function StepProvider({ draft, setDraft, onComplete }: StepProviderProps): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detection, setDetection] = useState<DetectionRow[] | null>(null);
  const [hasExisting, setHasExisting] = useState<boolean | null>(null);
  const [manualMode, setManualMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [providerRes, detectRes] = await Promise.all([
          fetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=1&isActive=true`, {
            credentials: 'include',
          }),
          fetch(API.ADMIN.ORCHESTRATION.PROVIDERS_DETECT, { credentials: 'include' }),
        ]);
        if (cancelled) return;

        setHasExisting(await paginatedTotalGt0(providerRes));

        if (detectRes.ok) {
          const parsed = envelopeSchema(detectionResultSchema).safeParse(await detectRes.json());
          if (parsed.success && parsed.data.success && parsed.data.data?.detected) {
            setDetection(parsed.data.data.detected);
          } else {
            setDetection([]);
          }
        } else {
          setDetection([]);
        }
      } catch {
        if (!cancelled) {
          setHasExisting(false);
          setDetection([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const detectedAvailable = useMemo(
    () => (detection ?? []).filter((d) => d.apiKeyPresent && !d.alreadyConfigured),
    [detection]
  );

  // True if at least one hosted provider has its env key set. Used to
  // gate the "no keys detected" warning ahead of every other branch —
  // an empty env means even an existing provider row can't
  // authenticate, so the warning has to take priority over the
  // "you already have a provider configured" success card.
  const anyKeyPresent = useMemo(
    () => (detection ?? []).some((d) => d.apiKeyPresent && !d.isLocal),
    [detection]
  );

  // Cloud providers the operator could set an env var for. Excludes
  // `isLocal` rows (Ollama doesn't use API keys) and any provider
  // that's already wired up, so the "set one of these and restart"
  // hint doesn't recommend keys for things the operator has already
  // configured a different way.
  const candidateEnvVars = useMemo(
    () =>
      (detection ?? [])
        .filter((d) => !d.isLocal && d.apiKeyEnvVar)
        .map((d) => ({ name: d.name, envVar: d.apiKeyEnvVar! })),
    [detection]
  );

  async function persistSuggestedDefaults(row: DetectionRow): Promise<void> {
    // Write suggested chat / routing / reasoning / embedding models into
    // the settings singleton, but only for slots the operator hasn't
    // already saved. Strict-mode runtime now throws when a slot is
    // unset, so writing all four keeps the system functional after a
    // single Configure click.
    //
    // Reads `defaultModelsStored` (raw saved subset), NOT `defaultModels`
    // — the latter is always populated by hydration so its keys would
    // make the empty-slot check falsy.
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.SETTINGS, { credentials: 'include' });
      if (!res.ok) return;
      const parsed = envelopeSchema(defaultModelsStoredSchema).safeParse(await res.json());
      const stored =
        parsed.success && parsed.data.success ? (parsed.data.data?.defaultModelsStored ?? {}) : {};
      const patch: Record<string, string> = {};
      if (row.suggestedDefaultChatModel && !stored.chat) {
        patch.chat = row.suggestedDefaultChatModel;
      }
      if (row.suggestedRoutingModel && !stored.routing) {
        patch.routing = row.suggestedRoutingModel;
      }
      if (row.suggestedReasoningModel && !stored.reasoning) {
        patch.reasoning = row.suggestedReasoningModel;
      }
      if (row.suggestedEmbeddingModel && !stored.embeddings) {
        patch.embeddings = row.suggestedEmbeddingModel;
      }
      if (Object.keys(patch).length === 0) return;
      await fetch(API.ADMIN.ORCHESTRATION.SETTINGS, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModels: patch }),
      });
    } catch {
      // Setting failures are non-blocking — operator can edit manually
      // on the next step.
    }
  }

  async function createProviderFromRow(row: DetectionRow): Promise<void> {
    setError(null);
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: row.name,
        slug: row.slug,
        providerType: row.providerType,
        isLocal: row.isLocal,
      };
      if (row.defaultBaseUrl) payload.baseUrl = row.defaultBaseUrl;
      if (row.apiKeyEnvVar) payload.apiKeyEnvVar = row.apiKeyEnvVar;

      const res = await fetch(API.ADMIN.ORCHESTRATION.PROVIDERS, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError(
          `Could not create the ${row.name} provider. Open the Providers page and add it manually.`
        );
        return;
      }
      await persistSuggestedDefaults(row);
      // Cache draft for the agent step (so its provider dropdown defaults to this slug).
      setDraft({
        ...draft,
        name: row.name,
        slug: row.slug,
        apiKeyEnvVar: row.apiKeyEnvVar ?? '',
        providerType: row.providerType,
        baseUrl: row.defaultBaseUrl ?? '',
        suggestedDefaultChatModel: row.suggestedDefaultChatModel ?? '',
        suggestedEmbeddingModel: row.suggestedEmbeddingModel ?? '',
      });
      onComplete();
    } catch {
      setError('Could not reach the server. Check your network and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleManualSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (!draft.providerType) {
      setError('Pick a provider type before submitting.');
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: draft.name,
        slug: draft.slug,
        providerType: draft.providerType,
        isLocal: draft.providerType === 'openai-compatible' && draft.baseUrl.includes('localhost'),
      };
      if (draft.baseUrl) payload.baseUrl = draft.baseUrl;
      if (draft.apiKeyEnvVar) payload.apiKeyEnvVar = draft.apiKeyEnvVar;

      const res = await fetch(API.ADMIN.ORCHESTRATION.PROVIDERS, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError('Could not create the provider. Check the fields and try again.');
        return;
      }
      onComplete();
    } catch {
      setError('Could not reach the server. Check your network and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (hasExisting === null || detection === null) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking for existing providers…
      </div>
    );
  }

  // Env-key absence is a hard block — it takes priority over the
  // "you already have a provider configured" success card because a
  // provider row without its env var can't authenticate at runtime.
  // The operator may have just rotated or disabled a key, leaving a
  // stale row in the DB; surfacing the missing-key warning here is
  // the only useful signal.
  if (!anyKeyPresent) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/50 dark:bg-amber-900/10">
          <AlertTriangle
            className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400"
            aria-hidden="true"
          />
          <div className="space-y-2">
            <div className="font-medium">No LLM API keys detected in your environment</div>
            <p className="text-muted-foreground text-xs">
              {hasExisting
                ? "You have a provider configured, but its API key isn't set in this environment — the provider can't authenticate. Restore the env var (or set one of the alternatives below) and restart the server."
                : 'Sunrise reads provider API keys from environment variables at startup — it never stores them in the database. Add one of the following to your .env file and restart the server, then reopen this wizard.'}
            </p>
            {candidateEnvVars.length > 0 && (
              <ul className="text-muted-foreground space-y-0.5 text-xs">
                {candidateEnvVars.map((c) => (
                  <li key={c.envVar}>
                    <code className="bg-muted/60 rounded px-1 py-0.5">{c.envVar}</code> — {c.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (hasExisting) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4 text-sm dark:border-green-900/50 dark:bg-green-900/10">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-400" />
          <div>
            <div className="font-medium">You already have a provider configured.</div>
            <p className="text-muted-foreground mt-1 text-xs">
              Nothing to do here. Continue to confirm your default chat model.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={onComplete}>
            Continue
          </Button>
        </div>
      </div>
    );
  }

  // Detection cards path: env vars set → one-click configure
  if (detectedAvailable.length > 0 && !manualMode) {
    return (
      <div className="space-y-4">
        <p className="text-sm">
          We detected {detectedAvailable.length === 1 ? 'an API key' : 'API keys'} in your
          environment. Pick a provider to configure it now — Sunrise will fill in the base URL and
          recommend a chat model.
        </p>
        <ul className="space-y-2">
          {detectedAvailable.map((row) => (
            <li key={row.slug}>
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  void createProviderFromRow(row);
                }}
                className="hover:bg-muted/40 flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors disabled:opacity-50"
              >
                <CheckCircle2
                  className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400"
                  aria-hidden="true"
                />
                <div className="flex-1 space-y-1.5">
                  <div className="text-sm font-medium">{row.name}</div>
                  <div className="text-muted-foreground text-xs">
                    Detected <code>{row.apiKeyEnvVar}</code>
                  </div>
                  <DetectionCardPreview row={row} />
                </div>
              </button>
            </li>
          ))}
        </ul>
        {error && <div className="text-destructive text-sm">{error}</div>}
        <div className="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setManualMode(true)}
            disabled={submitting}
          >
            Configure manually instead →
          </Button>
        </div>
      </div>
    );
  }

  // Manual path: operator opted into manual mode from the detection
  // list via "Configure manually instead →". Only reachable when at
  // least one env key was detected; the no-keys branch above is the
  // single source of "no API key" UX.
  return (
    <form
      onSubmit={(e) => {
        void handleManualSubmit(e);
      }}
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="provider-flavour">
          Provider type{' '}
          <FieldHelp title="Provider type">
            Pick the kind of LLM backend. Anthropic uses Claude. OpenAI-compatible covers OpenAI,
            Mistral, Groq, Ollama, and any custom endpoint that speaks the OpenAI chat-completions
            API. Voyage is embeddings-only.
          </FieldHelp>
        </Label>
        <Select
          value={draft.providerType || undefined}
          onValueChange={(value) =>
            setDraft({ ...draft, providerType: value as ProviderDraft['providerType'] })
          }
          disabled={submitting}
        >
          <SelectTrigger id="provider-flavour">
            <SelectValue placeholder="Pick a type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
            <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
            <SelectItem value="voyage">Voyage AI (embeddings)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="provider-name">
          Name{' '}
          <FieldHelp title="Provider name">
            A short human name like &quot;Anthropic prod&quot; or &quot;OpenAI staging&quot;.
          </FieldHelp>
        </Label>
        <Input
          id="provider-name"
          required
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          disabled={submitting}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="provider-slug">
          Slug{' '}
          <FieldHelp title="Provider slug">
            URL-safe identifier — lowercase, hyphens only. Used when wiring an agent to a provider.
          </FieldHelp>
        </Label>
        <Input
          id="provider-slug"
          required
          pattern="[a-z0-9-]+"
          value={draft.slug}
          onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
          disabled={submitting}
        />
      </div>

      {draft.providerType === 'openai-compatible' && (
        <div className="space-y-2">
          <Label htmlFor="provider-base-url">
            Base URL{' '}
            <FieldHelp title="Provider base URL">
              The HTTP endpoint Sunrise calls. <code>https://api.openai.com/v1</code> for OpenAI,{' '}
              <code>http://localhost:11434/v1</code> for Ollama, etc.
            </FieldHelp>
          </Label>
          <Input
            id="provider-base-url"
            required
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            disabled={submitting}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="provider-env">
          API key env var{' '}
          <FieldHelp title="API key environment variable">
            Name of the environment variable holding the real API key. Must be SCREAMING_SNAKE_CASE.
            The key itself is never written to the database or logged.
          </FieldHelp>
        </Label>
        <Input
          id="provider-env"
          placeholder="ANTHROPIC_API_KEY"
          value={draft.apiKeyEnvVar}
          onChange={(e) => setDraft({ ...draft, apiKeyEnvVar: e.target.value })}
          disabled={submitting}
        />
      </div>

      {error && <div className="text-destructive text-sm">{error}</div>}

      <div className="flex justify-between">
        {detectedAvailable.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setManualMode(false)}
            disabled={submitting}
            type="button"
          >
            ← Back to detected providers
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Creating…
            </>
          ) : (
            'Create provider'
          )}
        </Button>
      </div>
    </form>
  );
}

/**
 * Pre-click preview of what clicking this detection card will write
 * into `AiOrchestrationSettings.defaultModels`. Mirrors the same
 * helper in `provider-detections-banner.tsx` so the wizard and the
 * providers-list banner share a contract:
 *
 *   - Show the suggested chat + embedding models from
 *     `lib/orchestration/llm/known-providers.ts`.
 *   - If the chosen provider has no embedding model (Anthropic, Groq,
 *     Together, Fireworks), warn that knowledge-base search needs a
 *     separate provider.
 *   - If the chosen provider has no chat model (Voyage), warn that
 *     agent conversations need a separate provider.
 *
 * Defaults are only written into empty slots, so the preview also
 * notes that existing operator-set defaults are never overwritten.
 */
function DetectionCardPreview({ row }: { row: DetectionRow }): React.ReactElement {
  const noEmbedding = !row.suggestedEmbeddingModel && !row.isLocal;
  const noChat = !row.suggestedDefaultChatModel;

  return (
    <div className="space-y-1 text-xs">
      {row.suggestedDefaultChatModel && (
        <div className="text-muted-foreground">
          Default chat model:{' '}
          <code className="bg-muted/60 rounded px-1 py-0.5">{row.suggestedDefaultChatModel}</code>
        </div>
      )}

      {row.suggestedEmbeddingModel && (
        <div className="text-muted-foreground">
          Default embedding model:{' '}
          <code className="bg-muted/60 rounded px-1 py-0.5">{row.suggestedEmbeddingModel}</code>
        </div>
      )}

      {noEmbedding && (
        <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {row.name} doesn&apos;t offer embeddings — knowledge-base search needs a separate
            embedding provider (Voyage AI, OpenAI, or Ollama).
          </span>
        </div>
      )}

      {noChat && (
        <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {row.name} is embeddings-only — agent conversations need a separate chat provider.
          </span>
        </div>
      )}

      <div className="text-muted-foreground/70 italic">
        These are platform suggestions. Existing defaults are never overwritten.
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Step 2 — Confirm default chat / embedding models
// ----------------------------------------------------------------------------

interface StepDefaultModelsProps {
  onComplete: () => void;
}

interface ModelOption {
  /** Canonical id passed to the LLM provider (e.g. "claude-sonnet-4-6"). */
  id: string;
  provider: string;
  /** True if the provider config row backing this model exists and is active. */
  available?: boolean;
}

const modelOptionSchema: z.ZodType<ModelOption> = z.object({
  id: z.string(),
  provider: z.string(),
  available: z.boolean().optional(),
});

function StepDefaultModels({ onComplete }: StepDefaultModelsProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatModel, setChatModel] = useState<string>('');
  const [embeddingModel, setEmbeddingModel] = useState<string>('');
  const [models, setModels] = useState<ModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settingsRes, modelsRes] = await Promise.all([
          fetch(API.ADMIN.ORCHESTRATION.SETTINGS, { credentials: 'include' }),
          fetch(API.ADMIN.ORCHESTRATION.MODELS, { credentials: 'include' }),
        ]);
        if (cancelled) return;

        if (settingsRes.ok) {
          const parsed = envelopeSchema(defaultModelsSchema).safeParse(await settingsRes.json());
          if (parsed.success && parsed.data.success && parsed.data.data?.defaultModels) {
            setChatModel(parsed.data.data.defaultModels.chat ?? '');
            setEmbeddingModel(parsed.data.data.defaultModels.embeddings ?? '');
          }
        }

        if (modelsRes.ok) {
          const parsed = envelopeSchema(z.array(modelOptionSchema)).safeParse(
            await modelsRes.json()
          );
          if (parsed.success && parsed.data.success && parsed.data.data) {
            setModels(parsed.data.data);
          }
        }
      } catch {
        // Silent — empty model list is rendered as a fallback message.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleContinue(): Promise<void> {
    setError(null);
    setSubmitting(true);
    try {
      const patch: Record<string, string> = {};
      if (chatModel) patch.chat = chatModel;
      if (embeddingModel) patch.embeddings = embeddingModel;
      if (Object.keys(patch).length > 0) {
        const res = await fetch(API.ADMIN.ORCHESTRATION.SETTINGS, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultModels: patch }),
        });
        if (!res.ok) {
          setError('Could not save the default models. You can edit them later from Settings.');
          return;
        }
      }
      onComplete();
    } catch {
      setError('Could not reach the server. Check your network and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading default models…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        These are the default models the system-seeded agents (pattern advisor, quiz master, the MCP
        server) use when they don&apos;t pin a specific model. You can change them later from
        Settings.
      </p>

      <div className="space-y-2">
        <Label htmlFor="default-chat-model">
          Default chat model{' '}
          <FieldHelp title="Default chat model">
            Used by every system-seeded agent that doesn&apos;t pin its own model. Pick a balanced
            tier — &quot;worker&quot; or &quot;thinking&quot; in the model matrix.
          </FieldHelp>
        </Label>
        <Select value={chatModel || undefined} onValueChange={setChatModel} disabled={submitting}>
          <SelectTrigger id="default-chat-model">
            <SelectValue placeholder="Pick a model" />
          </SelectTrigger>
          <SelectContent>
            {models.length === 0 ? (
              <SelectItem value="__none" disabled>
                No models discovered — check provider configuration.
              </SelectItem>
            ) : (
              models.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.id} <span className="text-muted-foreground ml-2 text-xs">{m.provider}</span>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="default-embedding-model">
          Default embedding model{' '}
          <FieldHelp title="Default embedding model">
            Used by the knowledge base for vector search. If you don&apos;t plan to use the
            knowledge base, leave this as the suggested default.
          </FieldHelp>
        </Label>
        <Input
          id="default-embedding-model"
          placeholder="e.g. text-embedding-3-small"
          value={embeddingModel}
          onChange={(e) => setEmbeddingModel(e.target.value)}
          disabled={submitting}
        />
      </div>

      {error && <div className="text-destructive text-sm">{error}</div>}

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            void handleContinue();
          }}
          disabled={submitting}
        >
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            'Continue'
          )}
        </Button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Step 3 — Smoke test the wiring
// ----------------------------------------------------------------------------

interface StepSmokeTestProps {
  onNext: () => void;
}

interface ProviderTestRow {
  id: string;
  slug: string;
  name: string;
  isLocal: boolean;
  apiKeyPresent: boolean;
}

const providerTestRowSchema: z.ZodType<ProviderTestRow> = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isLocal: z.boolean(),
  apiKeyPresent: z.boolean(),
});

type TestStatus = 'idle' | 'running' | 'ok' | 'failed';

interface ProviderTestResult {
  status: TestStatus;
  message?: string;
  /** Round-trip latency from /test-model when status === 'ok'. */
  latencyMs?: number;
}

/**
 * Step 3 — exercises the configured provider+model end-to-end without
 * touching agents or the knowledge base. For each active provider:
 *
 *   1. POST /providers/:id/test         → checks API key + connectivity.
 *   2. POST /providers/:id/test-model   → sends "Say hello." via the
 *                                          configured default chat model
 *                                          and reports latency.
 *
 * If both succeed, the operator has proof the chain (provider → key →
 * model) round-trips. System agents (pattern-advisor, etc.) reuse the
 * same chain at runtime, so a green smoke test means they'll work too.
 */
function StepSmokeTest({ onNext }: StepSmokeTestProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<ProviderTestRow[]>([]);
  const [chatModel, setChatModel] = useState<string>('');
  const [results, setResults] = useState<Record<string, ProviderTestResult>>({});
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [providersRes, settingsRes] = await Promise.all([
          fetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=50&isActive=true`, {
            credentials: 'include',
          }),
          fetch(API.ADMIN.ORCHESTRATION.SETTINGS, { credentials: 'include' }),
        ]);
        if (cancelled) return;

        if (providersRes.ok) {
          const parsed = envelopeSchema(z.array(providerTestRowSchema)).safeParse(
            await providersRes.json()
          );
          if (parsed.success && parsed.data.success && parsed.data.data) {
            setProviders(parsed.data.data);
          }
        }

        if (settingsRes.ok) {
          const parsed = envelopeSchema(defaultModelsSchema).safeParse(await settingsRes.json());
          if (parsed.success && parsed.data.success) {
            setChatModel(parsed.data.data?.defaultModels?.chat ?? '');
          }
        }
      } catch {
        // Intentionally silent — empty providers list renders the
        // "no providers" message below.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runTest(row: ProviderTestRow): Promise<void> {
    setRunning(row.id);
    setResults((prev) => ({ ...prev, [row.id]: { status: 'running' } }));

    try {
      // 1. Provider connectivity check — POST /providers/:id/test
      const testRes = await fetch(API.ADMIN.ORCHESTRATION.providerTest(row.id), {
        method: 'POST',
        credentials: 'include',
      });
      if (!testRes.ok) {
        setResults((prev) => ({
          ...prev,
          [row.id]: {
            status: 'failed',
            message: 'Connectivity check failed. Verify the API key and base URL.',
          },
        }));
        return;
      }
      const testParsed = envelopeSchema(providerTestResultSchema).safeParse(await testRes.json());
      if (!testParsed.success || !testParsed.data.success || !testParsed.data.data?.ok) {
        setResults((prev) => ({
          ...prev,
          [row.id]: {
            status: 'failed',
            message: 'The provider rejected the connection. Check logs for details.',
          },
        }));
        return;
      }

      // 2. Round-trip a single message — POST /providers/:id/test-model
      if (!chatModel) {
        setResults((prev) => ({
          ...prev,
          [row.id]: {
            status: 'failed',
            message: 'No default chat model is set. Go back to step 2 and pick one.',
          },
        }));
        return;
      }
      const modelRes = await fetch(API.ADMIN.ORCHESTRATION.providerTestModel(row.id), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: chatModel }),
      });
      if (!modelRes.ok) {
        setResults((prev) => ({
          ...prev,
          [row.id]: {
            status: 'failed',
            message:
              'The model call failed. Check that the configured model id is valid for this provider.',
          },
        }));
        return;
      }
      const modelParsed = envelopeSchema(modelTestResultSchema).safeParse(await modelRes.json());
      if (modelParsed.success && modelParsed.data.success && modelParsed.data.data?.ok) {
        const latencyMs = modelParsed.data.data.latencyMs;
        setResults((prev) => ({
          ...prev,
          [row.id]: {
            status: 'ok',
            ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
          },
        }));
      } else {
        setResults((prev) => ({
          ...prev,
          [row.id]: {
            status: 'failed',
            message: 'The model returned an error. Check logs for details.',
          },
        }));
      }
    } catch {
      setResults((prev) => ({
        ...prev,
        [row.id]: {
          status: 'failed',
          message: 'Could not reach the server. Check your network and try again.',
        },
      }));
    } finally {
      setRunning(null);
    }
  }

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading configured providers…
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/10 dark:text-amber-200">
          <p className="font-medium">No active providers found.</p>
          <p className="mt-1 text-xs">
            Go back and configure a provider before running the smoke test.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        Each provider is exercised end-to-end: connectivity check, then a single &quot;Say
        hello.&quot; round-trip through the configured default chat model. A green result means the
        provider → API key → LLM chain works — system agents and any agents you create later will
        use the same chain.
      </p>

      {!chatModel && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/10 dark:text-amber-200">
          No default chat model is set. Go back to step 2 and pick one before running the test.
        </div>
      )}

      <ul className="space-y-2">
        {providers.map((row) => {
          const result = results[row.id] ?? { status: 'idle' as const };
          const isRunning = running === row.id;
          return (
            <li
              key={row.id}
              className="bg-background flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-3">
                <SmokeTestStatusIcon status={result.status} />
                <div>
                  <div className="text-sm font-medium">{row.name}</div>
                  <div className="text-muted-foreground text-xs">
                    <code>{row.slug}</code>
                    {result.status === 'ok' && typeof result.latencyMs === 'number' && (
                      <>
                        {' · '}
                        <span className="text-green-700 dark:text-green-400">
                          {result.latencyMs}ms round-trip
                        </span>
                      </>
                    )}
                  </div>
                  {result.status === 'failed' && result.message && (
                    <div className="text-destructive mt-1 text-xs">{result.message}</div>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                variant={result.status === 'ok' ? 'outline' : 'default'}
                onClick={() => {
                  void runTest(row);
                }}
                disabled={isRunning || !chatModel}
                className="shrink-0"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Testing…
                  </>
                ) : result.status === 'ok' ? (
                  'Run again'
                ) : (
                  'Run test'
                )}
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function SmokeTestStatusIcon({ status }: { status: TestStatus }): React.ReactElement {
  if (status === 'ok') {
    return (
      <CheckCircle2
        className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400"
        aria-label="Test passed"
      />
    );
  }
  if (status === 'failed') {
    return (
      <AlertTriangle
        className="text-destructive mt-0.5 h-4 w-4 shrink-0"
        aria-label="Test failed"
      />
    );
  }
  if (status === 'running') {
    return (
      <Loader2
        className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0 animate-spin"
        aria-label="Test running"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="border-muted-foreground/40 mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full border"
    />
  );
}

// ----------------------------------------------------------------------------
// Step 4 — Done / next steps
// ----------------------------------------------------------------------------

function StepDone() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4 text-sm dark:border-green-900/50 dark:bg-green-900/10">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-700 dark:text-green-400" />
        <div>
          <div className="font-medium">You&apos;re set up.</div>
          <p className="text-muted-foreground mt-1 text-xs">
            Your provider and agent are live. Here are a few places to go next:
          </p>
        </div>
      </div>

      <ul className="space-y-2 text-sm">
        <li>
          <Link href="/admin/orchestration/learning" className="font-medium underline">
            Explore patterns
          </Link>{' '}
          — browse agentic design patterns for inspiration.
        </li>
        <li>
          <Link href="/admin/orchestration/workflows" className="font-medium underline">
            Build a workflow
          </Link>{' '}
          — chain agents into multi-step flows.
        </li>
        <li>
          <Link href="/admin/orchestration/knowledge" className="font-medium underline">
            Add knowledge docs
          </Link>{' '}
          — give your agents retrieval context.
        </li>
      </ul>
    </div>
  );
}
