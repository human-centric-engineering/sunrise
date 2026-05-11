'use client';

/**
 * DefaultModelsForm — picks the system default model for each task
 * (routing / chat / reasoning / embeddings) used by agents that
 * resolve their binding dynamically (system seeds with empty
 * `provider`/`model`, plus the embedding pipeline).
 *
 * Lives on the Settings page — previously co-located with the Costs
 * page, which made it hard to find. The Costs page now links here
 * from a small "Edit default models" card.
 *
 * Schema-only structural validation client-side; the server
 * re-validates every model id against the registry on PATCH /settings.
 *
 * Dropdowns are populated from the `/models` response; not
 * tier-restricted (admins may deliberately override, e.g. run routing
 * on a frontier model). Every non-trivial field is wrapped in
 * `<FieldHelp>` per the cross-cutting contextual help directive.
 */

import Link from 'next/link';
import * as React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, Check, Loader2, Save, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { TASK_TYPES, type OrchestrationSettings, type TaskType } from '@/types/orchestration';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export interface ProviderSummary {
  slug: string;
  name: string;
  isActive: boolean;
}

export interface EmbeddingModelSummary {
  /** Composite id "provider/model" — used as the SelectItem value too. */
  id: string;
  name: string;
  /** Display name of the provider (e.g. "OpenAI", "Voyage AI"). */
  provider: string;
  /** Bare model id sent to the provider API (e.g. "text-embedding-3-small"). */
  model: string;
}

/**
 * Audio-capable matrix rows used to populate the Audio default dropdown.
 * Sourced from `GET /provider-models?capability=audio&isActive=true` —
 * audio support is matrix-driven (per-row `capabilities: ['audio']`),
 * not part of the static chat model registry.
 */
export interface AudioModelSummary {
  /** Bare model id sent to provider.transcribe() (e.g. "whisper-1"). */
  model: string;
  /** Display name of the matrix row (e.g. "Whisper v1"). */
  name: string;
  /** Provider slug — matched against `providers` to scope the dropdown. */
  providerSlug: string;
}

export interface DefaultModelsFormProps {
  settings: OrchestrationSettings | null;
  /** Chat-capable models from the registry (chat / routing / reasoning). */
  models: ModelInfo[] | null;
  /** Configured providers — used to scope dropdowns and gate the no-provider CTA. */
  providers?: ProviderSummary[];
  /** Embedding-capable models, sourced from /embedding-models. */
  embeddingModels?: EmbeddingModelSummary[];
  /** Audio-capable matrix rows, sourced from /provider-models?capability=audio. */
  audioModels?: AudioModelSummary[];
}

// Narrower client-side schema — the server re-validates every model id
// against the registry, so we only enforce the structural parts here.
// Empty strings are valid: they mean "no operator override; use the
// system suggestion at runtime". Non-empty strings get round-tripped
// through the matrix-validated schema on the server.
const settingsFormSchema = z.object({
  routing: z.string(),
  chat: z.string(),
  reasoning: z.string(),
  embeddings: z.string(),
  audio: z.string(),
});

type SettingsFormData = z.input<typeof settingsFormSchema>;

const TASK_LABELS: Record<TaskType, { label: string; help: React.ReactNode }> = {
  routing: {
    label: 'Routing model',
    help: (
      <>
        <p>
          Used for fast classification decisions (e.g. &ldquo;which specialist agent should handle
          this question?&rdquo;). A cheap, fast model is usually the right choice.
        </p>
        <p>
          Typical picks: <code>claude-haiku-4-5</code>, <code>gpt-4o-mini</code>, or a local
          7B-class model.
        </p>
      </>
    ),
  },
  chat: {
    label: 'Default chat model',
    help: (
      <>
        <p>
          Fallback model for agents that have not explicitly set their own model. Changing this
          immediately affects every agent using the &ldquo;use default&rdquo; option. A mid-range
          model balances cost and quality for most use cases.
        </p>
        <p>
          Typical picks: <code>claude-sonnet-4-6</code> or <code>gpt-4o</code>.
        </p>
      </>
    ),
  },
  reasoning: {
    label: 'Reasoning model',
    help: (
      <>
        <p>
          Used for multi-step reasoning tasks (tool loops, complex planning, capability
          orchestration). These tasks need the strongest reasoning, so pick the most capable (and
          typically most expensive) model your provider offers.
        </p>
        <p>
          Typical picks: <code>claude-opus-4-6</code> or <code>o1</code>-class models.
        </p>
      </>
    ),
  },
  embeddings: {
    label: 'Embeddings model',
    help: (
      <>
        <p>
          Converts text into numeric vectors so the knowledge base can find relevant documents. Used
          both when documents are uploaded (ingest) and when the agent searches (query).
        </p>
        <p>
          <strong>Important:</strong> different models produce different vectors, so if you change
          this, existing document embeddings won&apos;t match new query embeddings. After switching,
          go to the Knowledge Base page and click &ldquo;Generate Embeddings&rdquo; to re-process
          all documents.
        </p>
      </>
    ),
  },
  audio: {
    label: 'Audio (speech-to-text) model',
    help: (
      <>
        <p>
          Used by <code>/admin/orchestration/chat/transcribe</code> and{' '}
          <code>/embed/speech-to-text</code> when an operator records voice in an agent that has{' '}
          <code>enableVoiceInput</code> set. Picks which row <code>getAudioProvider()</code> returns
          at runtime — without an override, the runtime falls back to matrix order (
          <code>isDefault DESC, createdAt ASC</code>).
        </p>
        <p>
          Currently supports OpenAI-API-compatible providers (OpenAI, Groq, Together, Fireworks).
          Bespoke audio providers (Deepgram, AssemblyAI) need a dedicated <code>transcribe()</code>{' '}
          implementation — coming in a future release.
        </p>
        <p>
          Options come from the model matrix — any row with <code>capability: audio</code>. Add one
          in the matrix if the dropdown is empty.
        </p>
      </>
    ),
  },
};

export function DefaultModelsForm({
  settings,
  models,
  providers = [],
  embeddingModels = [],
  audioModels = [],
}: DefaultModelsFormProps) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);

  // The form's source of truth is `defaultModelsStored` — what the
  // operator has actually saved. `defaultModels` (hydrated) is only
  // used to compute the per-slot suggestion shown below an empty
  // dropdown. This makes "I haven't picked anything" visually
  // distinct from "I picked these models".
  const stored = settings?.defaultModelsStored ?? {};
  const hydrated = settings?.defaultModels;

  const defaults: SettingsFormData = React.useMemo(
    () => ({
      routing: stored.routing ?? '',
      chat: stored.chat ?? '',
      reasoning: stored.reasoning ?? '',
      embeddings: stored.embeddings ?? '',
      audio: stored.audio ?? '',
    }),
    // `stored` is rebuilt every render from `settings`; depend on the
    // parent's identity to avoid the useMemo running every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings]
  );

  const {
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isDirty },
  } = useForm<SettingsFormData>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: defaults,
  });

  React.useEffect(() => {
    reset(defaults);
  }, [defaults, reset]);

  // Configured-provider gate. The form refuses to show dropdowns when
  // there are no providers — the operator can't pick a model that
  // belongs to a provider Sunrise can't reach.
  const configuredProviderSlugs = React.useMemo(
    () => new Set(providers.filter((p) => p.isActive).map((p) => p.slug)),
    [providers]
  );
  const hasAnyProvider = configuredProviderSlugs.size > 0;

  // Chat / routing / reasoning dropdowns are filtered to models whose
  // provider is configured. Showing GPT models when only Anthropic is
  // wired up would be misleading.
  const chatLikeOptions = React.useMemo(
    () => (models ?? []).filter((m) => configuredProviderSlugs.has(m.provider)),
    [models, configuredProviderSlugs]
  );

  // Embeddings is sourced from a different registry (only models that
  // can actually embed). We map it onto the same shape the SelectItem
  // expects so the JSX below stays uniform.
  const embeddingOptions = React.useMemo(
    () =>
      embeddingModels
        // EmbeddingModelSummary.provider is the display name; the
        // configured set is keyed by slug. We compare against the model's
        // bare `model` id is fine for display, but we filter using a
        // case-insensitive provider-name match against the configured
        // provider names rather than slugs to keep the join honest.
        .filter((m) => {
          const matchSlug = providers.some(
            (p) => p.isActive && (p.slug === m.provider.toLowerCase() || p.name === m.provider)
          );
          return matchSlug;
        })
        .map((m) => ({
          id: m.model,
          label: `${m.name} (${m.provider})`,
        })),
    [embeddingModels, providers]
  );

  // Audio is matrix-driven: rows come from /provider-models?capability=audio.
  // Scope to configured-active providers — listing OpenAI's whisper-1
  // when OpenAI isn't wired up would be misleading.
  const audioOptions = React.useMemo(
    () =>
      audioModels
        .filter((m) => configuredProviderSlugs.has(m.providerSlug))
        .map((m) => ({
          id: m.model,
          label: `${m.name} (${m.providerSlug})`,
        })),
    [audioModels, configuredProviderSlugs]
  );

  const onSubmit = async (data: SettingsFormData) => {
    setSubmitting(true);
    setError(null);
    try {
      const parsed = settingsFormSchema.parse(data);
      // Server schema rejects empty strings (`z.string().min(1)`); filter
      // them out so a partial save (e.g. only chat picked, embeddings
      // left blank) doesn't 400 the whole request. The server merges by
      // key, so any slot we omit keeps its existing stored value.
      const defaultModels = Object.fromEntries(
        TASK_TYPES.flatMap((task) => {
          const v = parsed[task];
          return v && v.length > 0 ? [[task, v]] : [];
        })
      );
      const payload = { defaultModels };
      await apiClient.patch<OrchestrationSettings>(API.ADMIN.ORCHESTRATION.SETTINGS, {
        body: payload,
      });
      reset(data);
      setSavedAt(new Date());
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not save settings. Try again in a moment.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
      <Card data-testid="default-models-form">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Default models</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              Used by system-seeded agents and any agent with an empty <code>provider</code> /{' '}
              <code>model</code> binding. Each task type can pick a different model.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {savedAt && !isDirty && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <Check className="h-3 w-3 text-emerald-500" />
                Saved
              </span>
            )}
            <Button type="submit" size="sm" disabled={submitting || !isDirty}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save changes
                </>
              )}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {!settings && (
            <div className="flex items-center gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/20 dark:text-amber-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Settings could not be loaded. The values below may not reflect the current
              configuration. Try refreshing the page.
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {!hasAnyProvider ? (
            <NoProvidersCTA />
          ) : (
            <section className="space-y-4">
              <h3 className="text-sm font-semibold">Default model assignments</h3>
              <p className="text-muted-foreground text-xs">
                Required — system-seeded agents and any agent with an empty <code>provider</code>/
                <code>model</code> binding refuse to run when these are unset. Pick a model in each
                row, or click <em>Use suggestion</em>.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {TASK_TYPES.map((task) => {
                  const isEmbeddings = task === 'embeddings';
                  const isAudio = task === 'audio';
                  const optionsForTask = isEmbeddings
                    ? embeddingOptions.map((e) => ({ id: e.id, label: e.label }))
                    : isAudio
                      ? audioOptions
                      : chatLikeOptions.map((m) => ({
                          id: m.id,
                          label: `${m.name} (${m.tier})`,
                        }));
                  // Drop suggestions that aren't actually in the dropdown for
                  // this slot — e.g. a chat-tier model proposed for embeddings.
                  // Showing "Suggested: gpt-4o-mini" when gpt-4o-mini isn't in
                  // the embeddings dropdown is misleading and the
                  // "Use suggestion" button is already a no-op for those ids.
                  const rawSuggested = hydrated?.[task] ?? '';
                  const suggested = optionsForTask.some((o) => o.id === rawSuggested)
                    ? rawSuggested
                    : '';
                  const suggestedLabel =
                    optionsForTask.find((o) => o.id === suggested)?.label ?? suggested;

                  return (
                    <div key={task} className="space-y-1.5">
                      <Label htmlFor={`model-${task}`} className="flex items-center gap-1">
                        {TASK_LABELS[task].label}
                        <FieldHelp title={TASK_LABELS[task].label}>
                          {TASK_LABELS[task].help}
                        </FieldHelp>
                      </Label>
                      <Controller
                        name={task}
                        control={control}
                        render={({ field }) => {
                          const isStored = field.value !== '';
                          return (
                            <>
                              <Select
                                value={field.value || undefined}
                                onValueChange={field.onChange}
                                disabled={optionsForTask.length === 0}
                              >
                                <SelectTrigger id={`model-${task}`}>
                                  <SelectValue placeholder="Not set — pick a model" />
                                </SelectTrigger>
                                <SelectContent>
                                  {optionsForTask.length === 0 ? (
                                    <SelectItem value="__none" disabled>
                                      No options
                                    </SelectItem>
                                  ) : (
                                    optionsForTask.map((o) => (
                                      <SelectItem key={o.id} value={o.id}>
                                        {o.label}
                                      </SelectItem>
                                    ))
                                  )}
                                </SelectContent>
                              </Select>
                              {/* When the slot has no available options
                                  AND nothing is saved, surface a helpful
                                  hint instead of the suggestion footer.
                                  Embeddings is the most likely case here
                                  (Anthropic has no embeddings) but the
                                  same UX makes sense for any task. */}
                              {!isStored && optionsForTask.length === 0 ? (
                                isEmbeddings ? (
                                  <NoEmbeddingProviderHint />
                                ) : isAudio ? (
                                  <NoAudioProviderHint />
                                ) : (
                                  <NoOptionsHint task={task} />
                                )
                              ) : (
                                <SuggestionFooter
                                  isStored={isStored}
                                  suggested={suggested}
                                  suggestedLabel={suggestedLabel}
                                  onUseSuggestion={() => {
                                    if (
                                      suggested &&
                                      optionsForTask.some((o) => o.id === suggested)
                                    ) {
                                      setValue(task, suggested, {
                                        shouldDirty: true,
                                        shouldValidate: true,
                                      });
                                    }
                                  }}
                                  onClear={() => {
                                    setValue(task, '', {
                                      shouldDirty: true,
                                      shouldValidate: true,
                                    });
                                  }}
                                />
                              )}
                            </>
                          );
                        }}
                      />
                      {errors[task] && (
                        <p className="text-xs text-red-600">{errors[task]?.message as string}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </CardContent>
      </Card>
    </form>
  );
}

/**
 * Per-slot footer below each task dropdown:
 *
 *   - When the operator hasn't saved a value (`isStored: false`), show
 *     the system's computed suggestion plus a "Use suggestion" button
 *     that commits the suggestion as a saved value (marks the form
 *     dirty so Save lights up).
 *
 *   - When the operator has saved a value (`isStored: true`), show
 *     a small "Clear" link that drops the saved override and falls
 *     back to the system suggestion at runtime.
 *
 * Keeps the "saved" vs "auto" distinction visible so operators don't
 * mistake a hydrated suggestion for a deliberate selection.
 */
function SuggestionFooter({
  isStored,
  suggested,
  suggestedLabel,
  onUseSuggestion,
  onClear,
}: {
  isStored: boolean;
  suggested: string;
  suggestedLabel: string;
  onUseSuggestion: () => void;
  onClear: () => void;
}): React.ReactElement {
  if (isStored) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <Check className="h-3 w-3 text-emerald-500" aria-hidden="true" />
        <span className="text-muted-foreground">Saved override.</span>
        <button
          type="button"
          onClick={onClear}
          className="text-primary underline-offset-2 hover:underline"
        >
          Clear (use suggestion)
        </button>
      </div>
    );
  }

  if (!suggested) {
    return (
      <div className="text-muted-foreground text-xs italic">
        No suggestion available — pick a model from the dropdown.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        Suggested: <code className="bg-muted/60 rounded px-1 py-0.5">{suggestedLabel}</code>
      </span>
      <button
        type="button"
        onClick={onUseSuggestion}
        className="text-primary underline-offset-2 hover:underline"
      >
        Use suggestion
      </button>
    </div>
  );
}

/**
 * Card-style empty state shown when zero providers are configured. The
 * defaults form is non-functional in that state — operators must wire
 * a provider first. Linking back to the providers list (and the setup
 * wizard via the dashboard) keeps the path forward obvious.
 */
function NoProvidersCTA(): React.ReactElement {
  return (
    <div className="border-primary/30 bg-primary/5 dark:bg-primary/10 flex items-start gap-3 rounded-md border p-4 text-sm">
      <Sparkles className="text-primary mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="space-y-2">
        <p className="font-medium">No providers configured yet</p>
        <p className="text-muted-foreground">
          Default model assignments need at least one configured provider — the dropdowns would
          otherwise list models Sunrise can&apos;t actually reach. Configure a provider first and
          come back here to pick defaults.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button asChild size="sm">
            <Link href="/admin/orchestration/providers">Open Providers</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/orchestration">Run setup wizard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline footer for the embeddings dropdown when none of the
 * configured providers offer embedding models. Anthropic, Groq,
 * Together, Fireworks, etc. fall in this bucket — the operator needs
 * to add Voyage AI, OpenAI, Google, Mistral, or local Ollama for
 * knowledge-base vector search to work.
 */
function NoEmbeddingProviderHint(): React.ReactElement {
  return (
    <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>
        None of your configured providers offer embeddings. Add Voyage AI, OpenAI, Google, Mistral,
        or local Ollama before saving an embeddings default.
      </span>
    </div>
  );
}

/**
 * Inline footer for the audio dropdown when no audio-capable matrix
 * rows exist for the configured providers. Audio support is matrix-
 * driven — the operator has to seed a row with `capability: audio` in
 * the provider-models matrix before the dropdown can offer anything.
 * Most common reason in practice: voice input enabled but no Whisper-
 * style row added for OpenAI / Groq yet.
 */
function NoAudioProviderHint(): React.ReactElement {
  return (
    <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
      <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>
        No audio model in the matrix for your configured providers. Add a row with{' '}
        <code>capability: audio</code> (e.g. OpenAI <code>whisper-1</code> or Groq{' '}
        <code>whisper-large-v3</code>) in the model matrix before enabling voice input on agents.
      </span>
    </div>
  );
}

/**
 * Generic "no options" hint for chat / routing / reasoning when the
 * registry returns nothing matching the configured providers (e.g.
 * the OpenRouter cache is cold and only the matrix-seeded models are
 * available, but the operator's configured provider isn't represented
 * in either).
 */
function NoOptionsHint({ task }: { task: TaskType }): React.ReactElement {
  return (
    <div className="text-muted-foreground flex items-start gap-1.5 text-xs italic">
      No {task} models available for the configured providers — try refreshing the model registry or
      configuring a different provider.
    </div>
  );
}
