'use client';

/**
 * AgentForm (Phase 4 Session 4.2)
 *
 * Shared create / edit form for `AiAgent`. One `<form>`, eight shadcn tabs,
 * one PATCH (or POST). Tabs are layout, not save boundaries.
 *
 * Pattern follows `components/admin/feature-flag-form.tsx`:
 *   raw react-hook-form + `zodResolver`, no shadcn Form wrapper.
 *
 * Every non-trivial field is wrapped in `<FieldHelp>`. This is the
 * reference implementation of the contextual-help directive for the
 * rest of Phase 4 — copy the voice, not just the structure.
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { AlertCircle, Check, Loader2, Save, Scale, Shield } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import { Checkbox } from '@/components/ui/checkbox';
import {
  resolveEffectivePrompt,
  composeSystemPromptString,
} from '@/lib/orchestration/agents/resolve-effective-prompt';
import { ChatInterface } from '@/components/admin/orchestration/chat/chat-interface';
import { CliAuthoringHint } from '@/components/admin/orchestration/cli-authoring-hint';
import { InstructionsHistoryPanel } from '@/components/admin/orchestration/instructions-history-panel';
import { AgentCapabilitiesTab } from '@/components/admin/orchestration/agent-capabilities-tab';
import { AgentInviteTokensTab } from '@/components/admin/orchestration/agent-invite-tokens-tab';
import { AgentVersionHistoryTab } from '@/components/admin/orchestration/agent-version-history-tab';
import { AgentTestCard } from '@/components/admin/orchestration/agent-test-card';
import { EmbedConfigPanel } from '@/components/admin/orchestration/agents/embed-config-panel';
import { KnowledgeAccessSection } from '@/components/admin/orchestration/knowledge-access-section';
import {
  ReasoningEffortSelect,
  toReasoningEffortFormValue,
} from '@/components/admin/orchestration/reasoning-effort-select';
import { slugSchema } from '@/lib/validations/common';
import type { EffectiveAgentDefaults, ModelOption } from '@/lib/orchestration/prefetch-helpers';
import type { AiAgent, AiProviderConfig } from '@/types/prisma';

export type { ModelOption };

/**
 * Form schema — a hand-picked subset of the create schema. We keep the
 * client-side validation intentionally narrower than the server to avoid
 * divergence on the enum/record fields (metadata, providerConfig) that the
 * form doesn't expose.
 */
const agentFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: slugSchema.min(1, 'Slug is required').max(100),
  // Set at create time only (via ?kind= query param); not editable on
  // existing agents. 'chat' or 'judge'.
  kind: z.enum(['chat', 'judge']),
  description: z.string().min(1, 'Description is required').max(5000),
  // Profile inheritance — see lib/orchestration/agents/resolve-effective-prompt.ts.
  profileId: z.string().nullable().optional(),
  persona: z.string().max(50000).nullable().optional(),
  guardrails: z.string().max(10000).nullable().optional(),
  personaMode: z.enum(['override', 'append']),
  voiceMode: z.enum(['override', 'append']),
  guardrailsMode: z.enum(['override', 'append']),
  systemInstructions: z.string().min(1, 'System instructions are required').max(50000),
  provider: z.string().min(1, 'Provider is required'),
  model: z.string().min(1, 'Model is required'),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(200000),
  // Reasoning-effort bucket. `'auto'` is the form sentinel for "let
  // the provider apply its default" — Radix Select forbids empty-string
  // values, so we can't use `''` even though the column persists as
  // null. The submit handler translates `'auto'` → null.
  reasoningEffort: z.enum(['auto', 'minimal', 'low', 'medium', 'high']),
  monthlyBudgetUsd: z.number().positive().max(10000).optional(),
  // Per-turn cap (improvement #39 runaway-loop guard). Optional /
  // nullable; null means "use the org default" or "no cap" if that
  // is also null. min(0.01) matches the API-side validator.
  maxCostPerTurnUsd: z.number().min(0.01).max(10000).nullable().optional(),
  isActive: z.boolean(),
  inputGuardMode: z.enum(['log_only', 'warn_and_continue', 'block']).nullable().optional(),
  outputGuardMode: z.enum(['log_only', 'warn_and_continue', 'block']).nullable().optional(),
  citationGuardMode: z.enum(['log_only', 'warn_and_continue', 'block']).nullable().optional(),
  maxHistoryTokens: z.number().int().min(1000).max(2000000).nullable().optional(),
  maxHistoryMessages: z.number().int().min(0).max(500).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  visibility: z.enum(['internal', 'public', 'invite_only']),
  rateLimitRpm: z.number().int().min(1).max(10000).nullable().optional(),
  enableVoiceInput: z.boolean(),
  enableImageInput: z.boolean(),
  enableDocumentInput: z.boolean(),
  fallbackProviders: z.array(z.string()),
  knowledgeAccessMode: z.enum(['full', 'restricted']),
  knowledgeTagIds: z.array(z.string()),
  knowledgeDocumentIds: z.array(z.string()),
  topicBoundaries: z.string().optional(),
  brandVoiceInstructions: z.string().max(10000).nullable().optional(),
});

type AgentFormData = z.infer<typeof agentFormSchema>;

/**
 * Agent record as enriched by the admin GET endpoint — adds the flattened
 * id arrays for knowledge grants on top of the bare Prisma row. The form
 * needs both to seed the knowledgeAccessMode radio and the two MultiSelects.
 */
export type AgentWithGrants = AiAgent & {
  grantedTagIds?: string[];
  grantedDocumentIds?: string[];
};

/** Slim profile summary passed to the form for the dropdown + preview. */
export interface AgentProfileSummary {
  id: string;
  name: string;
  slug: string;
  persona: string | null;
  brandVoiceInstructions: string | null;
  guardrails: string | null;
}

export interface AgentFormProps {
  mode: 'create' | 'edit';
  agent?: AgentWithGrants;
  providers: (AiProviderConfig & { apiKeyPresent?: boolean })[] | null;
  models: ModelOption[] | null;
  /**
   * Server-resolved effective defaults. Used to pre-fill provider/model
   * when the agent ships with empty strings (system-seeded agents like
   * pattern-advisor) or when creating a new agent on a freshly-configured
   * deployment. Optional for backwards-compatibility with older callers.
   */
  effectiveDefaults?: EffectiveAgentDefaults;
  /**
   * Available inheritance profiles, loaded by the parent server page so
   * the dropdown populates without a client-side fetch. Optional — when
   * omitted, the profile selector is hidden (agent behaves as today).
   */
  profiles?: AgentProfileSummary[];
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

export function AgentForm({
  mode,
  agent,
  providers,
  models,
  effectiveDefaults,
  profiles,
}: AgentFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isEdit = mode === 'edit';

  // On a fresh create, honour `?kind=judge` from the URL (used by the
  // "Create custom judge" CTA in the run-create form). On edit, the
  // existing agent's kind is the source of truth.
  const initialKind: 'chat' | 'judge' = isEdit
    ? ((agent?.kind as 'chat' | 'judge' | undefined) ?? 'chat')
    : searchParams.get('kind') === 'judge'
      ? 'judge'
      : 'chat';

  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(isEdit);

  const providerFallback = !providers || providers.length === 0;
  const modelFallback = !models || models.length === 0;

  // Resolve the provider/model to seed into the form. Important: use `||`
  // not `??` so empty strings on system-seeded agents (pattern-advisor,
  // quiz-master, mcp-system, model-auditor) fall through to the
  // server-resolved effective defaults instead of leaving the Select
  // unselected and forcing the model field into text-input fallback mode.
  const initialProvider = (agent?.provider ?? '') || effectiveDefaults?.provider || 'anthropic';
  const initialModel = (agent?.model ?? '') || effectiveDefaults?.model || 'claude-opus-4-6';
  const providerIsInherited = isEdit && !agent?.provider;
  const modelIsInherited = isEdit && !agent?.model;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors, isDirty },
  } = useForm<AgentFormData>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: agent?.name ?? '',
      slug: agent?.slug ?? '',
      kind: initialKind,
      description: agent?.description ?? '',
      systemInstructions: agent?.systemInstructions ?? '',
      provider: initialProvider,
      model: initialModel,
      temperature: agent?.temperature ?? 0.7,
      maxTokens: agent?.maxTokens ?? 4096,
      reasoningEffort: toReasoningEffortFormValue(agent?.reasoningEffort),
      monthlyBudgetUsd: agent?.monthlyBudgetUsd ?? undefined,
      maxCostPerTurnUsd: agent?.maxCostPerTurnUsd ?? null,
      isActive: agent?.isActive ?? true,
      inputGuardMode: (agent?.inputGuardMode as AgentFormData['inputGuardMode']) ?? null,
      outputGuardMode: (agent?.outputGuardMode as AgentFormData['outputGuardMode']) ?? null,
      citationGuardMode: (agent?.citationGuardMode as AgentFormData['citationGuardMode']) ?? null,
      maxHistoryTokens: agent?.maxHistoryTokens ?? null,
      maxHistoryMessages: agent?.maxHistoryMessages ?? null,
      retentionDays: agent?.retentionDays ?? null,
      visibility: (agent?.visibility as AgentFormData['visibility']) ?? 'internal',
      rateLimitRpm: agent?.rateLimitRpm ?? null,
      enableVoiceInput: agent?.enableVoiceInput ?? false,
      enableImageInput: agent?.enableImageInput ?? false,
      enableDocumentInput: agent?.enableDocumentInput ?? false,
      fallbackProviders: (agent?.fallbackProviders as string[]) ?? [],
      knowledgeAccessMode:
        (agent?.knowledgeAccessMode as 'full' | 'restricted' | undefined) ?? 'full',
      knowledgeTagIds: agent?.grantedTagIds ?? [],
      knowledgeDocumentIds: agent?.grantedDocumentIds ?? [],
      topicBoundaries: agent?.topicBoundaries?.join(', ') ?? '',
      brandVoiceInstructions: agent?.brandVoiceInstructions ?? null,
      profileId: agent?.profileId ?? null,
      persona: agent?.persona ?? null,
      guardrails: agent?.guardrails ?? null,
      personaMode: (agent?.personaMode as 'override' | 'append') ?? 'override',
      voiceMode: (agent?.voiceMode as 'override' | 'append') ?? 'override',
      guardrailsMode: (agent?.guardrailsMode as 'override' | 'append') ?? 'override',
    },
  });

  const currentProvider = watch('provider');
  const currentModel = watch('model');
  const currentTemp = watch('temperature');
  const currentName = watch('name');
  const currentInstructions = watch('systemInstructions');
  const currentIsActive = watch('isActive');
  const currentVoiceInput = watch('enableVoiceInput');
  const currentImageInput = watch('enableImageInput');
  const currentDocumentInput = watch('enableDocumentInput');
  const currentInputGuard = watch('inputGuardMode');
  const currentOutputGuard = watch('outputGuardMode');
  const currentCitationGuard = watch('citationGuardMode');
  const currentVisibility = watch('visibility');
  const currentProfileId = watch('profileId');
  const currentPersona = watch('persona');
  const currentGuardrails = watch('guardrails');
  const currentVoice = watch('brandVoiceInstructions');
  const currentPersonaMode = watch('personaMode');
  const currentVoiceMode = watch('voiceMode');
  const currentGuardrailsMode = watch('guardrailsMode');

  // Resolve the live effective prompt for the preview card on the
  // Instructions tab. Uses the same pure helper that the chat handler
  // and workflow agent_call executor use, so what the operator sees in
  // the preview is byte-identical to what the LLM will receive.
  const selectedProfile = useMemo(
    () => (currentProfileId ? (profiles?.find((p) => p.id === currentProfileId) ?? null) : null),
    [profiles, currentProfileId]
  );
  const effectivePrompt = useMemo(
    () =>
      resolveEffectivePrompt(
        {
          systemInstructions: currentInstructions ?? '',
          persona: currentPersona,
          brandVoiceInstructions: currentVoice,
          guardrails: currentGuardrails,
          personaMode: currentPersonaMode,
          voiceMode: currentVoiceMode,
          guardrailsMode: currentGuardrailsMode,
        },
        selectedProfile
      ),
    [
      currentInstructions,
      currentPersona,
      currentVoice,
      currentGuardrails,
      currentPersonaMode,
      currentVoiceMode,
      currentGuardrailsMode,
      selectedProfile,
    ]
  );

  // Auto-generate slug from name in create mode until the user edits the slug.
  useEffect(() => {
    if (isEdit || slugTouched) return;
    if (currentName) setValue('slug', toSlug(currentName), { shouldValidate: false });
  }, [currentName, slugTouched, isEdit, setValue]);

  // Filter the matrix down to models for the selected provider, then
  // synthesise a "legacy" entry when editing an agent whose ORIGINALLY
  // saved model is no longer in the matrix (matrix row deactivated or
  // deleted since the agent was last saved). We key off the raw
  // `agent.model` prop — NOT the form-state `currentModel` — so the
  // synthesised entry only fires for a genuinely-saved value and never
  // for the hardcoded fallback (`'claude-opus-4-6'`) that the form
  // seeds when an empty system-agent model resolves to a default. The
  // entry renders with an amber "no longer in matrix" badge so the
  // operator knows to pick a replacement before saving; without it,
  // the auto-reset effect below would silently change the model on
  // first edit and the saved selection would be lost.
  const filteredModels = useMemo(() => {
    const matched = models?.filter((m) => m.provider === currentProvider) ?? [];
    const savedModel = agent?.model ?? '';
    const savedProvider = agent?.provider ?? '';
    // Only synthesise when (a) we're editing, (b) the agent ROW had a
    // non-empty model saved, (c) the saved provider matches the current
    // selection (synthesising a legacy entry for a different provider's
    // model would be misleading), and (d) that saved model isn't
    // already in the matched list.
    if (
      !isEdit ||
      savedModel.length === 0 ||
      savedProvider !== currentProvider ||
      matched.some((m) => m.id === savedModel)
    ) {
      return matched;
    }
    // `isLegacy` is a UI-only flag carried alongside the ModelOption
    // shape — the SelectItem render branches on it for the badge.
    const legacyEntry: ModelOption & { isLegacy: true } = {
      provider: savedProvider,
      id: savedModel,
      isLegacy: true,
    };
    return [legacyEntry, ...matched];
  }, [models, currentProvider, isEdit, agent?.model, agent?.provider]);

  // Derive capability flags for the currently-selected model so we can
  // pre-emptively disable image/document toggles when the model can't
  // handle that modality. The runtime gate in `streaming-handler.ts` is
  // still the authoritative check, but disabling the toggle in the
  // form stops the operator from saving an unreachable configuration
  // and getting a confusing SSE error at send time. The toggle's
  // saved on/off VALUE is preserved across model swaps — if the
  // operator switches back to a compatible model later, their intent
  // is restored. Unknown capabilities (registry-only models that
  // bypass the matrix) fall through to "enabled" so we don't lock
  // operators out of working configurations.
  const currentModelInfo = filteredModels.find((m) => m.id === currentModel);
  const currentModelCapabilities = currentModelInfo?.capabilities;
  // When capabilities are unknown (no matrix row) we default to
  // enabled — let the runtime gate decide. When capabilities ARE
  // known, the toggle is disabled iff the relevant capability is
  // absent.
  const supportsVision =
    currentModelCapabilities === undefined || currentModelCapabilities.includes('vision');
  const supportsDocuments =
    currentModelCapabilities === undefined || currentModelCapabilities.includes('documents');

  // When provider changes, reset model if the current value doesn't belong to the new provider.
  useEffect(() => {
    if (modelFallback || !currentProvider) return;
    const valid = filteredModels.some((m) => m.id === currentModel);
    if (!valid && filteredModels.length > 0) {
      setValue('model', filteredModels[0].id, { shouldValidate: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProvider]);

  // When provider changes, remove it from fallbackProviders if it was previously a fallback.
  useEffect(() => {
    const current = watch('fallbackProviders');
    const filtered = current.filter((p: string) => p !== currentProvider);
    if (filtered.length !== current.length) {
      setValue('fallbackProviders', filtered);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProvider]);

  // Warn before navigating away with unsaved changes.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const onSubmit = async (data: AgentFormData) => {
    setSubmitting(true);
    setError(null);
    setSaved(false);

    // Transform comma-separated strings into arrays for the API and map the
    // form's knowledgeTagIds / knowledgeDocumentIds onto the API contract
    // (grantedTagIds / grantedDocumentIds).
    const { knowledgeTagIds, knowledgeDocumentIds, reasoningEffort, ...rest } = data;
    const payload = {
      ...rest,
      // `'auto'` is the form sentinel for "let the runtime use the
      // provider default" — persist as null so the DB column matches.
      reasoningEffort: reasoningEffort === 'auto' ? null : reasoningEffort,
      topicBoundaries: rest.topicBoundaries
        ? rest.topicBoundaries
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      grantedTagIds: knowledgeTagIds,
      grantedDocumentIds: knowledgeDocumentIds,
    };

    try {
      if (isEdit && agent) {
        await apiClient.patch<AiAgent>(API.ADMIN.ORCHESTRATION.agentById(agent.id), {
          body: payload,
        });
        // Re-seed the form with what we just saved so dirty-state clears.
        reset(data);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      } else {
        const created = await apiClient.post<AiAgent>(API.ADMIN.ORCHESTRATION.AGENTS, {
          body: payload,
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
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">
              {isEdit ? agent?.name : initialKind === 'judge' ? 'New judge agent' : 'New agent'}
            </h1>
            {isEdit && agent?.isSystem && (
              <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px] font-medium">
                <Shield className="h-3 w-3" />
                System
              </Badge>
            )}
            {(isEdit ? agent?.kind === 'judge' : initialKind === 'judge') && (
              <Badge
                variant="outline"
                className="gap-1 border-amber-300 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:border-amber-700 dark:text-amber-300"
              >
                <Scale className="h-3 w-3" />
                Judge
              </Badge>
            )}
          </div>
          {isEdit && <p className="text-muted-foreground font-mono text-xs">{agent?.slug}</p>}
          {!isEdit && initialKind === 'judge' && (
            <p className="text-muted-foreground mt-0.5 text-xs">
              The system instructions you write below ARE the rubric. The evaluation worker sends
              the case as a structured user message; the judge responds with{' '}
              <code className="bg-muted rounded px-1 text-[10px]">
                {'{"score": ..., "reasoning": "..."}'}
              </code>{' '}
              JSON.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/agents">Cancel</Link>
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
                {isEdit ? 'Save changes' : 'Create agent'}
              </>
            )}
          </Button>
        </div>
      </div>

      {!isEdit && <CliAuthoringHint resource="agents" />}

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
            value="invite-tokens"
            disabled={!isEdit || currentVisibility !== 'invite_only'}
            title={
              !isEdit
                ? 'Save the agent first to manage invite tokens'
                : currentVisibility !== 'invite_only'
                  ? 'Set visibility to "Invite only" to manage tokens'
                  : undefined
            }
          >
            Invite tokens
          </TabsTrigger>
          <TabsTrigger
            value="embed"
            disabled={!isEdit}
            title={!isEdit ? 'Save the agent first to manage embed tokens' : undefined}
          >
            Embed
          </TabsTrigger>
          <TabsTrigger
            value="versions"
            disabled={!isEdit}
            title={!isEdit ? 'Save the agent first to view version history' : undefined}
          >
            Versions
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
          {isEdit && agent?.isSystem && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              <Shield className="h-4 w-4 shrink-0" />
              <span>
                This is a system agent used internally by the platform. It cannot be deleted or
                deactivated. Editing instructions, model, and capabilities is supported — changes
                are versioned and can be reverted.
              </span>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="name">
              Name{' '}
              <FieldHelp title="Agent name">
                A human-readable label. This is what admins and end-users see in lists and in the
                chat UI.
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
                only.
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

          {profiles && profiles.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="profileId">
                Inherit from profile{' '}
                <FieldHelp title="Agent profile" contentClassName="w-96">
                  <p>
                    Profiles supply default <strong>persona</strong>, <strong>brand voice</strong>,
                    and <strong>guardrails</strong>. Pick one to inherit them; leave the matching
                    fields below blank to use the profile&apos;s text, populate them to override on
                    this agent only.
                  </p>
                  <p className="mt-2">
                    Use the{' '}
                    <Link href="/admin/orchestration/agent-profiles" className="underline">
                      Agent Profiles
                    </Link>{' '}
                    page to create, edit, and review what each profile defines.
                  </p>
                </FieldHelp>
              </Label>
              <Select
                value={currentProfileId ?? '__none__'}
                onValueChange={(v) =>
                  setValue('profileId', v === '__none__' ? null : v, { shouldDirty: true })
                }
              >
                <SelectTrigger id="profileId">
                  <SelectValue placeholder="No profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No profile (agent-only)</SelectItem>
                  {profiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

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
              disabled={isEdit && agent?.isSystem}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="visibility">
              Visibility{' '}
              <FieldHelp title="Who can access this agent">
                <strong>Internal</strong> — Admins only, via the dashboard. For internal tools,
                testing, or sensitive data.
                <br />
                <br />
                <strong>Public</strong> — Anyone with the chat URL. For support bots, Q&amp;A, or
                open demos.
                <br />
                <br />
                <strong>Invite only</strong> — Requires an invite token. For beta programs, partner
                access, or gated agents. Use the Invite tokens tab above to create and manage
                tokens.
              </FieldHelp>
            </Label>
            <Select
              value={currentVisibility}
              onValueChange={(v) =>
                setValue('visibility', v as AgentFormData['visibility'], { shouldValidate: true })
              }
            >
              <SelectTrigger id="visibility">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="internal">Internal</SelectItem>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="invite_only">Invite only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="retentionDays">
              Conversation retention (days){' '}
              <FieldHelp title="Auto-delete old conversations">
                Conversations with no activity for this many days are automatically deleted,
                including their messages and embeddings. Cleanup runs as part of the scheduled
                maintenance job. Leave blank to keep conversations forever.
              </FieldHelp>
            </Label>
            <Input
              id="retentionDays"
              type="number"
              placeholder="Keep forever"
              {...register('retentionDays', {
                setValueAs: (v: string | number) =>
                  v === '' || v === null || v === undefined ? null : Number(v),
              })}
            />
            {errors.retentionDays && (
              <p className="text-destructive text-xs">{errors.retentionDays.message}</p>
            )}
          </div>
        </TabsContent>

        {/* ================= TAB 2 — MODEL ================= */}
        <TabsContent value="model" className="space-y-4 pt-4">
          {(providerFallback || modelFallback) && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              We couldn&apos;t load the{' '}
              {providerFallback && modelFallback
                ? 'provider and model lists'
                : providerFallback
                  ? 'provider list'
                  : 'model list'}{' '}
              from the server. You can still enter {providerFallback ? 'a provider slug and ' : ''}a
              model id by hand below.
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
            {providerIsInherited && (
              <p className="text-muted-foreground text-xs">
                Inherited from the first active provider. Saving will lock this agent to{' '}
                <code className="font-mono">{currentProvider}</code>.
              </p>
            )}
          </div>

          {!providerFallback && providers.length > 1 && (
            <div className="grid gap-2">
              <Label>
                Fallback providers{' '}
                <FieldHelp title="Automatic provider failover">
                  If the primary provider is experiencing errors, the agent will try these providers
                  in order. Failover kicks in after repeated failures within a short window. Only
                  providers other than the primary are shown. Leave unchecked to disable failover.
                </FieldHelp>
              </Label>
              <div className="space-y-2 rounded-md border p-3">
                {providers
                  .filter((p) => p.slug !== currentProvider)
                  .map((p) => {
                    const checked = watch('fallbackProviders').includes(p.slug);
                    return (
                      <label key={p.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="rounded border-gray-300"
                          checked={checked}
                          onChange={(e) => {
                            const current = watch('fallbackProviders');
                            setValue(
                              'fallbackProviders',
                              e.target.checked
                                ? [...current, p.slug]
                                : current.filter((s: string) => s !== p.slug)
                            );
                          }}
                        />
                        {p.name}
                        <span className="text-muted-foreground font-mono text-xs">{p.slug}</span>
                      </label>
                    );
                  })}
              </div>
            </div>
          )}

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
            {modelFallback ? (
              <Input id="model" {...register('model')} className="font-mono" />
            ) : filteredModels.length === 0 ? (
              <>
                <Select
                  value=""
                  onValueChange={(v) => setValue('model', v, { shouldValidate: true })}
                  disabled
                >
                  <SelectTrigger id="model">
                    <SelectValue placeholder="No models registered for this provider" />
                  </SelectTrigger>
                  <SelectContent />
                </Select>
                <p className="text-muted-foreground text-xs">
                  No models are registered for{' '}
                  <code className="font-mono">{currentProvider || '(no provider)'}</code>. Add one
                  on the{' '}
                  <Link href="/admin/orchestration/providers" className="underline">
                    Providers page
                  </Link>{' '}
                  or pick a different provider above.
                </p>
              </>
            ) : (
              <Select
                value={currentModel}
                onValueChange={(v) => setValue('model', v, { shouldValidate: true })}
              >
                <SelectTrigger id="model">
                  <SelectValue placeholder="Pick a model" />
                </SelectTrigger>
                {/* Cap the popover at 60% of viewport height so a provider
                    with 20–30+ models still scrolls instead of running off
                    the screen on shorter monitors. The primitive's default
                    `max-h-[--radix-select-content-available-height]` only
                    covers the space below the trigger; on mid-page short
                    screens that's not enough. Combines with the existing
                    overflow-y-auto in the SelectContent base styles. */}
                <SelectContent className="max-h-[60vh]">
                  {filteredModels.map((m) => {
                    const isLegacy = (m as ModelOption & { isLegacy?: boolean }).isLegacy === true;
                    return (
                      <SelectItem
                        key={`${m.provider}:${m.id}`}
                        value={m.id}
                        data-testid={isLegacy ? `model-option-legacy-${m.id}` : undefined}
                      >
                        <span className="flex items-center gap-2">
                          <span className={isLegacy ? 'italic' : undefined}>{m.id}</span>
                          {isLegacy ? (
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-amber-900 uppercase dark:bg-amber-950/40 dark:text-amber-200">
                              no longer in matrix
                            </span>
                          ) : m.tier ? (
                            <span className="text-muted-foreground text-xs">— {m.tier}</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
            {modelIsInherited && (
              <p className="text-muted-foreground text-xs">
                Inherited from the system default chat model. Saving will lock this agent to{' '}
                <code className="font-mono">{currentModel}</code>.
              </p>
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

          <ReasoningEffortSelect
            id="reasoningEffort"
            value={watch('reasoningEffort')}
            onChange={(v) => setValue('reasoningEffort', v, { shouldDirty: true })}
          />

          <div className="grid gap-2">
            <Label htmlFor="monthlyBudgetUsd">
              Monthly budget (USD){' '}
              <FieldHelp title="Hard spend cap">
                Hard spend cap for this agent, in USD. When month-to-date spend reaches the cap, new
                chats are rejected with a friendly &ldquo;budget exhausted&rdquo; message until the
                calendar month rolls over or you raise the limit. Actual cost varies significantly
                by model — check the Costs page for per-model pricing. Leave blank to disable the
                cap.
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
            {errors.monthlyBudgetUsd && (
              <p className="text-destructive text-xs">{errors.monthlyBudgetUsd.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="maxCostPerTurnUsd">
              Per-turn cost cap (USD){' '}
              <FieldHelp title="Runaway-loop guard">
                Caps the total LLM cost of a single chat turn or workflow agent_call step (the
                messages exchanged before the model returns a final answer). Protects against a tool
                loop that keeps round-tripping without converging — a single bad question becomes a
                few cents instead of a few dollars. When the cap is hit, the loop stops: in chat the
                user sees a friendly &ldquo;response stopped early&rdquo; message; in a workflow the
                step fails with budget_exceeded_per_turn and the workflow&apos;s error strategy
                decides what happens next. Leave blank to inherit the org-wide default (Settings →
                Orchestration). When that is also blank, no per-turn cap applies — only the monthly
                budget above.
              </FieldHelp>
            </Label>
            <Input
              id="maxCostPerTurnUsd"
              type="number"
              step="0.01"
              {...register('maxCostPerTurnUsd', {
                setValueAs: (v: string | number) =>
                  v === '' || v === null || v === undefined ? null : Number(v),
              })}
            />
            {errors.maxCostPerTurnUsd && (
              <p className="text-destructive text-xs">{errors.maxCostPerTurnUsd.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="rateLimitRpm">
              Rate limit (RPM){' '}
              <FieldHelp title="Per-user request throttle">
                Maximum requests per minute each user can send to this specific agent. Limits are
                tracked per user per agent — a user&apos;s activity on one agent does not affect
                their limit on another. Leave blank to use the global default.
              </FieldHelp>
            </Label>
            <Input
              id="rateLimitRpm"
              type="number"
              placeholder="Use global default"
              {...register('rateLimitRpm', {
                setValueAs: (v: string | number) =>
                  v === '' || v === null || v === undefined ? null : Number(v),
              })}
            />
            {errors.rateLimitRpm && (
              <p className="text-destructive text-xs">{errors.rateLimitRpm.message}</p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="enableVoiceInput">
                Enable voice input{' '}
                <FieldHelp title="Speech-to-text">
                  When on, users see a microphone control in this agent&apos;s chat surfaces (admin
                  test panel and any embed widgets) and can record audio that&apos;s transcribed
                  before sending. Audio is forwarded to the configured speech-to-text provider and
                  discarded after transcription — only the transcript is stored as a normal user
                  message. Default: off.
                  <br />
                  <br />
                  <strong>Requirements:</strong>
                  <ul className="mt-1 list-disc pl-4">
                    <li>
                      The platform-wide switch at{' '}
                      <strong>
                        Admin → Orchestration → Settings → Voice input globally enabled
                      </strong>{' '}
                      must be on.
                    </li>
                    <li>
                      An audio-capable model row in the provider-models matrix (
                      <code>capability: audio</code>) — Whisper-1 ships in the default seed.
                    </li>
                    <li>
                      The audio default model under{' '}
                      <strong>Admin → Orchestration → Settings → Default models → Audio</strong>{' '}
                      pins which row <code>getAudioProvider()</code> selects at runtime. If unset,
                      the matrix falls back to the first audio-capable row by <code>isDefault</code>{' '}
                      /<code>createdAt</code>.
                    </li>
                  </ul>
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-sm">
                Lets users speak instead of typing. Requires an audio-capable provider to be
                configured.
              </p>
            </div>
            <Switch
              id="enableVoiceInput"
              checked={currentVoiceInput}
              onCheckedChange={(v) => setValue('enableVoiceInput', v, { shouldDirty: true })}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="enableImageInput">
                Enable image input{' '}
                <FieldHelp title="Image attachments on chat">
                  When on, users see a paperclip control in this agent&apos;s chat surfaces (admin
                  test panel and any embed widgets) and can attach images (JPEG, PNG, WebP, GIF) to
                  their message. Images are forwarded to the LLM as multimodal parts and discarded
                  after the turn — bytes are not persisted. Default: off.
                  <br />
                  <br />
                  <strong>Requirements:</strong>
                  <ul className="mt-1 list-disc pl-4">
                    <li>
                      The platform-wide switch at{' '}
                      <strong>
                        Admin → Orchestration → Settings → Image input globally enabled
                      </strong>{' '}
                      must be on.
                    </li>
                    <li>
                      The agent&apos;s resolved chat model must carry the <code>vision</code>{' '}
                      capability. Open the provider-models matrix to see which seeded rows qualify —
                      models without the capability return <code>IMAGE_NOT_SUPPORTED</code> at send
                      time.
                    </li>
                    <li>
                      Per-attachment cap: ~5 MB. Per-turn combined cap: ~25 MB. Max 10 attachments.
                    </li>
                  </ul>
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-sm">
                {supportsVision ? (
                  <>Lets users attach images to a turn. Requires a vision-capable model.</>
                ) : (
                  <>
                    The current model doesn&apos;t support image input. Switch to a{' '}
                    <code>vision</code>-capable model in the Model tab to enable.
                  </>
                )}
              </p>
            </div>
            <Switch
              id="enableImageInput"
              checked={currentImageInput}
              disabled={!supportsVision}
              onCheckedChange={(v) => setValue('enableImageInput', v, { shouldDirty: true })}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="enableDocumentInput">
                Enable document (PDF) input{' '}
                <FieldHelp title="PDF attachments on chat">
                  When on, users can attach PDFs to a chat turn alongside images. PDFs are sent to
                  the LLM as native document parts (no pre-extraction). Bytes are not persisted.
                  Default: off.
                  <br />
                  <br />
                  <strong>Requirements:</strong>
                  <ul className="mt-1 list-disc pl-4">
                    <li>
                      The platform-wide switch at{' '}
                      <strong>
                        Admin → Orchestration → Settings → Document input globally enabled
                      </strong>{' '}
                      must be on.
                    </li>
                    <li>
                      The agent&apos;s resolved chat model must carry the <code>documents</code>{' '}
                      capability. Open the provider-models matrix to see which seeded rows qualify —
                      models without the capability return <code>PDF_NOT_SUPPORTED</code>
                      at send time.
                    </li>
                    <li>
                      Per-attachment cap: ~5 MB. Counts against the same per-turn 25 MB combined cap
                      as images.
                    </li>
                  </ul>
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-sm">
                {supportsDocuments ? (
                  <>
                    Lets users attach PDFs to a turn. Requires a model with the{' '}
                    <code>documents</code> capability.
                  </>
                ) : (
                  <>
                    The current model doesn&apos;t support PDF input. Switch to a model with the{' '}
                    <code>documents</code> capability in the Model tab to enable.
                  </>
                )}
              </p>
            </div>
            <Switch
              id="enableDocumentInput"
              checked={currentDocumentInput}
              disabled={!supportsDocuments}
              onCheckedChange={(v) => setValue('enableDocumentInput', v, { shouldDirty: true })}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="maxHistoryTokens">
              Max history tokens{' '}
              <FieldHelp title="Context window override">
                Override the context window budget used when building the prompt. The system fits as
                much conversation history as possible after reserving space for instructions and the
                current message. Lower values reduce cost; higher values let the agent remember
                more. Leave blank to use the model&apos;s full context window.
                <br />
                <br />
                Token counts are computed with a provider-aware tokeniser — exact for OpenAI
                (gpt-4o, gpt-4, etc.) and a calibrated approximation for Anthropic, Gemini, and
                Llama-family models. Estimates lean conservative, so the agent may drop a slightly
                older message rather than risk overflowing the model&apos;s window.
              </FieldHelp>
            </Label>
            <Input
              id="maxHistoryTokens"
              type="number"
              placeholder="Use model default"
              {...register('maxHistoryTokens', {
                setValueAs: (v: string | number) =>
                  v === '' || v === null || v === undefined ? null : Number(v),
              })}
            />
            {errors.maxHistoryTokens && (
              <p className="text-destructive text-xs">{errors.maxHistoryTokens.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="maxHistoryMessages">
              Memory length (messages){' '}
              <FieldHelp title="Behavioural memory length">
                How many prior messages this agent remembers verbatim per turn. Older messages get
                rolled into a rolling summary that&apos;s persisted on the conversation row, so
                older context survives even when dropped from the live history — just in compressed
                form. Leave blank to use the platform default (50).
                <br />
                <br />
                Lower this for stateless or single-turn agents (e.g. classifiers, summarisers); use
                <code className="font-mono"> 0</code> for &ldquo;no verbatim history at all&rdquo;.
                Raise it for support concierges that benefit from a long memory. Distinct from
                <em> Max history tokens</em> above: that knob protects the model&apos;s context
                window; this one controls cost and behaviour even when the window has plenty of
                room.
              </FieldHelp>
            </Label>
            <Input
              id="maxHistoryMessages"
              type="number"
              min={0}
              max={500}
              placeholder="Use platform default (50)"
              {...register('maxHistoryMessages', {
                setValueAs: (v: string | number) =>
                  v === '' || v === null || v === undefined ? null : Number(v),
              })}
            />
            {errors.maxHistoryMessages && (
              <p className="text-destructive text-xs">{errors.maxHistoryMessages.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2 rounded-md border p-3">
              <Label htmlFor="inputGuardMode">
                Input guard{' '}
                <FieldHelp title="Prompt injection protection">
                  Controls how the agent handles suspected prompt injection in user messages.
                  &ldquo;Log only&rdquo; silently logs, &ldquo;Warn&rdquo; shows a warning in the
                  chat, &ldquo;Block&rdquo; rejects the message. Leave on &ldquo;Use global
                  default&rdquo; to inherit the platform-wide setting.
                </FieldHelp>
              </Label>
              <Select
                value={currentInputGuard ?? '__global__'}
                onValueChange={(v) =>
                  setValue(
                    'inputGuardMode',
                    v === '__global__' ? null : (v as 'log_only' | 'warn_and_continue' | 'block'),
                    {
                      shouldValidate: true,
                    }
                  )
                }
              >
                <SelectTrigger id="inputGuardMode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__global__">Use global default</SelectItem>
                  <SelectItem value="log_only">Log only</SelectItem>
                  <SelectItem value="warn_and_continue">Warn and continue</SelectItem>
                  <SelectItem value="block">Block</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2 rounded-md border p-3">
              <Label htmlFor="outputGuardMode">
                Output guard{' '}
                <FieldHelp title="Response content filtering">
                  Controls how the agent handles flagged content in its own responses (off-topic,
                  PII, brand-voice violations). Same modes as the input guard. Leave on &ldquo;Use
                  global default&rdquo; to inherit the platform-wide setting.
                </FieldHelp>
              </Label>
              <Select
                value={currentOutputGuard ?? '__global__'}
                onValueChange={(v) =>
                  setValue(
                    'outputGuardMode',
                    v === '__global__' ? null : (v as 'log_only' | 'warn_and_continue' | 'block'),
                    {
                      shouldValidate: true,
                    }
                  )
                }
              >
                <SelectTrigger id="outputGuardMode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__global__">Use global default</SelectItem>
                  <SelectItem value="log_only">Log only</SelectItem>
                  <SelectItem value="warn_and_continue">Warn and continue</SelectItem>
                  <SelectItem value="block">Block</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2 rounded-md border p-3">
              <Label htmlFor="citationGuardMode">
                Citation guard{' '}
                <FieldHelp title="Citation hygiene">
                  Validates that responses grounded in retrieved knowledge include the{' '}
                  <code>[N]</code> markers that align to the citation envelope. Flags under-citation
                  (sources retrieved but none cited) and hallucinated markers (a marker referenced
                  that no source produced). Leave on &ldquo;Use global default&rdquo; to inherit the
                  platform-wide setting.
                </FieldHelp>
              </Label>
              <Select
                value={currentCitationGuard ?? '__global__'}
                onValueChange={(v) =>
                  setValue(
                    'citationGuardMode',
                    v === '__global__' ? null : (v as 'log_only' | 'warn_and_continue' | 'block'),
                    {
                      shouldValidate: true,
                    }
                  )
                }
              >
                <SelectTrigger id="citationGuardMode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__global__">Use global default</SelectItem>
                  <SelectItem value="log_only">Log only</SelectItem>
                  <SelectItem value="warn_and_continue">Warn and continue</SelectItem>
                  <SelectItem value="block">Block</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <AgentTestCard providerId={currentProviderId} model={currentModel || null} />
        </TabsContent>

        {/* ================= TAB 3 — INSTRUCTIONS ================= */}
        <TabsContent value="instructions" className="space-y-6 pt-4">
          {/* Persona — inheritable */}
          <div className="grid gap-2">
            <Label htmlFor="persona">
              Persona{' '}
              <FieldHelp title="Who the agent is">
                Identity, role, perspective, backstory. Goes into the LLM&apos;s system message
                under a <code>[Persona]</code> header before the instructions below. Inheritable
                from the selected profile — leave blank to inherit, or populate to override (or
                append, see the checkbox).
              </FieldHelp>
            </Label>
            {selectedProfile?.persona && !currentPersona && (
              <p className="text-muted-foreground text-xs">
                Inheriting from profile &ldquo;{selectedProfile.name}&rdquo;.
              </p>
            )}
            <Textarea
              id="persona"
              rows={5}
              placeholder={
                selectedProfile?.persona
                  ? `Profile says: ${selectedProfile.persona.slice(0, 80)}${selectedProfile.persona.length > 80 ? '…' : ''}`
                  : 'You are Sky, a calm senior support specialist...'
              }
              {...register('persona', { setValueAs: (v: string) => (v === '' ? null : v) })}
            />
            {selectedProfile && currentPersona && (
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <Checkbox
                  id="personaAppend"
                  checked={currentPersonaMode === 'append'}
                  onCheckedChange={(v) =>
                    setValue('personaMode', v ? 'append' : 'override', { shouldDirty: true })
                  }
                />
                <Label
                  htmlFor="personaAppend"
                  className="text-muted-foreground text-xs font-normal"
                >
                  Append to profile (otherwise this overrides the profile&apos;s persona)
                </Label>
              </div>
            )}
            {errors.persona && <p className="text-destructive text-xs">{errors.persona.message}</p>}
          </div>

          {/* System instructions — never inherited */}
          <div className="grid gap-2">
            <Label htmlFor="systemInstructions">
              System instructions{' '}
              <FieldHelp title="What the agent does">
                The task description — what this agent is for, what it should and shouldn&apos;t do,
                formatting rules. Always agent-specific, never inherited from a profile. Every save
                snapshots the previous value to the version history below for compare and rollback.
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

          {/* Guardrails — inheritable */}
          <div className="grid gap-2">
            <Label htmlFor="guardrails">
              Guardrails{' '}
              <FieldHelp title="What the agent must not do">
                Refusals, escalation triggers, topic boundaries. Goes into the system message under
                a <code>[Guardrails]</code> header after the instructions. Inheritable from the
                selected profile. For hard enforcement use the workflow guard step — this is
                in-prompt steering.
              </FieldHelp>
            </Label>
            {selectedProfile?.guardrails && !currentGuardrails && (
              <p className="text-muted-foreground text-xs">
                Inheriting from profile &ldquo;{selectedProfile.name}&rdquo;.
              </p>
            )}
            <Textarea
              id="guardrails"
              rows={4}
              placeholder={
                selectedProfile?.guardrails
                  ? `Profile says: ${selectedProfile.guardrails.slice(0, 80)}${selectedProfile.guardrails.length > 80 ? '…' : ''}`
                  : 'Never give medical or legal advice...'
              }
              {...register('guardrails', { setValueAs: (v: string) => (v === '' ? null : v) })}
            />
            {selectedProfile && currentGuardrails && (
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <Checkbox
                  id="guardrailsAppend"
                  checked={currentGuardrailsMode === 'append'}
                  onCheckedChange={(v) =>
                    setValue('guardrailsMode', v ? 'append' : 'override', { shouldDirty: true })
                  }
                />
                <Label
                  htmlFor="guardrailsAppend"
                  className="text-muted-foreground text-xs font-normal"
                >
                  Append to profile (otherwise this overrides the profile&apos;s guardrails)
                </Label>
              </div>
            )}
            {errors.guardrails && (
              <p className="text-destructive text-xs">{errors.guardrails.message}</p>
            )}
          </div>

          {/* Brand voice — inheritable */}
          <div className="grid gap-2">
            <Label htmlFor="brandVoiceInstructions">
              Brand voice{' '}
              <FieldHelp title="How the agent should sound">
                Tone, register, style — short rules. Goes into the system message under a{' '}
                <code>[Brand Voice]</code> header as the final section. Inheritable from the
                selected profile.
              </FieldHelp>
            </Label>
            {selectedProfile?.brandVoiceInstructions && !currentVoice && (
              <p className="text-muted-foreground text-xs">
                Inheriting from profile &ldquo;{selectedProfile.name}&rdquo;.
              </p>
            )}
            <Textarea
              id="brandVoiceInstructions"
              rows={4}
              placeholder={
                selectedProfile?.brandVoiceInstructions
                  ? `Profile says: ${selectedProfile.brandVoiceInstructions.slice(0, 80)}${selectedProfile.brandVoiceInstructions.length > 80 ? '…' : ''}`
                  : 'e.g. Use a friendly, professional tone. Avoid jargon.'
              }
              {...register('brandVoiceInstructions', {
                setValueAs: (v: string) => (v === '' ? null : v),
              })}
            />
            {selectedProfile && currentVoice && (
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <Checkbox
                  id="voiceAppend"
                  checked={currentVoiceMode === 'append'}
                  onCheckedChange={(v) =>
                    setValue('voiceMode', v ? 'append' : 'override', { shouldDirty: true })
                  }
                />
                <Label htmlFor="voiceAppend" className="text-muted-foreground text-xs font-normal">
                  Append to profile (otherwise this overrides the profile&apos;s brand voice)
                </Label>
              </div>
            )}
            {errors.brandVoiceInstructions && (
              <p className="text-destructive text-xs">{errors.brandVoiceInstructions.message}</p>
            )}
          </div>

          {/* Effective prompt preview — live merge of agent + profile */}
          <EffectivePromptPreview resolved={effectivePrompt} profile={selectedProfile} />

          <KnowledgeAccessSection
            mode={watch('knowledgeAccessMode')}
            tagIds={watch('knowledgeTagIds')}
            documentIds={watch('knowledgeDocumentIds')}
            onModeChange={(next) => setValue('knowledgeAccessMode', next, { shouldDirty: true })}
            onTagsChange={(next) => setValue('knowledgeTagIds', next, { shouldDirty: true })}
            onDocumentsChange={(next) =>
              setValue('knowledgeDocumentIds', next, { shouldDirty: true })
            }
          />

          <div className="grid gap-2">
            <Label htmlFor="topicBoundaries">
              Topic boundaries{' '}
              <FieldHelp title="Forbidden topics for output guard">
                Comma-separated list of topics the agent should not discuss. The output guard checks
                responses against these boundaries and takes action based on the guard mode (log,
                warn, or block). For example: &ldquo;competitor pricing, legal advice,
                medical&rdquo;.
              </FieldHelp>
            </Label>
            <Input
              id="topicBoundaries"
              placeholder="e.g. competitor pricing, legal advice, medical"
              {...register('topicBoundaries')}
            />
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
            <div className="text-muted-foreground space-y-2 rounded-md border p-6 text-sm leading-relaxed">
              <p>
                <strong className="text-foreground">Capabilities</strong> are tools the agent can
                call mid-conversation — e.g. search a knowledge base, look up an order, send an
                email, hit an external API. The model picks them up automatically when a user&apos;s
                message needs one.
              </p>
              <p>
                Save the agent first, then come back to this tab to attach capabilities from the
                catalogue.
              </p>
            </div>
          )}
        </TabsContent>

        {/* ================= TAB 5 — INVITE TOKENS ================= */}
        <TabsContent value="invite-tokens" className="pt-4">
          {isEdit && agent && currentVisibility === 'invite_only' ? (
            <AgentInviteTokensTab agentId={agent.id} />
          ) : (
            <div className="rounded-md border p-6 text-center text-sm">
              <p className="text-muted-foreground">
                {!isEdit
                  ? 'Save the agent first, then manage invite tokens.'
                  : 'Set visibility to "Invite only" to manage tokens.'}
              </p>
            </div>
          )}
        </TabsContent>

        {/* ================= TAB 6 — VERSIONS ================= */}
        <TabsContent value="versions" className="pt-4">
          {isEdit && agent ? (
            <AgentVersionHistoryTab
              agentId={agent.id}
              onRestored={() => {
                // Re-pull the fresh agent into the form after a version restore.
                void (async () => {
                  try {
                    const fresh = await apiClient.get<AgentWithGrants>(
                      API.ADMIN.ORCHESTRATION.agentById(agent.id)
                    );
                    reset({
                      name: fresh.name,
                      slug: fresh.slug,
                      description: fresh.description,
                      systemInstructions: fresh.systemInstructions,
                      provider: fresh.provider,
                      model: fresh.model,
                      temperature: fresh.temperature,
                      maxTokens: fresh.maxTokens,
                      reasoningEffort: toReasoningEffortFormValue(fresh.reasoningEffort),
                      monthlyBudgetUsd: fresh.monthlyBudgetUsd ?? undefined,
                      maxCostPerTurnUsd: fresh.maxCostPerTurnUsd ?? null,
                      isActive: fresh.isActive,
                      inputGuardMode:
                        (fresh.inputGuardMode as AgentFormData['inputGuardMode']) ?? null,
                      outputGuardMode:
                        (fresh.outputGuardMode as AgentFormData['outputGuardMode']) ?? null,
                      citationGuardMode:
                        (fresh.citationGuardMode as AgentFormData['citationGuardMode']) ?? null,
                      maxHistoryTokens: fresh.maxHistoryTokens ?? null,
                      maxHistoryMessages: fresh.maxHistoryMessages ?? null,
                      retentionDays: fresh.retentionDays ?? null,
                      visibility: (fresh.visibility as AgentFormData['visibility']) ?? 'internal',
                      rateLimitRpm: fresh.rateLimitRpm ?? null,
                      fallbackProviders: fresh.fallbackProviders ?? [],
                      knowledgeAccessMode:
                        (fresh.knowledgeAccessMode as 'full' | 'restricted' | undefined) ?? 'full',
                      knowledgeTagIds: fresh.grantedTagIds ?? [],
                      knowledgeDocumentIds: fresh.grantedDocumentIds ?? [],
                      topicBoundaries: fresh.topicBoundaries?.join(', ') ?? '',
                      brandVoiceInstructions: fresh.brandVoiceInstructions ?? null,
                    });
                  } catch {
                    // Silent — the version tab already shows its own error state.
                  }
                })();
              }}
            />
          ) : (
            <div className="rounded-md border p-6 text-center text-sm">
              <p className="text-muted-foreground">Save the agent first to view version history.</p>
            </div>
          )}
        </TabsContent>

        {/* ================= TAB 7 — TEST ================= */}
        <TabsContent value="test" className="pt-4">
          {isEdit && agent ? (
            <ChatInterface
              agentSlug={agent.slug}
              agentId={agent.id}
              voiceInputEnabled={currentVoiceInput}
              imageInputEnabled={currentImageInput}
              documentInputEnabled={currentDocumentInput}
              showClearButton
              persistenceKey={`agent-test-chat:${agent.id}`}
              // Internal test surface — surface tool-call diagnostics
              // so the author can see exactly which capabilities the
              // model invoked and inspect their arguments.
              showInlineTrace
              className="h-[500px]"
            />
          ) : (
            <div className="rounded-md border p-6 text-center text-sm">
              <p className="text-muted-foreground">Save the agent first to test a chat.</p>
            </div>
          )}
        </TabsContent>

        {/* ================= TAB 8 — EMBED ================= */}
        <TabsContent value="embed" className="pt-4">
          {isEdit && agent ? (
            <EmbedConfigPanel agentId={agent.id} appUrl={process.env.NEXT_PUBLIC_APP_URL ?? ''} />
          ) : (
            <div className="text-muted-foreground space-y-2 rounded-md border p-6 text-sm leading-relaxed">
              <p>
                <strong className="text-foreground">Embed</strong> drops this agent onto a
                third-party site as a floating chat widget. You generate an origin-scoped token,
                paste a <code>&lt;script&gt;</code> snippet into the partner site&apos;s HTML, and
                the widget loads in a Shadow DOM (no CSS clash with the host page).
              </p>
              <p>
                Save the agent first to generate embed tokens and configure the widget&apos;s
                appearance.
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </form>
  );
}

/**
 * Live preview of the merged system prompt the LLM will actually receive.
 * Composes via the same helper that the chat handler and workflow
 * agent_call executor use, so what shows here is what the model gets.
 */
function EffectivePromptPreview({
  resolved,
  profile,
}: {
  resolved: ReturnType<typeof resolveEffectivePrompt>;
  profile: AgentProfileSummary | null;
}) {
  const composed = composeSystemPromptString(resolved);
  const sources = resolved.sources;

  function sourceLabel(source: typeof sources.persona): { label: string; tone: string } {
    switch (source) {
      case 'profile':
        return { label: `from profile "${profile?.name ?? ''}"`, tone: 'text-muted-foreground' };
      case 'agent':
        return { label: 'override', tone: 'text-amber-700 dark:text-amber-400' };
      case 'profile+agent':
        return {
          label: 'profile + agent additions',
          tone: 'text-blue-700 dark:text-blue-400',
        };
      case 'none':
      default:
        return { label: 'unset', tone: 'text-muted-foreground' };
    }
  }

  return (
    <details className="bg-muted/20 rounded-md border">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
        Effective prompt preview{' '}
        <span className="text-muted-foreground font-normal">— what the LLM actually sees</span>
      </summary>
      <div className="space-y-3 border-t px-4 py-3 text-sm">
        {/* Per-section source labels */}
        <div className="grid grid-cols-2 gap-1 text-xs sm:grid-cols-4">
          {(['persona', 'systemInstructions', 'guardrails', 'brandVoiceInstructions'] as const).map(
            (key) => {
              const label =
                key === 'systemInstructions'
                  ? 'Instructions'
                  : key === 'brandVoiceInstructions'
                    ? 'Brand voice'
                    : key === 'persona'
                      ? 'Persona'
                      : 'Guardrails';
              const src = key === 'systemInstructions' ? 'agent' : sources[key];
              const { label: sl, tone } = sourceLabel(src);
              return (
                <div key={key}>
                  <div className="text-muted-foreground font-medium">{label}</div>
                  <div className={tone}>{sl}</div>
                </div>
              );
            }
          )}
        </div>

        {/* Composed text */}
        <pre className="bg-background max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
          {composed || '(empty)'}
        </pre>
      </div>
    </details>
  );
}
