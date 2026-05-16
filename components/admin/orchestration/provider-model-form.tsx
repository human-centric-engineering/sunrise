'use client';

/**
 * Provider Model Form
 *
 * Create/edit form for AiProviderModel. Uses react-hook-form + zodResolver
 * following the same pattern as provider-form.tsx and agent-form.tsx.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldHelp } from '@/components/ui/field-help';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  DEPLOYMENT_PROFILES,
  DEPLOYMENT_PROFILE_META,
  MODEL_CAPABILITIES,
  STORAGE_ONLY_CAPABILITIES,
  TIER_ROLE_META,
  type DeploymentProfile,
  type ModelCapability,
  type TierRole,
} from '@/types/orchestration';

// Display metadata for each capability checkbox. Order here matches
// render order in the UI. FieldHelp copy mirrors the test-model route's
// disabled-button messages so the same vocabulary is used in both
// places.
const CAPABILITY_META: Record<
  ModelCapability,
  { label: string; help: string; runtime: 'engine' | 'storage' }
> = {
  chat: {
    label: 'Chat',
    help: 'Text generation via /v1/chat/completions — the workhorse capability for most agents.',
    runtime: 'engine',
  },
  reasoning: {
    label: 'Reasoning',
    help: 'Frontier reasoning models (o1, o3, o4). Today they still run through chat(); the badge distinguishes cost/latency tier from plain chat.',
    runtime: 'engine',
  },
  embedding: {
    label: 'Embedding',
    help: 'Produces vector embeddings for semantic search. Pairs with the dimensions / quality fields below.',
    runtime: 'engine',
  },
  audio: {
    label: 'Audio',
    help: 'Speech-to-text (Whisper) or text-to-speech. Resolved by getAudioProvider() for mic input in the streaming chat.',
    runtime: 'engine',
  },
  image: {
    label: 'Image',
    help: 'Image generation (DALL·E, gpt-image). Stored for inventory; the orchestration engine has no runtime path for image models.',
    runtime: 'storage',
  },
  moderation: {
    label: 'Moderation',
    help: 'Content moderation (text-moderation-latest). Stored for inventory; the orchestration engine has no runtime path for moderation models.',
    runtime: 'storage',
  },
  vision: {
    label: 'Vision',
    help: 'Accepts image attachments as part of a chat turn. Required for the per-agent attach-image control. Distinct from `image` (generation).',
    runtime: 'engine',
  },
  documents: {
    label: 'Documents',
    help: 'Accepts PDF / document attachments as part of a chat turn natively (no pre-extraction). Required for the per-agent attach-PDF control.',
    runtime: 'engine',
  },
};

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Schema (client-side subset)
// ---------------------------------------------------------------------------

const modelFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  providerSlug: z.string().min(1, 'Provider slug is required').max(50),
  modelId: z.string().min(1, 'Model ID is required').max(100),
  description: z.string().min(1, 'Description is required').max(2000),
  capabilities: z.array(z.enum(MODEL_CAPABILITIES)).min(1, 'At least one capability is required'),
  tierRole: z.enum(['thinking', 'worker', 'infrastructure', 'control_plane', 'embedding']),
  deploymentProfiles: z
    .array(z.enum(['hosted', 'sovereign']))
    .min(1, 'At least one deployment profile is required'),
  reasoningDepth: z.enum(['very_high', 'high', 'medium', 'none']),
  latency: z.enum(['very_fast', 'fast', 'medium']),
  costEfficiency: z.enum(['very_high', 'high', 'medium', 'none']),
  contextLength: z.enum(['very_high', 'high', 'medium', 'n_a']),
  toolUse: z.enum(['strong', 'moderate', 'none']),
  bestRole: z.string().min(1, 'Best role is required').max(200),
  // Embedding-specific
  dimensions: z
    .string()
    .max(10)
    .refine((v) => v === '' || /^[1-9]\d*$/.test(v), 'Must be a positive whole number'),
  schemaCompatible: z.boolean(),
  costPerMillionTokens: z
    .string()
    .max(20)
    .refine((v) => v === '' || /^\d+(\.\d+)?$/.test(v), 'Must be a number'),
  hasFreeTier: z.boolean(),
  local: z.boolean(),
  quality: z.enum(['high', 'medium', 'budget', '']),
  strengths: z.string().max(500),
  setup: z.string().max(500),
  isActive: z.boolean(),
});

type ModelFormData = z.infer<typeof modelFormSchema>;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ProviderModelData {
  id: string;
  slug: string;
  providerSlug: string;
  modelId: string;
  name: string;
  description: string;
  capabilities: string[];
  tierRole: string;
  deploymentProfiles?: string[];
  reasoningDepth: string;
  latency: string;
  costEfficiency: string;
  contextLength: string;
  toolUse: string;
  bestRole: string;
  dimensions?: number | null;
  schemaCompatible?: boolean | null;
  costPerMillionTokens?: number | null;
  hasFreeTier?: boolean | null;
  local?: boolean;
  quality?: string | null;
  strengths?: string | null;
  setup?: string | null;
  isDefault: boolean;
  isActive: boolean;
}

interface ProviderModelFormProps {
  model?: ProviderModelData;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProviderModelForm({ model }: ProviderModelFormProps) {
  const router = useRouter();
  const isEdit = !!model;

  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ModelFormData>({
    resolver: zodResolver(modelFormSchema),
    defaultValues: {
      name: model?.name ?? '',
      slug: model?.slug ?? '',
      providerSlug: model?.providerSlug ?? '',
      modelId: model?.modelId ?? '',
      description: model?.description ?? '',
      capabilities: ((): ModelCapability[] => {
        // Pre-fill from the saved row, intersected with the current
        // valid set so a row carrying a deprecated capability doesn't
        // wedge the form. Default to ['chat'] in create mode.
        const incoming = model?.capabilities ?? [];
        const valid = incoming.filter((c): c is ModelCapability =>
          (MODEL_CAPABILITIES as readonly string[]).includes(c)
        );
        return valid.length > 0 ? valid : model ? [] : ['chat'];
      })(),
      tierRole: (model?.tierRole as ModelFormData['tierRole']) ?? 'thinking',
      deploymentProfiles: (model?.deploymentProfiles as ModelFormData['deploymentProfiles']) ?? [
        'hosted',
      ],
      reasoningDepth: (model?.reasoningDepth as ModelFormData['reasoningDepth']) ?? 'medium',
      latency: (model?.latency as ModelFormData['latency']) ?? 'medium',
      costEfficiency: (model?.costEfficiency as ModelFormData['costEfficiency']) ?? 'medium',
      contextLength: (model?.contextLength as ModelFormData['contextLength']) ?? 'medium',
      toolUse: (model?.toolUse as ModelFormData['toolUse']) ?? 'moderate',
      bestRole: model?.bestRole ?? '',
      dimensions: model?.dimensions?.toString() ?? '',
      schemaCompatible: model?.schemaCompatible ?? false,
      costPerMillionTokens: model?.costPerMillionTokens?.toString() ?? '',
      hasFreeTier: model?.hasFreeTier ?? false,
      local: model?.local ?? false,
      quality: (model?.quality as ModelFormData['quality']) ?? '',
      strengths: model?.strengths ?? '',
      setup: model?.setup ?? '',
      isActive: model?.isActive ?? true,
    },
  });

  const isActive = watch('isActive');
  const currentName = watch('name');
  const providerSlug = watch('providerSlug');
  const capabilities = watch('capabilities');
  const hasEmbedding = capabilities.includes('embedding');
  // Subset check: when the selection is non-empty and contains only
  // storage-only capabilities, render a clarifying note so operators
  // know the engine won't invoke this row at runtime.
  const storageOnlySet = new Set<ModelCapability>(STORAGE_ONLY_CAPABILITIES);
  const isStorageOnly = capabilities.length > 0 && capabilities.every((c) => storageOnlySet.has(c));

  function toggleCapability(cap: ModelCapability, checked: boolean): void {
    const next = new Set<ModelCapability>(capabilities);
    if (checked) next.add(cap);
    else next.delete(cap);
    setValue('capabilities', Array.from(next), {
      shouldValidate: true,
      shouldDirty: true,
    });
  }

  // Auto-fill slug from providerSlug + name in create mode
  useEffect(() => {
    if (isEdit || slugEdited) return;
    const parts = [providerSlug, currentName].filter(Boolean);
    if (parts.length > 0) setValue('slug', toSlug(parts.join('-')), { shouldValidate: false });
  }, [currentName, providerSlug, slugEdited, isEdit, setValue]);

  async function onSubmit(data: ModelFormData) {
    setSubmitting(true);
    setError(null);
    setSaved(false);

    // Zod's `.min(1)` already enforces "at least one capability"; the
    // Zod resolver surfaces it via `errors.capabilities` before
    // onSubmit ever runs. No second check needed here.
    const payload: Record<string, unknown> = {
      name: data.name,
      slug: data.slug,
      providerSlug: data.providerSlug,
      modelId: data.modelId,
      description: data.description,
      capabilities: data.capabilities,
      tierRole: data.tierRole,
      deploymentProfiles: data.deploymentProfiles,
      reasoningDepth: data.reasoningDepth,
      latency: data.latency,
      costEfficiency: data.costEfficiency,
      contextLength: data.contextLength,
      toolUse: data.toolUse,
      bestRole: data.bestRole,
      isActive: data.isActive,
      local: data.local,
    };

    // Include embedding fields when embedding capability is set
    if (data.capabilities.includes('embedding')) {
      if (data.dimensions) payload.dimensions = parseInt(data.dimensions, 10);
      payload.schemaCompatible = data.schemaCompatible;
      if (data.costPerMillionTokens)
        payload.costPerMillionTokens = parseFloat(data.costPerMillionTokens);
      payload.hasFreeTier = data.hasFreeTier;
      if (data.quality) payload.quality = data.quality;
      if (data.strengths) payload.strengths = data.strengths;
      if (data.setup) payload.setup = data.setup;
    } else if (isEdit) {
      // Clear stale embedding fields when capability is removed
      payload.dimensions = null;
      payload.schemaCompatible = null;
      payload.costPerMillionTokens = null;
      payload.hasFreeTier = null;
      payload.quality = null;
      payload.strengths = null;
      payload.setup = null;
    }

    try {
      if (isEdit) {
        await apiClient.patch(API.ADMIN.ORCHESTRATION.providerModelById(model.id), {
          body: payload,
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        const created = await apiClient.post<{ id: string }>(
          API.ADMIN.ORCHESTRATION.PROVIDER_MODELS,
          { body: payload }
        );
        router.push(`/admin/orchestration/provider-models/${created.id}?created=1`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-6">
      {/* Sticky action bar */}
      <div className="bg-background sticky top-0 z-10 flex items-center justify-between border-b pb-4">
        <div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          {saved && <p className="text-sm text-emerald-600">Saved</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/providers?tab=models">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting || saved}>
            {submitting ? 'Saving...' : isEdit ? 'Save changes' : 'Create model'}
          </Button>
        </div>
      </div>
      <fieldset disabled={submitting} className="space-y-6">
        {/* Provider Slug & Model ID */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="providerSlug">
              Provider Slug{' '}
              <FieldHelp title="Provider slug">
                The slug of the provider this model belongs to (e.g. &quot;openai&quot;,
                &quot;anthropic&quot;, &quot;voyage&quot;). Must match an existing provider config
                for the configured-status dot to appear green in the matrix.
              </FieldHelp>
            </Label>
            <Input id="providerSlug" {...register('providerSlug')} placeholder="e.g. openai" />
            {errors.providerSlug && (
              <p className="text-destructive text-xs">{errors.providerSlug.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="modelId">
              Model ID{' '}
              <FieldHelp title="Model ID">
                The API model identifier sent to the provider (e.g. &quot;gpt-5&quot;,
                &quot;claude-opus-4&quot;, &quot;voyage-3&quot;).
              </FieldHelp>
            </Label>
            <Input id="modelId" {...register('modelId')} placeholder="e.g. gpt-5" />
            {errors.modelId && <p className="text-destructive text-xs">{errors.modelId.message}</p>}
          </div>
        </div>

        {/* Name & Slug */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="name">Display Name</Label>
            <Input id="name" {...register('name')} placeholder="e.g. GPT-5" />
            {errors.name && <p className="text-destructive text-xs">{errors.name.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="slug">
              Slug{' '}
              <FieldHelp title="Slug">
                Unique identifier used in URLs and API references. Auto-derived from provider slug +
                name in create mode.{isEdit ? ' Cannot be changed after creation.' : ''}
              </FieldHelp>
            </Label>
            <Input
              id="slug"
              {...register('slug', {
                onChange: () => setSlugEdited(true),
              })}
              disabled={isEdit}
              placeholder="e.g. openai-gpt-5"
            />
            {errors.slug && <p className="text-destructive text-xs">{errors.slug.message}</p>}
          </div>
        </div>

        {/* Description */}
        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            {...register('description')}
            rows={3}
            placeholder="Brief description of this model's strengths and characteristics."
          />
          {errors.description && (
            <p className="text-destructive text-xs">{errors.description.message}</p>
          )}
        </div>

        {/* Capabilities */}
        <div className="space-y-2">
          <Label>
            Capabilities{' '}
            <FieldHelp title="Capabilities">
              Select every capability this model serves. Most rows are single-capability; some
              models support both chat and embedding. Image and moderation are stored as inventory —
              the orchestration engine does not invoke these capabilities at runtime.
            </FieldHelp>
          </Label>
          <div
            className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3"
            role="group"
            aria-label="Model capabilities"
          >
            {MODEL_CAPABILITIES.map((cap) => {
              const meta = CAPABILITY_META[cap];
              const id = `cap-${cap}`;
              return (
                <div key={cap} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    id={id}
                    checked={capabilities.includes(cap)}
                    onCheckedChange={(v) => toggleCapability(cap, !!v)}
                  />
                  <label htmlFor={id} className="flex items-center gap-1">
                    {meta.label}
                    <FieldHelp title={meta.label}>{meta.help}</FieldHelp>
                  </label>
                </div>
              );
            })}
          </div>
          {errors.capabilities && (
            <p className="text-destructive text-xs">{errors.capabilities.message}</p>
          )}
          {isStorageOnly && (
            <p className="text-muted-foreground text-xs">
              Storage-only — the orchestration engine does not currently invoke image or moderation
              models from chat or workflow runs. The row appears in audits and inventory but cannot
              be bound to an agent as a runtime model.
            </p>
          )}
        </div>

        {/* Tier Role */}
        <div className="space-y-2">
          <Label>
            Tier Role{' '}
            <FieldHelp title="Tier roles">
              <p>
                Each model belongs to a tier that describes its primary role in an agent
                architecture. The decision heuristic uses this to recommend models.
              </p>
            </FieldHelp>
          </Label>
          <Select
            defaultValue={model?.tierRole ?? 'thinking'}
            onValueChange={(v) => setValue('tierRole', v as ModelFormData['tierRole'])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                Object.entries(TIER_ROLE_META) as [
                  TierRole,
                  { label: string; description: string },
                ][]
              ).map(([key, meta]) => (
                <SelectItem key={key} value={key}>
                  {meta.label} — {meta.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.tierRole && <p className="text-destructive text-xs">{errors.tierRole.message}</p>}
        </div>

        {/* Deployment profile — orthogonal to tier role. A model carries
            one or more profiles describing where it runs. */}
        <div className="space-y-2">
          <Label>
            Deployment{' '}
            <FieldHelp title="Deployment profile">
              <p>
                Where the model runs &mdash; orthogonal to its tier role. <strong>Hosted</strong>{' '}
                means the vendor&apos;s managed API; <strong>Sovereign</strong> means it runs on
                your own infrastructure (Ollama, vLLM, self-hosted). A model can carry both if
                it&apos;s available either way.
              </p>
            </FieldHelp>
          </Label>
          <div className="space-y-2">
            {DEPLOYMENT_PROFILES.map((profile) => {
              const meta = DEPLOYMENT_PROFILE_META[profile];
              const checked = watch('deploymentProfiles')?.includes(profile) ?? false;
              const inputId = `deployment-profile-${profile}`;
              return (
                <label
                  key={profile}
                  htmlFor={inputId}
                  className="hover:bg-muted/50 flex items-start gap-3 rounded-md border p-3"
                >
                  <Checkbox
                    id={inputId}
                    checked={checked}
                    onCheckedChange={(next) => {
                      const current = new Set<DeploymentProfile>(watch('deploymentProfiles') ?? []);
                      if (next) current.add(profile);
                      else current.delete(profile);
                      setValue('deploymentProfiles', Array.from(current), {
                        shouldValidate: true,
                        shouldDirty: true,
                      });
                    }}
                  />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{meta.label}</p>
                    <p className="text-muted-foreground text-xs">{meta.description}</p>
                  </div>
                </label>
              );
            })}
          </div>
          {errors.deploymentProfiles && (
            <p className="text-destructive text-xs">{errors.deploymentProfiles.message}</p>
          )}
        </div>

        {/* Rating dimensions */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>
              Reasoning Depth{' '}
              <FieldHelp title="Reasoning depth">
                How deeply the model can reason through complex, multi-step problems. &quot;Very
                High&quot; = frontier reasoning models, &quot;None&quot; = no chain-of-thought
                capability.
              </FieldHelp>
            </Label>
            <Select
              defaultValue={model?.reasoningDepth ?? 'medium'}
              onValueChange={(v) =>
                setValue('reasoningDepth', v as ModelFormData['reasoningDepth'])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="very_high">Very High</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>
              Latency{' '}
              <FieldHelp title="Latency">
                Response speed. &quot;Very Fast&quot; = sub-second first token (e.g. Groq),
                &quot;Medium&quot; = typical cloud API latency.
              </FieldHelp>
            </Label>
            <Select
              defaultValue={model?.latency ?? 'medium'}
              onValueChange={(v) => setValue('latency', v as ModelFormData['latency'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="very_fast">Very Fast</SelectItem>
                <SelectItem value="fast">Fast</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>
              Cost Efficiency{' '}
              <FieldHelp title="Cost efficiency">
                How cost-effective the model is per token. &quot;Very High&quot; = cheapest tier
                (e.g. open models, small workers), &quot;None&quot; = premium pricing.
              </FieldHelp>
            </Label>
            <Select
              defaultValue={model?.costEfficiency ?? 'medium'}
              onValueChange={(v) =>
                setValue('costEfficiency', v as ModelFormData['costEfficiency'])
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="very_high">Very High</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>
              Context Length{' '}
              <FieldHelp title="Context length">
                Maximum input context window. &quot;Very High&quot; = 200k+ tokens, &quot;N/A&quot;
                = not applicable (e.g. embedding models).
              </FieldHelp>
            </Label>
            <Select
              defaultValue={model?.contextLength ?? 'medium'}
              onValueChange={(v) => setValue('contextLength', v as ModelFormData['contextLength'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="very_high">Very High</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="n_a">N/A</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>
              Tool Use{' '}
              <FieldHelp title="Tool use">
                Function calling / tool-use capability. &quot;Strong&quot; = reliable structured
                output and parallel tool calls, &quot;None&quot; = no function calling support.
              </FieldHelp>
            </Label>
            <Select
              defaultValue={model?.toolUse ?? 'moderate'}
              onValueChange={(v) => setValue('toolUse', v as ModelFormData['toolUse'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="strong">Strong</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Best Role */}
        <div className="space-y-2">
          <Label htmlFor="bestRole">
            Best Role{' '}
            <FieldHelp title="Best role">
              Free-text description of what this model is best suited for in an agent architecture
              (e.g. &quot;Planner / orchestrator&quot;, &quot;Premium embeddings&quot;).
            </FieldHelp>
          </Label>
          <Input
            id="bestRole"
            {...register('bestRole')}
            placeholder="e.g. Planner / orchestrator"
          />
          {errors.bestRole && <p className="text-destructive text-xs">{errors.bestRole.message}</p>}
        </div>

        {/* Embedding-specific fields */}
        {hasEmbedding && (
          <div className="space-y-4 rounded-md border p-4">
            <h3 className="text-sm font-semibold">Embedding Details</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dimensions">
                  Dimensions{' '}
                  <FieldHelp title="Dimensions">
                    Native output dimensions of the embedding vector (e.g. 1536, 1024, 768).
                  </FieldHelp>
                </Label>
                <Input id="dimensions" {...register('dimensions')} placeholder="e.g. 1536" />
                {errors.dimensions && (
                  <p className="text-destructive text-xs">{errors.dimensions.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="costPerMillionTokens">
                  Cost / 1M Tokens (USD){' '}
                  <FieldHelp title="Cost per million tokens">
                    The provider&apos;s published price per million input tokens in USD. Used for
                    cost comparison in the embedding provider modal.
                  </FieldHelp>
                </Label>
                <Input
                  id="costPerMillionTokens"
                  {...register('costPerMillionTokens')}
                  placeholder="e.g. 0.02"
                />
                {errors.costPerMillionTokens && (
                  <p className="text-destructive text-xs">{errors.costPerMillionTokens.message}</p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-6">
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  id="schemaCompatible"
                  checked={watch('schemaCompatible')}
                  onCheckedChange={(v) => setValue('schemaCompatible', !!v)}
                />
                <label htmlFor="schemaCompatible">
                  Schema Compatible (1536-dim){' '}
                  <FieldHelp title="Schema compatible">
                    Can this model produce 1536-dim vectors compatible with the pgvector column?
                  </FieldHelp>
                </label>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  id="hasFreeTier"
                  checked={watch('hasFreeTier')}
                  onCheckedChange={(v) => setValue('hasFreeTier', !!v)}
                />
                <label htmlFor="hasFreeTier">
                  Free Tier{' '}
                  <FieldHelp title="Free tier">
                    Whether the provider offers a free usage tier or free credits for this model.
                  </FieldHelp>
                </label>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  id="localModel"
                  checked={watch('local')}
                  onCheckedChange={(v) => setValue('local', !!v)}
                />
                <label htmlFor="localModel">
                  Local / Self-hosted{' '}
                  <FieldHelp title="Local / self-hosted">
                    Whether this model runs on your own infrastructure (e.g. via Ollama). Local
                    models are preferred for the &quot;private&quot; intent.
                  </FieldHelp>
                </label>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>
                  Quality{' '}
                  <FieldHelp title="Embedding quality">
                    Relative quality rating for embedding output. &quot;High&quot; = best retrieval
                    accuracy, &quot;Budget&quot; = optimised for cost over quality.
                  </FieldHelp>
                </Label>
                <Select
                  defaultValue={model?.quality ?? ''}
                  onValueChange={(v) => setValue('quality', v as ModelFormData['quality'])}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select quality" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="budget">Budget</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="strengths">
                Strengths{' '}
                <FieldHelp title="Strengths">
                  Short description of what this embedding model excels at (e.g. &quot;Best-in-class
                  code retrieval&quot;, &quot;Multilingual support&quot;).
                </FieldHelp>
              </Label>
              <Textarea
                id="strengths"
                {...register('strengths')}
                rows={2}
                placeholder="Brief description of this model's strengths"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup">
                Setup Instructions{' '}
                <FieldHelp title="Setup">
                  One-line setup hint for admins (e.g. &quot;API key → add as provider&quot;,
                  &quot;ollama pull nomic-embed-text&quot;).
                </FieldHelp>
              </Label>
              <Input
                id="setup"
                {...register('setup')}
                placeholder="e.g. API key → add as provider"
              />
            </div>
          </div>
        )}

        {/* Active toggle */}
        <div className="flex items-center gap-3">
          <Switch
            id="isActive"
            checked={isActive}
            onCheckedChange={(v) => setValue('isActive', v)}
          />
          <Label htmlFor="isActive">Active</Label>
          <span className="text-muted-foreground text-xs">
            Inactive models are hidden from the matrix and recommendations.
          </span>
        </div>
      </fieldset>
    </form>
  );
}
