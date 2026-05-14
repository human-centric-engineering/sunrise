import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ActiveEmbeddingModelForm,
  type ActiveEmbeddingModelOption,
} from '@/components/admin/orchestration/active-embedding-model-form';
import { DefaultModelsForm } from '@/components/admin/orchestration/default-models-form';
import {
  SettingsForm,
  type OrchestrationSettings,
} from '@/components/admin/orchestration/settings-form';
import { BackupPanel } from '@/components/admin/orchestration/settings/backup-panel';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { ModelInfo } from '@/lib/orchestration/llm/types';
import type { OrchestrationSettings as FullOrchestrationSettings } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Settings · AI Orchestration',
  description:
    'Global orchestration settings — default models, guard modes, budget, limits, retention, approvals, and search.',
};

const DEFAULT_SETTINGS: OrchestrationSettings = {
  inputGuardMode: null,
  outputGuardMode: null,
  citationGuardMode: null,
  globalMonthlyBudgetUsd: null,
  defaultApprovalTimeoutMs: null,
  approvalDefaultAction: null,
  searchConfig: null,
  webhookRetentionDays: null,
  costLogRetentionDays: null,
  auditLogRetentionDays: null,
  maxConversationsPerUser: null,
  maxMessagesPerConversation: null,
  escalationConfig: null,
};

async function getSettings(): Promise<FullOrchestrationSettings | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.SETTINGS);
    if (!res.ok) return null;
    const body = await parseApiResponse<FullOrchestrationSettings>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('settings page: fetch failed', err);
    return null;
  }
}

interface ChatMatrixRow {
  modelId: string;
  name: string;
  providerSlug: string;
  tierRole: string;
}

async function getChatModels(): Promise<ModelInfo[]> {
  // Source from the curated provider-models matrix
  // (`prisma/seeds/009-provider-models.ts`) rather than the chat-only
  // model registry. The matrix has the full vendor catalogue per
  // provider — e.g. GPT-5, GPT-4.1, GPT-4o, GPT-4o Mini for OpenAI —
  // whereas the registry's static fallback only has 2 OpenAI entries.
  //
  // Filter to `capability=chat` so embedding-only models (Voyage, etc.)
  // don't leak into the chat / routing / reasoning dropdowns.
  try {
    const res = await serverFetch(
      `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?capability=chat&isActive=true&limit=100`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<ChatMatrixRow[]>(res);
    if (!body.success) return [];
    // Reshape to `ModelInfo` so the form's existing filtering /
    // labelling logic stays the same. The fields that don't apply to
    // matrix rows (cost, context, tool support) get stub values; the
    // form only reads `id`, `name`, `provider`, `tier`.
    return body.data.map((row) => ({
      id: row.modelId,
      name: row.name,
      provider: row.providerSlug,
      tier: matrixTierToModelTier(row.tierRole),
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      maxContext: 0,
      supportsTools: false,
    }));
  } catch (err) {
    logger.error('settings page: chat models fetch failed', err);
    return [];
  }
}

/** Map matrix `tierRole` strings to the registry's narrower `ModelTier`. */
function matrixTierToModelTier(tierRole: string): ModelInfo['tier'] {
  switch (tierRole) {
    case 'thinking':
      return 'frontier';
    case 'worker':
      return 'mid';
    case 'infrastructure':
    case 'control_plane':
      return 'budget';
    case 'local_sovereign':
      return 'local';
    default:
      return 'mid';
  }
}

interface ProviderSummary {
  slug: string;
  name: string;
  isActive: boolean;
}

async function getProviders(): Promise<ProviderSummary[]> {
  // The form uses configured providers to scope the chat/routing/reasoning
  // dropdowns and to decide whether to render the "configure a provider
  // first" CTA. Inactive rows are still returned so the form can list
  // them but mark them as needing reactivation.
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=50`);
    if (!res.ok) return [];
    const body = await parseApiResponse<ProviderSummary[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('settings page: providers fetch failed', err);
    return [];
  }
}

interface EmbeddingModel {
  id: string;
  name: string;
  provider: string;
  model: string;
}

async function getEmbeddingModels(): Promise<EmbeddingModel[]> {
  // The embeddings dropdown is sourced separately from the chat-model
  // registry — chat models can't embed and we don't want to mislead
  // operators by listing them.
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.EMBEDDING_MODELS);
    if (!res.ok) return [];
    const body = await parseApiResponse<EmbeddingModel[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('settings page: embedding models fetch failed', err);
    return [];
  }
}

interface AudioMatrixRowApi {
  modelId: string;
  name: string;
  providerSlug: string;
}

async function getAudioModels(): Promise<
  Array<{ model: string; name: string; providerSlug: string }>
> {
  // Audio dropdown is matrix-driven: rows with `capability: audio`.
  // Separate from the chat/registry path because audio support is
  // declared per-row in AiProviderModel, not in the static chat model
  // registry. Mirrors the chat-models fetch above for consistency.
  // The API returns `modelId` but the form's AudioModelSummary uses
  // `model` (matching EmbeddingModelSummary's shape), so reshape here.
  try {
    const res = await serverFetch(
      `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?capability=audio&isActive=true&limit=100`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<AudioMatrixRowApi[]>(res);
    if (!body.success) return [];
    return body.data.map((row) => ({
      model: row.modelId,
      name: row.name,
      providerSlug: row.providerSlug,
    }));
  } catch (err) {
    logger.error('settings page: audio models fetch failed', err);
    return [];
  }
}

interface EmbeddingMatrixRowApi {
  id: string;
  modelId: string;
  providerSlug: string;
  name: string;
  dimensions: number | null;
}

async function getEmbeddingMatrixRows(): Promise<ActiveEmbeddingModelOption[]> {
  // The "active embedding model" picker is FK-driven, so it needs the
  // `AiProviderModel.id` for each row — `getEmbeddingModels()` above
  // returns the registry shape (bare model id, no FK), which is fine
  // for the chat-task embeddings dropdown but not for this picker.
  // Filter to embedding-capable, active rows; the form additionally
  // requires a non-null `dimensions` and drops rows that lack it.
  try {
    const res = await serverFetch(
      `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?capability=embedding&isActive=true&limit=100`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<EmbeddingMatrixRowApi[]>(res);
    if (!body.success) return [];
    return body.data
      .filter(
        (row): row is EmbeddingMatrixRowApi & { dimensions: number } =>
          typeof row.dimensions === 'number' && row.dimensions > 0
      )
      .map((row) => ({
        id: row.id,
        name: row.name,
        modelId: row.modelId,
        providerSlug: row.providerSlug,
        dimensions: row.dimensions,
      }));
  } catch (err) {
    logger.error('settings page: embedding matrix fetch failed', err);
    return [];
  }
}

export default async function OrchestrationSettingsPage() {
  const [fullSettings, models, providers, embeddingModels, audioModels, embeddingMatrixRows] =
    await Promise.all([
      getSettings(),
      getChatModels(),
      getProviders(),
      getEmbeddingModels(),
      getAudioModels(),
      getEmbeddingMatrixRows(),
    ]);

  // The narrow `OrchestrationSettings` shape that `SettingsForm` accepts
  // is a structural subset of the full singleton, so we can hand the
  // full row through. On fetch failure we fall back to typed defaults
  // so the form still renders with empty fields.
  const formSettings: OrchestrationSettings = fullSettings ?? DEFAULT_SETTINGS;

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Settings</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Settings{' '}
          <FieldHelp title="Global orchestration settings" contentClassName="w-96">
            <p>
              These settings apply platform-wide. Individual agents can override some of these (like
              guard mode) in their own configuration.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Default models, guard modes, spending caps, usage limits, retention, approvals, and search
          tuning.
        </p>
      </header>

      <DefaultModelsForm
        settings={fullSettings}
        models={models}
        providers={providers}
        embeddingModels={embeddingModels}
        audioModels={audioModels}
      />

      <ActiveEmbeddingModelForm
        initialActiveEmbeddingModelId={fullSettings?.activeEmbeddingModelId ?? null}
        options={embeddingMatrixRows}
      />

      <SettingsForm initialSettings={formSettings} />

      <BackupPanel />
    </div>
  );
}
