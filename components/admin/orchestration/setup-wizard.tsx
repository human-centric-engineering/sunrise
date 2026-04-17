'use client';

/**
 * Setup Wizard (Phase 4 Session 4.1)
 *
 * Five-step guided flow that walks a new admin from "fresh install" to
 * "I have a working agent I can chat with". Wraps a Dialog and lazy-
 * loads its own state from localStorage so progress survives a refresh.
 *
 * Steps:
 *   1. What are you building? — Phase 6 pattern advisor placeholder
 *   2. Configure a provider    — probes `/providers`, inline form if empty
 *   3. Create your first agent — inline form posting to `/agents`
 *   4. Test your agent         — SSE chat consumer reading ReadableStream
 *   5. What's next             — static links, marks wizard complete
 *
 * Errors never throw out of the dialog. Fetch failures become friendly
 * inline messages — the raw `err.message` from a fetch is not forwarded
 * to the UI (could leak provider SDK internals). Detailed errors are
 * logged to the server via `logger.error` in the underlying API routes,
 * not from this client component.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import { useWizard } from '@/lib/hooks/use-wizard';
import { API } from '@/lib/api/endpoints';
import { extractWorkflowDefinition } from '@/lib/orchestration/utils/extract-workflow-definition';

const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v1';
const TOTAL_STEPS = 5;

interface ProviderDraft {
  name: string;
  slug: string;
  apiKeyEnvVar: string;
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
  providerDraft: { name: '', slug: '', apiKeyEnvVar: '' },
  agentDraft: {
    name: '',
    slug: '',
    description: '',
    systemInstructions: '',
    model: 'claude-opus-4-6',
    provider: 'anthropic',
  },
  createdAgentSlug: null,
};

export interface SetupWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SetupWizard({ open, onOpenChange }: SetupWizardProps) {
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
          fetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=1`, { credentials: 'include' }),
          fetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=1`, { credentials: 'include' }),
        ]);

        if (cancelled) return;

        const hasProvider = await paginatedTotalGt0(providerRes);
        const hasAgent = await paginatedTotalGt0(agentRes);

        // Jump to the first incomplete step. Step 1 (intro) is always
        // shown the first time; if we already have an agent, skip to
        // step 4 (test).
        if (state.stepIndex === 0 && (hasProvider || hasAgent)) {
          if (hasAgent) wiz.goTo(3);
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
          {wiz.stepIndex === 2 && (
            <StepAgent
              draft={state.agentDraft}
              setDraft={(draft) => setState((prev) => ({ ...prev, agentDraft: draft }))}
              onCreated={(slug) => {
                setState((prev) => ({ ...prev, createdAgentSlug: slug }));
                wiz.next();
              }}
            />
          )}
          {wiz.stepIndex === 3 && (
            <StepTestAgent
              agentSlug={state.createdAgentSlug ?? state.agentDraft.slug}
              onNext={() => wiz.next()}
            />
          )}
          {wiz.stepIndex === 4 && <StepDone />}
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
  2: 'Create your first agent',
  3: 'Test your agent',
  4: "What's next",
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

function StepProvider({ draft, setDraft, onComplete }: StepProviderProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasExisting, setHasExisting] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=1`, {
          credentials: 'include',
        });
        if (cancelled) return;
        setHasExisting(await paginatedTotalGt0(res));
      } catch {
        if (!cancelled) setHasExisting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.PROVIDERS, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name,
          slug: draft.slug,
          providerType: 'anthropic',
          apiKeyEnvVar: draft.apiKeyEnvVar || undefined,
        }),
      });
      if (!res.ok) {
        setError('Could not create the provider. Check the name, slug, and env var and try again.');
        return;
      }
      onComplete();
    } catch {
      setError('Could not reach the server. Check your network and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (hasExisting === null) {
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
              Nothing to do here. Continue to create your first agent.
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

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
      className="space-y-4"
    >
      <p className="text-sm">
        Providers are how Sunrise talks to LLMs (Anthropic, OpenAI, etc.). The API key itself is
        read from an environment variable — never stored in the database.
      </p>

      <div className="space-y-2">
        <Label htmlFor="provider-name">
          Name{' '}
          <FieldHelp title="Provider name">
            A short human name like &quot;Anthropic prod&quot; or &quot;OpenAI staging&quot;. Shown
            in the admin UI so you can tell providers apart. Default: none.
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
            Default: none. Example: <code>anthropic-prod</code>.
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

      <div className="space-y-2">
        <Label htmlFor="provider-env">
          API key env var{' '}
          <FieldHelp title="API key environment variable">
            Name of the environment variable holding the real API key — e.g.{' '}
            <code>ANTHROPIC_API_KEY</code>. Must be SCREAMING_SNAKE_CASE. The key itself is never
            written to the database or logged.
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

      <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-900/50 dark:bg-blue-900/10 dark:text-blue-200">
        <p className="font-medium">Embedding providers</p>
        <p className="mt-1">
          This creates a <strong>chat</strong> provider. For knowledge base vector search you also
          need an <strong>embedding</strong> provider. We recommend <strong>Voyage AI</strong> (free
          tier, top retrieval quality) — add it later on the Providers page. Anthropic (Claude) does
          not offer an embeddings API.
        </p>
      </div>

      <div className="flex justify-end">
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
// Step 3 — Agent creation
// ----------------------------------------------------------------------------

interface StepAgentProps {
  draft: AgentDraft;
  setDraft: (draft: AgentDraft) => void;
  onCreated: (slug: string) => void;
}

function StepAgent({ draft, setDraft, onCreated }: StepAgentProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Minimal client-side guard — the server re-validates with Zod.
    if (
      !draft.name.trim() ||
      !draft.slug.trim() ||
      !draft.description.trim() ||
      !draft.systemInstructions.trim() ||
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
          provider: draft.provider.trim() || 'anthropic',
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
            Shown to end-users when the agent replies. Default: none.
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
            <code>support-triage</code>. Change this rarely — existing links break.
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
            One or two sentences explaining what this agent is for. Helps future admins (and the
            pattern explorer) understand its purpose at a glance.
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
            constraints. Changing this changes how every new conversation behaves — in-flight
            conversations keep their original prompt.
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
              The AI service that powers this agent (e.g. Anthropic, OpenAI, Ollama). Pick from the
              providers you&apos;ve already configured. If you only have one, it&apos;s
              pre-selected. Default: <code>anthropic</code>.
            </FieldHelp>
          </Label>
          <Input
            id="agent-provider"
            required
            value={draft.provider}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
            disabled={submitting}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-model">
            Model{' '}
            <FieldHelp title="LLM model">
              The exact model identifier the provider exposes. Changing this switches which model
              answers prompts. Default: <code>claude-opus-4-6</code>.{' '}
              <Link href="/admin/orchestration/learning" className="underline">
                Learn more
              </Link>
              .
            </FieldHelp>
          </Label>
          <Input
            id="agent-model"
            required
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            disabled={submitting}
          />
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
