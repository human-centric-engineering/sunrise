'use client';

/**
 * Setup Wizard
 *
 * Six-step guided flow that walks a new admin from "fresh install" to
 * "I have a working agent I can chat with":
 *
 *   1. What are you building?      — pattern advisor chat
 *   2. Configure a provider        — env-var detection cards + manual flavour picker
 *   3. Confirm default models      — chat + embedding model selectors
 *   4. Create your first agent     — provider/model dropdowns sourced from /providers
 *   5. Test your agent             — SSE chat consumer
 *   6. What's next                 — static links, marks wizard complete
 *
 * The wizard is provider-agnostic: it does not assume Anthropic. The
 * provider step calls `/providers/detect` to surface "We detected
 * `ANTHROPIC_API_KEY` — configure now?" cards, then writes the
 * suggested chat / embedding model to `AiOrchestrationSettings` so the
 * 5 system-seeded agents (which ship with empty provider/model)
 * resolve their binding through the operator's choice.
 *
 * Errors never throw out of the dialog. Fetch failures become friendly
 * inline messages — the raw `err.message` from a fetch is not forwarded
 * to the UI (could leak provider SDK internals). Detailed errors are
 * logged to the server via `logger.error` in the underlying API routes,
 * not from this client component.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';

import { AgentTestChat } from '@/components/admin/orchestration/agent-test-chat';
import { ChatInterface } from '@/components/admin/orchestration/chat/chat-interface';
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
import { Textarea } from '@/components/ui/textarea';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { useWizard } from '@/lib/hooks/use-wizard';
import { API } from '@/lib/api/endpoints';
import { extractWorkflowDefinition } from '@/lib/orchestration/utils/extract-workflow-definition';

// Bumped from v1 → v2 because TOTAL_STEPS grew from 5 → 6 and the
// agent-draft default values changed (no more hardcoded 'anthropic' /
// 'claude-opus-4-6'). Old persisted state would point users at the
// wrong step or pre-fill with stale defaults.
const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v2';
const TOTAL_STEPS = 6;

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

interface AgentDraft {
  name: string;
  slug: string;
  description: string;
  systemInstructions: string;
  model: string;
  provider: string;
}

interface WizardState {
  stepIndex: number;
  providerDraft: ProviderDraft;
  agentDraft: AgentDraft;
  /** Slug of the agent created by the wizard — used by the chat test step. */
  createdAgentSlug: string | null;
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
  agentDraft: {
    name: '',
    slug: '',
    description: '',
    systemInstructions: '',
    // Empty by default — populated from the configured provider on mount.
    model: '',
    provider: '',
  },
  createdAgentSlug: null,
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

  // Keep the wizard step-index in sync with persisted state
  useEffect(() => {
    setState((prev) => ({ ...prev, stepIndex: wiz.stepIndex }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiz.stepIndex]);

  // Probe the backend once on open to auto-advance past completed steps.
  const [probed, setProbed] = useState(false);
  const [probingError, setProbingError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || probed) return;
    let cancelled = false;

    void (async () => {
      try {
        const [providerRes, agentRes] = await Promise.all([
          fetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=1&isActive=true`, {
            credentials: 'include',
          }),
          fetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=1`, { credentials: 'include' }),
        ]);

        if (cancelled) return;

        const hasProvider = await paginatedTotalGt0(providerRes);
        const hasAgent = await paginatedTotalGt0(agentRes);

        // Jump to the first incomplete step. Step 0 (intro) is always
        // shown the first time. Step indexes for the 6-step layout:
        //   0 intro · 1 provider · 2 default models · 3 agent · 4 test · 5 done
        // If an agent already exists, skip past creation to the test
        // step (4). If a provider exists but no agent, skip to default
        // models (2) so the operator confirms before creating an agent.
        if (state.stepIndex === 0 && (hasProvider || hasAgent)) {
          if (hasAgent) wiz.goTo(4);
          else if (hasProvider) wiz.goTo(2);
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

        <div className="min-h-[300px] py-4">
          {wiz.stepIndex === 0 && <StepIntro onSkip={() => wiz.next()} />}
          {wiz.stepIndex === 1 && (
            <StepProvider
              draft={state.providerDraft}
              setDraft={(draft) => setState((prev) => ({ ...prev, providerDraft: draft }))}
              onComplete={() => wiz.next()}
            />
          )}
          {wiz.stepIndex === 2 && <StepDefaultModels onComplete={() => wiz.next()} />}
          {wiz.stepIndex === 3 && (
            <StepAgent
              draft={state.agentDraft}
              setDraft={(draft) => setState((prev) => ({ ...prev, agentDraft: draft }))}
              onCreated={(slug) => {
                setState((prev) => ({ ...prev, createdAgentSlug: slug }));
                wiz.next();
              }}
            />
          )}
          {wiz.stepIndex === 4 && (
            <StepTestAgent
              agentSlug={state.createdAgentSlug ?? state.agentDraft.slug}
              onNext={() => wiz.next()}
            />
          )}
          {wiz.stepIndex === 5 && <StepDone />}
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
  0: 'What are you building?',
  1: 'Configure a provider',
  2: 'Confirm default models',
  3: 'Create your first agent',
  4: 'Test your agent',
  5: "What's next",
};

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
// Step 1 — Intro / Pattern advisor placeholder
// ----------------------------------------------------------------------------

const WIZARD_STARTER_PROMPTS = [
  'I want to build a customer support bot',
  'Help me design a content moderation pipeline',
  'I need a research assistant that searches documents',
  'I want an agent that generates and reviews code',
];

function StepIntro({ onSkip }: { onSkip: () => void }) {
  const router = useRouter();
  const [workflowRecommendation, setWorkflowRecommendation] = useState<string | null>(null);

  const handleStreamComplete = useCallback((fullText: string) => {
    const definition = extractWorkflowDefinition(fullText);
    if (definition) {
      setWorkflowRecommendation(definition);
    }
  }, []);

  const handleCreateWorkflow = useCallback(() => {
    if (!workflowRecommendation) return;
    router.push(
      `/admin/orchestration/workflows/new?definition=${encodeURIComponent(workflowRecommendation)}`
    );
  }, [router, workflowRecommendation]);

  return (
    <div className="space-y-4">
      <p className="text-sm">
        Tell us what you&apos;re trying to build and we&apos;ll suggest a pattern — a reflection
        agent, a multi-step workflow, a retrieval-augmented chat, or something else.
      </p>
      <ChatInterface
        agentSlug="pattern-advisor"
        embedded
        starterPrompts={WIZARD_STARTER_PROMPTS}
        onStreamComplete={handleStreamComplete}
        className="h-[350px]"
      />
      {workflowRecommendation && (
        <div className="bg-muted/30 flex items-center justify-between rounded-md border p-3">
          <span className="text-sm">The advisor recommended a workflow definition.</span>
          <Button size="sm" onClick={handleCreateWorkflow}>
            Create this workflow
          </Button>
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Skip, I&apos;ll configure manually →
        </Button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Step 2 — Provider configuration
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
  suggestedEmbeddingModel: string | null;
}

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
          const body = (await detectRes.json()) as {
            success?: boolean;
            data?: { detected?: DetectionRow[] };
          };
          if (body.success && body.data?.detected) {
            setDetection(body.data.detected);
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

  async function persistSuggestedDefaults(row: DetectionRow): Promise<void> {
    // Best-effort: write the suggested chat / embedding model into the
    // settings singleton, but only if the slot isn't already populated
    // (operator edits always win).
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.SETTINGS, { credentials: 'include' });
      if (!res.ok) return;
      const body = (await res.json()) as {
        success?: boolean;
        data?: { defaultModels?: Record<string, string> };
      };
      const current = body.success ? (body.data?.defaultModels ?? {}) : {};
      const patch: Record<string, string> = {};
      if (row.suggestedDefaultChatModel && !current.chat) {
        patch.chat = row.suggestedDefaultChatModel;
      }
      if (row.suggestedEmbeddingModel && !current.embeddings) {
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
                <div className="flex-1">
                  <div className="text-sm font-medium">{row.name}</div>
                  <div className="text-muted-foreground text-xs">
                    Detected <code>{row.apiKeyEnvVar}</code>
                    {row.suggestedDefaultChatModel
                      ? ` · suggests model ${row.suggestedDefaultChatModel}`
                      : ''}
                  </div>
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

  // Manual path: env-var detection found nothing OR operator chose manual.
  return (
    <form
      onSubmit={(e) => {
        void handleManualSubmit(e);
      }}
      className="space-y-4"
    >
      {detectedAvailable.length === 0 && (
        <p className="text-sm">
          No LLM API keys were detected in your environment. Pick a provider type and we&apos;ll
          create it — set the matching env var in your <code>.env</code> file before chatting.
        </p>
      )}

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

// ----------------------------------------------------------------------------
// Step 3 (new) — Confirm default chat / embedding models
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
          const body = (await settingsRes.json()) as {
            success?: boolean;
            data?: { defaultModels?: Record<string, string> };
          };
          if (body.success && body.data?.defaultModels) {
            setChatModel(body.data.defaultModels.chat ?? '');
            setEmbeddingModel(body.data.defaultModels.embeddings ?? '');
          }
        }

        if (modelsRes.ok) {
          const body = (await modelsRes.json()) as { success?: boolean; data?: ModelOption[] };
          if (body.success && Array.isArray(body.data)) {
            setModels(body.data);
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
// Step 4 — Agent creation
// ----------------------------------------------------------------------------

interface StepAgentProps {
  draft: AgentDraft;
  setDraft: (draft: AgentDraft) => void;
  onCreated: (slug: string) => void;
}

interface ProviderOption {
  slug: string;
  name: string;
}

function StepAgent({ draft, setDraft, onCreated }: StepAgentProps): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [providersRes, modelsRes] = await Promise.all([
          fetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=50&isActive=true`, {
            credentials: 'include',
          }),
          fetch(API.ADMIN.ORCHESTRATION.MODELS, { credentials: 'include' }),
        ]);
        if (cancelled) return;

        if (providersRes.ok) {
          const body = (await providersRes.json()) as {
            success?: boolean;
            data?: ProviderOption[];
          };
          if (body.success && Array.isArray(body.data)) {
            setProviders(body.data);
            // Default to the first provider on mount if not already set.
            if (!draft.provider && body.data[0]) {
              setDraft({ ...draft, provider: body.data[0].slug });
            }
          }
        }
        if (modelsRes.ok) {
          const body = (await modelsRes.json()) as { success?: boolean; data?: ModelOption[] };
          if (body.success && Array.isArray(body.data)) {
            setModels(body.data);
          }
        }
      } catch {
        // Silent — empty selectors render fallback message.
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredModels = useMemo(
    () => models.filter((m) => m.provider === draft.provider),
    [models, draft.provider]
  );

  // When provider changes, default model to the first available for that provider
  // if the current one doesn't belong to it.
  useEffect(() => {
    if (!hydrated || !draft.provider) return;
    const valid = filteredModels.some((m) => m.id === draft.model);
    if (!valid && filteredModels.length > 0) {
      setDraft({ ...draft, model: filteredModels[0].id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.provider, hydrated]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);

    if (
      !draft.name.trim() ||
      !draft.slug.trim() ||
      !draft.description.trim() ||
      !draft.systemInstructions.trim() ||
      !draft.provider.trim() ||
      !draft.model.trim()
    ) {
      setError('All fields are required.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.AGENTS, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name.trim(),
          slug: draft.slug.trim(),
          description: draft.description.trim(),
          systemInstructions: draft.systemInstructions,
          model: draft.model.trim(),
          provider: draft.provider.trim(),
        }),
      });
      if (!res.ok) {
        setError('Could not create the agent. Check the fields and try again.');
        return;
      }
      onCreated(draft.slug.trim());
    } catch {
      setError('Could not reach the server. Check your network and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (providers.length === 0 && hydrated) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/10 dark:text-amber-200">
          <p className="font-medium">No active providers found.</p>
          <p className="mt-1 text-xs">Go back and configure a provider before creating an agent.</p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="space-y-4"
    >
      <p className="text-sm">
        An agent is a named persona with a system prompt, a provider, and a model. You can edit any
        of this later from the Agents page.
      </p>

      <div className="space-y-2">
        <Label htmlFor="agent-name">
          Name{' '}
          <FieldHelp title="Agent name">
            A friendly display name like &quot;Support triage&quot; or &quot;Code reviewer&quot;.
          </FieldHelp>
        </Label>
        <Input
          id="agent-name"
          required
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          disabled={submitting}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="agent-slug">
          Slug{' '}
          <FieldHelp title="Agent slug">
            URL-safe identifier. Used in the chat stream URL and referenced by workflows. Example:{' '}
            <code>support-triage</code>.
          </FieldHelp>
        </Label>
        <Input
          id="agent-slug"
          required
          pattern="[a-z0-9-]+"
          value={draft.slug}
          onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
          disabled={submitting}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="agent-description">
          Description{' '}
          <FieldHelp title="Agent description">
            One or two sentences explaining what this agent is for.
          </FieldHelp>
        </Label>
        <Textarea
          id="agent-description"
          required
          rows={2}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          disabled={submitting}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="agent-system">
          System instructions{' '}
          <FieldHelp title="System instructions">
            The prompt the agent sees before every conversation. Defines its tone, capabilities, and
            constraints.
          </FieldHelp>
        </Label>
        <Textarea
          id="agent-system"
          required
          rows={5}
          value={draft.systemInstructions}
          onChange={(e) => setDraft({ ...draft, systemInstructions: e.target.value })}
          disabled={submitting}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="agent-provider">
            Provider{' '}
            <FieldHelp title="LLM provider">
              Pick from the providers you&apos;ve already configured.
            </FieldHelp>
          </Label>
          <Select
            value={draft.provider || undefined}
            onValueChange={(value) => setDraft({ ...draft, provider: value })}
            disabled={submitting}
          >
            <SelectTrigger id="agent-provider">
              <SelectValue placeholder="Pick a provider" />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.slug} value={p.slug}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-model">
            Model{' '}
            <FieldHelp title="LLM model">
              The exact model identifier the provider exposes.{' '}
              <Link href="/admin/orchestration/learning" className="underline">
                Learn more
              </Link>
              .
            </FieldHelp>
          </Label>
          <Select
            value={draft.model || undefined}
            onValueChange={(value) => setDraft({ ...draft, model: value })}
            disabled={submitting || filteredModels.length === 0}
          >
            <SelectTrigger id="agent-model">
              <SelectValue placeholder="Pick a model" />
            </SelectTrigger>
            <SelectContent>
              {filteredModels.length === 0 ? (
                <SelectItem value="__none" disabled>
                  No models for this provider
                </SelectItem>
              ) : (
                filteredModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.id}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && <div className="text-destructive text-sm">{error}</div>}

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Creating…
            </>
          ) : (
            'Create agent'
          )}
        </Button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------------------------
// Step 4 — Test agent via SSE chat
// ----------------------------------------------------------------------------

interface StepTestAgentProps {
  agentSlug: string;
  onNext: () => void;
}

function StepTestAgent({ agentSlug, onNext }: StepTestAgentProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Send a quick test message. If you see a reply, your agent, provider, and LLM wiring are all
        working.
      </p>

      <AgentTestChat agentSlug={agentSlug} />

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Step 5 — Done / next steps
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
