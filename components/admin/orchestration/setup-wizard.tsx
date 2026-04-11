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
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';

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

function StepIntro({ onSkip }: { onSkip: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        Tell us what you&apos;re trying to build and we&apos;ll suggest a pattern — a reflection
        agent, a multi-step workflow, a retrieval-augmented chat, or something else.
      </p>
      <div className="rounded-md border border-dashed p-4">
        <div className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Coming soon: pattern advisor
        </div>
        <Textarea disabled placeholder="Describe your goal in one or two sentences…" rows={3} />
        <p className="text-muted-foreground mt-2 text-xs">
          The pattern advisor arrives in Phase 6. For now, skip ahead and configure your first agent
          manually — you can always come back and re-run the wizard later.
        </p>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={onSkip}>
          Skip &amp; continue
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
              Which provider fulfils requests for this agent. Must match a configured provider slug.
              Default: <code>anthropic</code>.
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
  const [message, setMessage] = useState('Hello! Can you tell me what you help with?');
  const [reply, setReply] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!agentSlug) {
      setError('No agent slug — go back and create an agent first.');
      return;
    }
    setError(null);
    setReply('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.CHAT_STREAM, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentSlug, message }),
      });

      if (!res.ok || !res.body) {
        setError('Chat stream failed to start. Try again in a moment.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Parse standard SSE: blocks separated by "\n\n", each block a set of
      // `event:` / `data:` lines.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sepIndex;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const event = parseSseBlock(block);
          if (!event) continue;

          if (event.type === 'content' && typeof event.data.content === 'string') {
            const chunk = event.data.content;
            setReply((prev) => prev + chunk);
          } else if (event.type === 'error') {
            // Never forward raw server error text to the UI — show a friendly
            // fallback. Detailed errors are logged server-side only.
            setError('The agent ran into a problem. Check the server logs for details.');
            return;
          } else if (event.type === 'done') {
            return;
          }
        }
      }
    } catch (err) {
      // Swallow abort-on-unmount; show a friendly message for everything else.
      if (err instanceof Error && err.name === 'AbortError') return;
      setError('Could not reach the chat stream. Try again in a moment.');
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        Send a quick test message. If you see a reply, your agent, provider, and LLM wiring are all
        working.
      </p>

      <form
        onSubmit={(e) => {
          void handleSend(e);
        }}
        className="space-y-2"
      >
        <Label htmlFor="chat-input">Your message</Label>
        <Textarea
          id="chat-input"
          rows={2}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={streaming}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={streaming || !message.trim()}>
            {streaming ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Streaming…
              </>
            ) : (
              'Send'
            )}
          </Button>
        </div>
      </form>

      <div className="bg-muted/30 min-h-[100px] rounded-md border p-3 text-sm whitespace-pre-wrap">
        {reply || (
          <span className="text-muted-foreground">Agent reply will appear here as it streams.</span>
        )}
      </div>

      {error && <div className="text-destructive text-sm">{error}</div>}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  );
}

interface ParsedSseEvent {
  type: string;
  data: Record<string, unknown>;
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split('\n');
  let eventType: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment / keepalive
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!eventType || dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    return { type: eventType, data };
  } catch {
    return null;
  }
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
