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
import { TIER_ROLE_META, type TierRole } from '@/types/orchestration';

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
  capChat: z.boolean(),
  capEmbedding: z.boolean(),
  tierRole: z.enum([
    'thinking',
    'worker',
    'infrastructure',
    'control_plane',
    'local_sovereign',
    'embedding',
  ]),
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
      capChat: model?.capabilities?.includes('chat') ?? true,
      capEmbedding: model?.capabilities?.includes('embedding') ?? false,
      tierRole: (model?.tierRole as ModelFormData['tierRole']) ?? 'thinking',
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
  const hasEmbedding = watch('capEmbedding');

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

    const capabilities: string[] = [];
    if (data.capChat) capabilities.push('chat');
    if (data.capEmbedding) capabilities.push('embedding');
    if (capabilities.length === 0) {
      setError('At least one capability (Chat or Embedding) is required');
      setSubmitting(false);
      return;
    }

    const payload: Record<string, unknown> = {
      name: data.name,
      slug: data.slug,
      providerSlug: data.providerSlug,
      modelId: data.modelId,
      description: data.description,
      capabilities,
      tierRole: data.tierRole,
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
    if (data.capEmbedding) {
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
              Select whether this model is used for chat (text generation), embedding (vector
              creation), or both.
            </FieldHelp>
          </Label>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id="capChat"
                checked={watch('capChat')}
                onCheckedChange={(v) => setValue('capChat', !!v)}
              />
              <label htmlFor="capChat">Chat</label>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id="capEmbedding"
                checked={hasEmbedding}
                onCheckedChange={(v) => setValue('capEmbedding', !!v)}
              />
              <label htmlFor="capEmbedding">Embedding</label>
            </div>
          </div>
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
