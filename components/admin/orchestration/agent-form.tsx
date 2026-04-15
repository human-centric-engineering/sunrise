'use client';

/**
 * AgentForm (Phase 4 Session 4.2)
 *
 * Shared create / edit form for `AiAgent`. One `<form>`, five shadcn tabs,
 * one PATCH (or POST). Tabs are layout, not save boundaries.
 *
 * Pattern follows `components/admin/feature-flag-form.tsx`:
 *   raw react-hook-form + `zodResolver`, no shadcn Form wrapper.
 *
 * Every non-trivial field is wrapped in `<FieldHelp>`. This is the
 * reference implementation of the contextual-help directive for the
 * rest of Phase 4 — copy the voice, not just the structure.
 */

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { AlertCircle, Loader2, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { AgentTestChat } from '@/components/admin/orchestration/agent-test-chat';
import { InstructionsHistoryPanel } from '@/components/admin/orchestration/instructions-history-panel';
import { AgentCapabilitiesTab } from '@/components/admin/orchestration/agent-capabilities-tab';
import { ProviderTestButton } from '@/components/admin/orchestration/provider-test-button';
import type { AiAgent, AiProviderConfig } from '@/types/prisma';

/**
 * Form schema — a hand-picked subset of the create schema. We keep the
 * client-side validation intentionally narrower than the server to avoid
 * divergence on the enum/record fields (metadata, providerConfig) that the
 * form doesn't expose.
 */
const agentFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, and hyphens only'),
  description: z.string().min(1, 'Description is required').max(5000),
  systemInstructions: z.string().min(1, 'System instructions are required').max(50000),
  provider: z.string().min(1, 'Provider is required'),
  model: z.string().min(1, 'Model is required'),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(200000),
  monthlyBudgetUsd: z.number().positive().max(10000).optional(),
  isActive: z.boolean(),
});

type AgentFormData = z.infer<typeof agentFormSchema>;

export interface ModelOption {
  /** Provider slug this model belongs to (`anthropic`, `openai`, etc.). */
  provider: string;
  /** Model identifier the provider exposes. */
  id: string;
  /** Tier label used for the dropdown hint (`frontier`, `mid`, `budget`). */
  tier?: string;
}

export interface AgentFormProps {
  mode: 'create' | 'edit';
  agent?: AiAgent;
  providers: (AiProviderConfig & { apiKeyPresent?: boolean })[] | null;
  models: ModelOption[] | null;
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

export function AgentForm({ mode, agent, providers, models }: AgentFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(isEdit);

  const providerFallback = !providers || providers.length === 0;
  const modelFallback = !models || models.length === 0;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<AgentFormData>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: agent?.name ?? '',
      slug: agent?.slug ?? '',
      description: agent?.description ?? '',
      systemInstructions: agent?.systemInstructions ?? '',
      provider: agent?.provider ?? 'anthropic',
      model: agent?.model ?? 'claude-opus-4-6',
      temperature: agent?.temperature ?? 0.7,
      maxTokens: agent?.maxTokens ?? 4096,
      monthlyBudgetUsd: agent?.monthlyBudgetUsd ?? undefined,
      isActive: agent?.isActive ?? true,
    },
  });

  const currentProvider = watch('provider');
  const currentModel = watch('model');
  const currentTemp = watch('temperature');
  const currentName = watch('name');
  const currentInstructions = watch('systemInstructions');
  const currentIsActive = watch('isActive');

  // Auto-generate slug from name in create mode until the user edits the slug.
  useEffect(() => {
    if (isEdit || slugTouched) return;
    if (currentName) setValue('slug', toSlug(currentName), { shouldValidate: false });
  }, [currentName, slugTouched, isEdit, setValue]);

  const filteredModels = models?.filter((m) => m.provider === currentProvider) ?? [];

  const onSubmit = async (data: AgentFormData) => {
    setSubmitting(true);
    setError(null);
    try {
      if (isEdit && agent) {
        await apiClient.patch<AiAgent>(API.ADMIN.ORCHESTRATION.agentById(agent.id), {
          body: data,
        });
        // Re-seed the form with what we just saved so dirty-state clears.
        reset(data);
      } else {
        const created = await apiClient.post<AiAgent>(API.ADMIN.ORCHESTRATION.AGENTS, {
          body: data,
        });
        router.push(`/admin/orchestration/agents/${created.id}`);
      }
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Could not save agent. Try again in a moment.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const currentProviderId = providers?.find((p) => p.slug === currentProvider)?.id ?? null;

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-6">
      {/* Sticky action bar */}
      <div className="bg-background/95 sticky top-0 z-10 -mx-2 flex items-center justify-between border-b px-2 py-3 backdrop-blur">
        <div>
          <h1 className="text-xl font-semibold">{isEdit ? agent?.name : 'New agent'}</h1>
          {isEdit && <p className="text-muted-foreground font-mono text-xs">{agent?.slug}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/agents">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                {isEdit ? 'Save changes' : 'Create agent'}
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="model">Model</TabsTrigger>
          <TabsTrigger value="instructions">Instructions</TabsTrigger>
          <TabsTrigger
            value="capabilities"
            disabled={!isEdit}
            title={!isEdit ? 'Save the agent first to attach capabilities' : undefined}
          >
            Capabilities
          </TabsTrigger>
          <TabsTrigger
            value="test"
            disabled={!isEdit}
            title={!isEdit ? 'Save the agent first to test a chat' : undefined}
          >
            Test
          </TabsTrigger>
        </TabsList>

        {/* ================= TAB 1 — GENERAL ================= */}
        <TabsContent value="general" className="space-y-4 pt-4">
          <div className="grid gap-2">
            <Label htmlFor="name">
              Name{' '}
              <FieldHelp title="Agent name">
                A human-readable label. This is what admins and end-users see in lists and in the
                chat UI. Defaults to empty.{' '}
                <Link href="/admin/orchestration/learning" className="underline">
                  Learn more
                </Link>
              </FieldHelp>
            </Label>
            <Input id="name" {...register('name')} placeholder="Research Assistant" />
            {errors.name && <p className="text-destructive text-xs">{errors.name.message}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="slug">
              Slug{' '}
              <FieldHelp title="URL-safe identifier">
                The stable identifier used in URLs and the chat stream endpoint. Auto-generated from
                the name on first type, but you can edit it. Lowercase letters, numbers, and hyphens
                only.{' '}
                <Link href="/admin/orchestration/learning" className="underline">
                  Learn more
                </Link>
              </FieldHelp>
            </Label>
            <Input
              id="slug"
              {...register('slug')}
              onChange={(e) => {
                setSlugTouched(true);
                setValue('slug', e.target.value, { shouldValidate: true });
              }}
              disabled={isEdit}
              className="font-mono"
              placeholder="research-assistant"
            />
            {errors.slug && <p className="text-destructive text-xs">{errors.slug.message}</p>}
            {isEdit && (
              <p className="text-muted-foreground text-xs">
                Slug cannot be changed after creation.
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="description">
              Description{' '}
              <FieldHelp title="What this agent does">
                A short summary that helps other admins understand this agent at a glance. It
                appears on the agents list page and in search results. Keep it to one or two
                sentences — e.g. &ldquo;Answers customer billing questions using the help docs
                knowledge base&rdquo; or &ldquo;Triages incoming support requests and routes to
                specialists.&rdquo;
              </FieldHelp>
            </Label>
            <Textarea
              id="description"
              rows={3}
              {...register('description')}
              placeholder="Summarizes research papers and answers follow-up questions."
            />
            {errors.description && (
              <p className="text-destructive text-xs">{errors.description.message}</p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="isActive">
                Active{' '}
                <FieldHelp title="Is this agent available?">
                  Inactive agents are hidden from consumer lists and reject new chats. Existing
                  conversations, cost logs, and history are preserved. Default: on.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-sm">
                Toggle this off to pause the agent without deleting it.
              </p>
            </div>
            <Switch
              id="isActive"
              checked={currentIsActive}
              onCheckedChange={(v) => setValue('isActive', v)}
            />
          </div>
        </TabsContent>

        {/* ================= TAB 2 — MODEL ================= */}
        <TabsContent value="model" className="space-y-4 pt-4">
          {(providerFallback || modelFallback) && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              We couldn&apos;t load the provider or model list from the server. You can still enter
              a provider slug and model id by hand below.
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="provider">
              Provider{' '}
              <FieldHelp title="LLM provider">
                The AI service that powers this agent (e.g. Anthropic for Claude, OpenAI for GPT, or
                a local Ollama server). Each provider is configured on the{' '}
                <Link href="/admin/orchestration/providers" className="underline">
                  Providers page
                </Link>{' '}
                with its own API key. If the selected provider&apos;s key is missing, this agent
                won&apos;t be able to respond — look for the red &ldquo;no key&rdquo; indicator in
                the dropdown. Default: <code>anthropic</code>.
              </FieldHelp>
            </Label>
            {providerFallback ? (
              <Input id="provider" {...register('provider')} className="font-mono" />
            ) : (
              <Select
                value={currentProvider}
                onValueChange={(v) => setValue('provider', v, { shouldValidate: true })}
              >
                <SelectTrigger id="provider">
                  <SelectValue placeholder="Pick a provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.slug}>
                      <span className="flex items-center gap-2">
                        {p.name}
                        {p.apiKeyPresent ? (
                          <span className="text-xs text-green-600">● key set</span>
                        ) : (
                          <span className="text-xs text-red-600">● no key</span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="model">
              Model{' '}
              <FieldHelp title="Which model answers">
                The specific AI model this agent uses. Changing it switches which model actually
                answers — cost, speed, and quality all shift. Smaller models (e.g. Haiku, GPT-4o
                mini) are faster and cheaper; larger models (e.g. Opus, GPT-4o) are more capable but
                cost more per message. Default: <code>claude-opus-4-6</code>.
              </FieldHelp>
            </Label>
            {modelFallback || filteredModels.length === 0 ? (
              <Input id="model" {...register('model')} className="font-mono" />
            ) : (
              <Select
                value={currentModel}
                onValueChange={(v) => setValue('model', v, { shouldValidate: true })}
              >
                <SelectTrigger id="model">
                  <SelectValue placeholder="Pick a model" />
                </SelectTrigger>
                <SelectContent>
                  {filteredModels.map((m) => (
                    <SelectItem key={`${m.provider}:${m.id}`} value={m.id}>
                      {m.id}
                      {m.tier ? ` — ${m.tier}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-2">
            <Label>
              Temperature: <span className="tabular-nums">{currentTemp.toFixed(2)}</span>{' '}
              <FieldHelp title="Creativity dial">
                How much the model varies its wording. 0 = always picks the most likely next word
                (good for deterministic tasks). 1 = balanced. 2 = very creative, sometimes
                incoherent. Default: <code>0.7</code>.
              </FieldHelp>
            </Label>
            <Slider
              min={0}
              max={2}
              step={0.05}
              value={[currentTemp]}
              onValueChange={([v]) => setValue('temperature', v, { shouldValidate: true })}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="maxTokens">
              Max output tokens{' '}
              <FieldHelp title="Maximum reply length">
                Upper bound on how long one reply can be, measured in tokens (roughly &frac34; of a
                word — so 4 096 tokens &asymp; 3 000 words). Defaults to <code>4096</code>. Only
                raise this if replies are getting cut off — higher values cost more on every turn.
              </FieldHelp>
            </Label>
            <Input
              id="maxTokens"
              type="number"
              {...register('maxTokens', { valueAsNumber: true })}
            />
            {errors.maxTokens && (
              <p className="text-destructive text-xs">{errors.maxTokens.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="monthlyBudgetUsd">
              Monthly budget (USD){' '}
              <FieldHelp title="Hard spend cap">
                Hard spend cap for this agent, in USD. When month-to-date spend reaches the cap, new
                chats are rejected with a friendly &ldquo;budget exhausted&rdquo; message until the
                calendar month rolls over or you raise the limit. For example, $10.00 would allow
                roughly 2 000–5 000 conversations depending on model and reply length. Leave blank
                to disable the cap.
              </FieldHelp>
            </Label>
            <Input
              id="monthlyBudgetUsd"
              type="number"
              step="0.01"
              {...register('monthlyBudgetUsd', {
                setValueAs: (v: string | number) =>
                  v === '' || v === null || v === undefined ? undefined : Number(v),
              })}
            />
          </div>

          <div className="pt-2">
            <ProviderTestButton
              providerId={currentProviderId}
              disabledMessage="We don't have a stored config for this provider yet — save it first."
            />
          </div>
        </TabsContent>

        {/* ================= TAB 3 — INSTRUCTIONS ================= */}
        <TabsContent value="instructions" className="space-y-4 pt-4">
          <div className="grid gap-2">
            <Label htmlFor="systemInstructions">
              System instructions{' '}
              <FieldHelp title="The persona and task">
                The instructions the AI reads before every conversation — its personality, what it
                should and shouldn&apos;t do, and any formatting rules. Think of it as a job
                description the model follows on every reply. Every time you save changes here, a
                timestamped copy is kept in the version history below so you can compare or roll
                back.
              </FieldHelp>
            </Label>
            <Textarea
              id="systemInstructions"
              rows={16}
              {...register('systemInstructions')}
              className="font-mono text-xs"
            />
            <div className="text-muted-foreground flex justify-between text-xs">
              <span>
                {errors.systemInstructions ? (
                  <span className="text-destructive">{errors.systemInstructions.message}</span>
                ) : (
                  'Changes are saved when you click Save changes.'
                )}
              </span>
              <span>{currentInstructions.length.toLocaleString()} characters</span>
            </div>
          </div>

          {isEdit && agent && (
            <InstructionsHistoryPanel
              agentId={agent.id}
              onReverted={() => {
                // Revert mutates the server-side instructions; re-pull the
                // fresh agent into the form so the textarea reflects reality.
                void (async () => {
                  try {
                    const fresh = await apiClient.get<AiAgent>(
                      API.ADMIN.ORCHESTRATION.agentById(agent.id)
                    );
                    setValue('systemInstructions', fresh.systemInstructions, {
                      shouldValidate: true,
                    });
                  } catch {
                    // Silent — the panel already shows its own error state.
                  }
                })();
              }}
            />
          )}
        </TabsContent>

        {/* ================= TAB 4 — CAPABILITIES ================= */}
        <TabsContent value="capabilities" className="pt-4">
          {isEdit && agent ? (
            <AgentCapabilitiesTab agentId={agent.id} />
          ) : (
            <div className="rounded-md border p-6 text-center text-sm">
              <p className="text-muted-foreground">
                Save the agent first, then attach capabilities.
              </p>
            </div>
          )}
        </TabsContent>

        {/* ================= TAB 5 — TEST ================= */}
        <TabsContent value="test" className="pt-4">
          {isEdit && agent ? (
            <AgentTestChat agentSlug={agent.slug} minHeight="min-h-[200px]" />
          ) : (
            <div className="rounded-md border p-6 text-center text-sm">
              <p className="text-muted-foreground">Save the agent first to test a chat.</p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </form>
  );
}
