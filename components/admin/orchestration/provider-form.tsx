'use client';

/**
 * ProviderForm (Phase 4 Session 4.3)
 *
 * Shared create / edit form for `AiProviderConfig`. Raw RHF + Zod,
 * sticky action bar, every non-trivial field wrapped in `<FieldHelp>`.
 *
 * **Flavor selector.** The backend knows three `providerType` values
 * (`anthropic`, `openai-compatible`, `voyage`) but the UI shows five
 * flavors:
 *
 *   - Anthropic         — `providerType: 'anthropic'`
 *   - OpenAI            — `providerType: 'openai-compatible'`, base URL
 *                         pinned to `https://api.openai.com/v1`
 *   - Voyage AI         — `providerType: 'voyage'`, embedding-focused
 *   - Ollama (Local)    — `providerType: 'openai-compatible'`,
 *                         `isLocal: true`, loopback base URL
 *   - OpenAI-Compatible — free-form base URL + optional env var
 *
 * The flavor drives which fields render. On submit, we compose the
 * backend payload from `{ flavor, name, slug, baseUrl?, apiKeyEnvVar?,
 * isActive, timeoutMs?, maxRetries? }`. On edit, we reverse-map the
 * provider row back to a flavor so the UI round-trips cleanly.
 *
 * API-key policy: the UI never accepts, stores, transmits, or renders
 * a raw API key value. The `apiKeyEnvVar` field is the *name* of an
 * env var (e.g. `ANTHROPIC_API_KEY`); the server reads
 * `process.env[…]` at request time. `apiKeyPresent` on the provider
 * row drives the green/red indicator next to the input.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { AlertCircle, Check, ChevronDown, ChevronRight, Loader2, Save, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { ProviderTestButton } from '@/components/admin/orchestration/provider-test-button';
import type { AiProviderConfig } from '@/types/prisma';

type Flavor =
  | 'anthropic'
  | 'openai'
  | 'voyage'
  | 'groq'
  | 'together'
  | 'fireworks'
  | 'mistral'
  | 'cohere'
  | 'google'
  | 'xai'
  | 'deepseek'
  | 'perplexity'
  | 'openrouter'
  | 'alibaba'
  | 'ollama'
  | 'openai-compatible';

interface FlavorMeta {
  id: Flavor;
  label: string;
  description: string;
  defaultName: string;
  defaultSlug: string;
  showBaseUrl: boolean;
  showApiKeyEnvVar: boolean;
  defaultBaseUrl: string | null;
  defaultApiKeyEnvVar: string | null;
  providerType: 'anthropic' | 'openai-compatible' | 'voyage';
  isLocal: boolean;
  group: 'frontier' | 'open-model' | 'embedding' | 'aggregator' | 'local' | 'custom';
}

const FLAVOR_GROUPS: { key: FlavorMeta['group']; label: string; description: string }[] = [
  {
    key: 'frontier',
    label: 'Frontier Providers',
    description: 'Proprietary models with leading capabilities',
  },
  {
    key: 'open-model',
    label: 'Open-Model Hosts',
    description: 'Cloud inference for open-source/open-weight models',
  },
  {
    key: 'embedding',
    label: 'Embedding Specialists',
    description: 'Dedicated embedding and retrieval models',
  },
  {
    key: 'aggregator',
    label: 'Aggregators & Enterprise',
    description: 'Multi-model routing, fallback, and compliance',
  },
  {
    key: 'local',
    label: 'Local / Self-Hosted',
    description: 'Run models on your own infrastructure',
  },
  { key: 'custom', label: 'Custom', description: 'Any OpenAI-compatible endpoint' },
];

const FLAVORS: readonly FlavorMeta[] = [
  // ── Frontier Providers ──────────────────────────────────────────────
  {
    id: 'anthropic',
    label: 'Anthropic',
    description:
      'Claude models (Haiku, Sonnet, Opus). No embedding support — pair with Voyage AI or OpenAI for vectors.',
    defaultName: 'Anthropic',
    defaultSlug: 'anthropic',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: null,
    defaultApiKeyEnvVar: 'ANTHROPIC_API_KEY',
    providerType: 'anthropic',
    isLocal: false,
    group: 'frontier',
  },
  {
    id: 'google',
    label: 'Google AI',
    description: 'Gemini models and text-embedding-004 via Google AI Studio.',
    defaultName: 'Google AI',
    defaultSlug: 'google',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultApiKeyEnvVar: 'GOOGLE_AI_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'frontier',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    description:
      'Mistral Large, Mixtral, and Mistral Embed. European AI lab with open-weight models.',
    defaultName: 'Mistral AI',
    defaultSlug: 'mistral',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    defaultApiKeyEnvVar: 'MISTRAL_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'frontier',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT models and text-embedding-3 embeddings.',
    defaultName: 'OpenAI',
    defaultSlug: 'openai',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultApiKeyEnvVar: 'OPENAI_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'frontier',
  },
  {
    id: 'xai',
    label: 'xAI',
    description: 'Grok models with strong reasoning and real-time knowledge.',
    defaultName: 'xAI',
    defaultSlug: 'xai',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultApiKeyEnvVar: 'XAI_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'frontier',
  },

  // ── Open-Model Hosts ────────────────────────────────────────────────
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek Chat and Coder. Very cost-efficient open-weight models.',
    defaultName: 'DeepSeek',
    defaultSlug: 'deepseek',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultApiKeyEnvVar: 'DEEPSEEK_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'open-model',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    description: 'Fast open-model inference with function calling support.',
    defaultName: 'Fireworks AI',
    defaultSlug: 'fireworks',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultApiKeyEnvVar: 'FIREWORKS_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'open-model',
  },
  {
    id: 'groq',
    label: 'Groq',
    description: 'Ultra-fast inference for Llama, Mixtral, and other open models.',
    defaultName: 'Groq',
    defaultSlug: 'groq',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultApiKeyEnvVar: 'GROQ_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'open-model',
  },
  {
    id: 'together',
    label: 'Together AI',
    description: 'Open-source model hosting — Llama, Mixtral, and more with competitive pricing.',
    defaultName: 'Together AI',
    defaultSlug: 'together',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.together.xyz/v1',
    defaultApiKeyEnvVar: 'TOGETHER_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'open-model',
  },

  // ── Embedding Specialists ───────────────────────────────────────────
  {
    id: 'cohere',
    label: 'Cohere',
    description: 'Command R+ for chat and Embed v3 for multilingual embeddings.',
    defaultName: 'Cohere',
    defaultSlug: 'cohere',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.cohere.com/v2',
    defaultApiKeyEnvVar: 'COHERE_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'embedding',
  },
  {
    id: 'voyage',
    label: 'Voyage AI',
    description:
      'Embedding specialist with free tier (200M tokens/month). Recommended for knowledge base search.',
    defaultName: 'Voyage AI',
    defaultSlug: 'voyage',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.voyageai.com/v1',
    defaultApiKeyEnvVar: 'VOYAGE_API_KEY',
    providerType: 'voyage',
    isLocal: false,
    group: 'embedding',
  },

  // ── Aggregators & Enterprise ────────────────────────────────────────
  {
    id: 'alibaba',
    label: 'Alibaba (Qwen)',
    description: 'Qwen models via DashScope. Strong multilingual and code capabilities.',
    defaultName: 'Alibaba (Qwen)',
    defaultSlug: 'alibaba',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultApiKeyEnvVar: 'ALIBABA_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'aggregator',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Aggregated multi-model routing — access 200+ models through one API key.',
    defaultName: 'OpenRouter',
    defaultSlug: 'openrouter',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultApiKeyEnvVar: 'OPENROUTER_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'aggregator',
  },
  {
    id: 'perplexity',
    label: 'Perplexity AI',
    description: 'Sonar search-grounded models with real-time web access.',
    defaultName: 'Perplexity AI',
    defaultSlug: 'perplexity',
    showBaseUrl: false,
    showApiKeyEnvVar: true,
    defaultBaseUrl: 'https://api.perplexity.ai',
    defaultApiKeyEnvVar: 'PERPLEXITY_API_KEY',
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'aggregator',
  },

  // ── Local / Self-Hosted ─────────────────────────────────────────────
  {
    id: 'ollama',
    label: 'Ollama',
    description:
      'Run open-source models locally. Free, no API key needed. Requires Ollama installed on the server.',
    defaultName: 'Ollama (Local)',
    defaultSlug: 'ollama-local',
    showBaseUrl: true,
    showApiKeyEnvVar: false,
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultApiKeyEnvVar: null,
    providerType: 'openai-compatible',
    isLocal: true,
    group: 'local',
  },

  // ── Custom ──────────────────────────────────────────────────────────
  {
    id: 'openai-compatible',
    label: 'Other (OpenAI-Compatible)',
    description:
      'Any server with an OpenAI-compatible chat completions API — LM Studio, vLLM, custom deployments.',
    defaultName: 'OpenAI-Compatible',
    defaultSlug: 'openai-compatible',
    showBaseUrl: true,
    showApiKeyEnvVar: true,
    defaultBaseUrl: null,
    defaultApiKeyEnvVar: null,
    providerType: 'openai-compatible',
    isLocal: false,
    group: 'custom',
  },
] as const;

const ALL_FLAVOR_IDS = FLAVORS.map((f) => f.id) as unknown as [string, ...string[]];

const providerFormSchema = z.object({
  flavor: z.enum(ALL_FLAVOR_IDS),
  name: z.string().min(1, 'Name is required').max(100),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, and hyphens only'),
  baseUrl: z.string().url('Base URL must be a valid URL').max(500).optional().or(z.literal('')),
  apiKeyEnvVar: z
    .string()
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'SCREAMING_SNAKE_CASE (e.g. MY_API_KEY)')
    .optional()
    .or(z.literal('')),
  isActive: z.boolean(),
  timeoutMs: z
    .number()
    .int()
    .min(1000, 'Minimum 1000 ms')
    .max(300000, 'Maximum 300000 ms')
    .optional()
    .or(z.nan().transform(() => undefined)),
  maxRetries: z
    .number()
    .int()
    .min(0, 'Minimum 0')
    .max(10, 'Maximum 10')
    .optional()
    .or(z.nan().transform(() => undefined)),
});

type ProviderFormData = z.infer<typeof providerFormSchema>;

export type ProviderRowWithStatus = AiProviderConfig & {
  apiKeyPresent?: boolean;
  timeoutMs?: number | null;
  maxRetries?: number | null;
};

export interface ProviderFormProps {
  mode: 'create' | 'edit';
  provider?: ProviderRowWithStatus;
}

/** Reverse-map a saved provider row to a UI flavor. */
function flavorFromProvider(provider: ProviderRowWithStatus): Flavor {
  if (provider.providerType === 'anthropic') return 'anthropic';
  if (provider.providerType === 'voyage') return 'voyage';
  if (provider.isLocal) return 'ollama';

  // Match known providers by base URL or slug
  const url = provider.baseUrl ?? '';
  const slug = provider.slug ?? '';
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('api.groq.com') || slug === 'groq') return 'groq';
  if (url.includes('api.together.xyz') || slug === 'together') return 'together';
  if (url.includes('api.fireworks.ai') || slug === 'fireworks') return 'fireworks';
  if (url.includes('api.mistral.ai') || slug === 'mistral') return 'mistral';
  if (url.includes('api.cohere.com') || slug === 'cohere') return 'cohere';
  if (url.includes('generativelanguage.googleapis.com') || slug === 'google') return 'google';
  if (url.includes('api.x.ai') || slug === 'xai') return 'xai';
  if (url.includes('api.deepseek.com') || slug === 'deepseek') return 'deepseek';
  if (url.includes('api.perplexity.ai') || slug === 'perplexity') return 'perplexity';
  if (url.includes('openrouter.ai') || slug === 'openrouter') return 'openrouter';
  if (url.includes('dashscope.aliyuncs.com') || slug === 'alibaba') return 'alibaba';

  return 'openai-compatible';
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}

export function ProviderForm({ mode, provider }: ProviderFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const initialFlavor: Flavor = provider ? flavorFromProvider(provider) : 'anthropic';

  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [apiKeyPresent, setApiKeyPresent] = useState<boolean | null>(
    provider?.apiKeyPresent ?? null
  );
  const [advancedOpen, setAdvancedOpen] = useState(!!(provider?.timeoutMs || provider?.maxRetries));

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<ProviderFormData>({
    resolver: zodResolver(providerFormSchema),
    defaultValues: {
      flavor: initialFlavor,
      name: provider?.name ?? FLAVORS.find((f) => f.id === initialFlavor)?.defaultName ?? '',
      slug: provider?.slug ?? FLAVORS.find((f) => f.id === initialFlavor)?.defaultSlug ?? '',
      baseUrl: provider?.baseUrl ?? '',
      apiKeyEnvVar: provider?.apiKeyEnvVar ?? '',
      isActive: provider?.isActive ?? true,
      timeoutMs: provider?.timeoutMs ?? undefined,
      maxRetries: provider?.maxRetries ?? undefined,
    },
  });

  const currentFlavor = watch('flavor');
  const currentName = watch('name');

  const flavorMeta = useMemo(
    () => FLAVORS.find((f) => f.id === currentFlavor) ?? FLAVORS[0],
    [currentFlavor]
  );

  // Auto-fill slug from name in create mode until the user edits the slug.
  useEffect(() => {
    if (isEdit || slugTouched) return;
    if (currentName) setValue('slug', toSlug(currentName), { shouldValidate: false });
  }, [currentName, slugTouched, isEdit, setValue]);

  // When the admin changes flavor, reset defaults for name / slug / fields
  // that the new flavor cares about — but only in create mode. In edit
  // mode we keep whatever the admin is typing.
  const handleFlavorChange = useCallback(
    (next: Flavor) => {
      const meta = FLAVORS.find((f) => f.id === next);
      if (!meta) return;
      setValue('flavor', next, { shouldValidate: true });
      if (isEdit) return;
      if (!slugTouched) {
        setValue('name', meta.defaultName);
        setValue('slug', meta.defaultSlug);
      }
      setValue('baseUrl', meta.defaultBaseUrl ?? '');
      setValue('apiKeyEnvVar', meta.defaultApiKeyEnvVar ?? '');
    },
    [isEdit, slugTouched, setValue]
  );

  const onSubmit = async (data: ProviderFormData) => {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const meta = FLAVORS.find((f) => f.id === data.flavor);
      if (!meta) throw new Error('Unknown flavor');

      // Resolve backend payload from the flavor + form state.
      const baseUrl = meta.showBaseUrl
        ? data.baseUrl?.trim() || meta.defaultBaseUrl || undefined
        : (meta.defaultBaseUrl ?? undefined);
      const apiKeyEnvVar = meta.showApiKeyEnvVar
        ? data.apiKeyEnvVar?.trim() || undefined
        : undefined;

      const payload: Record<string, unknown> = {
        name: data.name,
        slug: data.slug,
        providerType: meta.providerType,
        isLocal: meta.isLocal,
        isActive: data.isActive,
      };

      if (isEdit) {
        // On edit, always send these fields so stale values are cleared when
        // the admin switches to a flavor that hides them. The update schema
        // accepts null; the create schema does not.
        payload.baseUrl = baseUrl ?? null;
        payload.apiKeyEnvVar = apiKeyEnvVar ?? null;
        payload.timeoutMs =
          typeof data.timeoutMs === 'number' && !Number.isNaN(data.timeoutMs)
            ? data.timeoutMs
            : null;
        payload.maxRetries =
          typeof data.maxRetries === 'number' && !Number.isNaN(data.maxRetries)
            ? data.maxRetries
            : null;
      } else {
        // On create, only include fields that have values (create schema
        // uses .optional(), not .nullable()).
        if (baseUrl) payload.baseUrl = baseUrl;
        if (apiKeyEnvVar) payload.apiKeyEnvVar = apiKeyEnvVar;
        if (typeof data.timeoutMs === 'number' && !Number.isNaN(data.timeoutMs))
          payload.timeoutMs = data.timeoutMs;
        if (typeof data.maxRetries === 'number' && !Number.isNaN(data.maxRetries))
          payload.maxRetries = data.maxRetries;
      }

      if (isEdit && provider) {
        const updated = await apiClient.patch<ProviderRowWithStatus>(
          API.ADMIN.ORCHESTRATION.providerById(provider.id),
          { body: payload }
        );
        setApiKeyPresent(updated.apiKeyPresent ?? null);
        reset({
          ...data,
          baseUrl: updated.baseUrl ?? '',
          apiKeyEnvVar: updated.apiKeyEnvVar ?? '',
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        const created = await apiClient.post<ProviderRowWithStatus>(
          API.ADMIN.ORCHESTRATION.PROVIDERS,
          { body: payload }
        );
        router.push(`/admin/orchestration/providers/${created.id}`);
      }
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not save provider. Try again in a moment.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-6">
      {/* Sticky action bar */}
      <div className="bg-background/95 sticky top-0 z-10 -mx-2 flex items-center justify-between border-b px-2 py-3 backdrop-blur">
        <div>
          <h1 className="text-xl font-semibold">{isEdit ? provider?.name : 'New provider'}</h1>
          {isEdit && <p className="text-muted-foreground font-mono text-xs">{provider?.slug}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/providers">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting || saved}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : saved ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Saved
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                {isEdit ? 'Save changes' : 'Create provider'}
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

      {/* Flavor selector */}
      <div>
        <Label className="mb-2 block">
          Provider flavor{' '}
          <FieldHelp title="Pick your backend" contentClassName="w-80">
            Which LLM backend this config talks to. Anthropic and OpenAI are first-class for chat.
            Voyage AI is recommended for embeddings (free tier, top retrieval quality). Ollama runs
            open-source models locally. OpenAI-Compatible covers everything else — Together AI,
            Fireworks, Groq, LM Studio, vLLM, and so on.
            <p className="mt-2 text-xs">
              <strong>Note:</strong> Anthropic (Claude) does not offer an embeddings API. For
              knowledge base vector search, add a Voyage AI or OpenAI provider alongside Anthropic.
            </p>
          </FieldHelp>
        </Label>
        <div role="radiogroup" aria-label="Provider flavor" className="space-y-4">
          {FLAVOR_GROUPS.map((group) => {
            const groupFlavors = FLAVORS.filter((f) => f.group === group.key);
            if (groupFlavors.length === 0) return null;
            return (
              <div key={group.key}>
                <div className="mb-2">
                  <h4 className="text-sm font-medium">{group.label}</h4>
                  <p className="text-muted-foreground text-xs">{group.description}</p>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {groupFlavors.map((f) => {
                    const selected = currentFlavor === f.id;
                    return (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        key={f.id}
                        onClick={() => handleFlavorChange(f.id)}
                        className={`rounded-lg border p-3 text-left transition ${
                          selected
                            ? 'border-primary bg-primary/5 ring-primary ring-1'
                            : 'hover:border-primary/50'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-block h-3 w-3 rounded-full border ${
                              selected ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                            }`}
                          />
                          <span className="font-medium">{f.label}</span>
                        </div>
                        <p className="text-muted-foreground mt-1 text-xs">{f.description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Name */}
      <div className="grid gap-2">
        <Label htmlFor="name">
          Name{' '}
          <FieldHelp title="Display name">
            A friendly label for this provider, shown on the dashboard, in agent settings, and in
            cost reports. Pick something your team will recognise — e.g. &ldquo;Anthropic
            Production&rdquo; or &ldquo;Local Ollama&rdquo;. Default: matches the selected type.
          </FieldHelp>
        </Label>
        <Input id="name" {...register('name')} placeholder={flavorMeta.defaultName} />
        {errors.name && <p className="text-destructive text-xs">{errors.name.message}</p>}
      </div>

      {/* Slug */}
      <div className="grid gap-2">
        <Label htmlFor="slug">
          Slug{' '}
          <FieldHelp title="URL-safe identifier">
            Stable id used by agents and API calls. Change with care — existing agents reference
            this slug.
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
          placeholder={flavorMeta.defaultSlug}
        />
        {errors.slug && <p className="text-destructive text-xs">{errors.slug.message}</p>}
        {isEdit && (
          <p className="text-muted-foreground text-xs">Slug cannot be changed after creation.</p>
        )}
      </div>

      {/* Base URL — shown for openai | ollama | openai-compatible */}
      {flavorMeta.showBaseUrl && (
        <div className="grid gap-2">
          <Label htmlFor="baseUrl">
            Base URL{' '}
            <FieldHelp title="API root">
              The root URL the client will POST to. For Ollama this is typically{' '}
              <code>http://localhost:11434/v1</code>. For OpenAI-compatible services, copy it from
              the provider&apos;s docs.
            </FieldHelp>
          </Label>
          <Input
            id="baseUrl"
            {...register('baseUrl')}
            placeholder={flavorMeta.defaultBaseUrl ?? 'https://api.example.com/v1'}
            className="font-mono text-xs"
          />
          {errors.baseUrl && <p className="text-destructive text-xs">{errors.baseUrl.message}</p>}
        </div>
      )}

      {/* API key env var — shown for anthropic | openai | openai-compatible */}
      {flavorMeta.showApiKeyEnvVar && (
        <div className="grid gap-2">
          <Label htmlFor="apiKeyEnvVar">
            API key env var{' '}
            <FieldHelp title="Env var name — not the key itself">
              Name of the environment variable that holds your API key (e.g.{' '}
              <code>ANTHROPIC_API_KEY</code>). The UI never stores the key itself — just this name.
              The backend reads <code>process.env[…]</code> at request time.
            </FieldHelp>
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="apiKeyEnvVar"
              {...register('apiKeyEnvVar')}
              placeholder={flavorMeta.defaultApiKeyEnvVar ?? 'MY_API_KEY'}
              className="font-mono text-xs"
            />
            {apiKeyPresent === true && (
              <span
                className="flex items-center gap-1 text-xs text-green-600"
                title="Env var is set on the server"
              >
                <Check className="h-4 w-4" /> set
              </span>
            )}
            {apiKeyPresent === false && (
              <span
                className="flex items-center gap-1 text-xs text-red-600"
                title="Env var not set on the server"
              >
                <X className="h-4 w-4" /> missing
              </span>
            )}
          </div>
          {errors.apiKeyEnvVar && (
            <p className="text-destructive text-xs">{errors.apiKeyEnvVar.message}</p>
          )}
          {apiKeyPresent === false && (
            <p className="text-xs text-red-600 dark:text-red-400">
              Set this env var on the server to activate this provider.
            </p>
          )}
        </div>
      )}

      {/* Active */}
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <Label htmlFor="isActive" className="text-sm font-medium">
            Active{' '}
            <FieldHelp title="Enable this provider">
              Inactive providers stay in the list but are skipped when resolving agents. Flip off to
              pause a backend without deleting its config.
            </FieldHelp>
          </Label>
        </div>
        <Switch
          id="isActive"
          checked={watch('isActive')}
          onCheckedChange={(checked) => setValue('isActive', checked)}
        />
      </div>

      {/* Advanced settings — collapsible */}
      <div className="rounded-md border">
        <button
          type="button"
          className="flex w-full items-center gap-2 p-3 text-sm font-medium"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Advanced settings
        </button>
        {advancedOpen && (
          <div className="space-y-4 border-t px-3 pt-3 pb-4">
            <div className="grid gap-2">
              <Label htmlFor="timeoutMs">
                Timeout (ms){' '}
                <FieldHelp title="Request timeout">
                  Maximum time in milliseconds to wait for a response from this provider. Leave
                  empty to use the system default.
                </FieldHelp>
              </Label>
              <Input
                id="timeoutMs"
                type="number"
                {...register('timeoutMs', { valueAsNumber: true })}
                placeholder="e.g. 30000"
                className="font-mono text-xs"
                min={1000}
                max={300000}
              />
              {errors.timeoutMs && (
                <p className="text-destructive text-xs">{errors.timeoutMs.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="maxRetries">
                Max retries{' '}
                <FieldHelp title="Automatic retries">
                  Number of automatic retries on transient failures (network errors, 5xx responses).
                  Leave empty to use the system default.
                </FieldHelp>
              </Label>
              <Input
                id="maxRetries"
                type="number"
                {...register('maxRetries', { valueAsNumber: true })}
                placeholder="e.g. 3"
                className="font-mono text-xs"
                min={0}
                max={10}
              />
              {errors.maxRetries && (
                <p className="text-destructive text-xs">{errors.maxRetries.message}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Test connection — edit only (create mode has no id yet) */}
      {isEdit && provider && (
        <div className="rounded-md border p-4">
          <p className="mb-2 text-sm font-medium">Test connection</p>
          <p className="text-muted-foreground mb-3 text-xs">
            Calls the provider&apos;s list-models endpoint and reports back. Errors are sanitized —
            check the server logs for upstream detail.
          </p>
          <ProviderTestButton providerId={provider.id} />
        </div>
      )}
    </form>
  );
}
