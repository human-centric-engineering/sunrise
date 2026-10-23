import type { Metadata } from 'next';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
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
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { FieldHelp } from '@/components/ui/field-help';
import { env } from '@/lib/env';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData, type LoadResult } from '@/lib/api/server-load';
import type { ModelInfo } from '@/lib/orchestration/llm/types';
import type { OrchestrationSettings as FullOrchestrationSettings } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Settings · AI Orchestration',
  description:
    'Global orchestration settings — default models, guard modes, budget, limits, retention, approvals, and search.',
};

/**
 * The settings singleton is the page's main data. A failed load throws to
 * the error boundary: pre-filling the forms with defaults would let an admin
 * save those defaults over the real settings (#518).
 */
/** The singleton, with the escalation list's version a save of it sends back (§122 t-899). */
type LoadedSettings = FullOrchestrationSettings & { escalationVersion: string };

async function getSettings(): Promise<LoadedSettings> {
  const { data } = await requireServerData<LoadedSettings>(API.ADMIN.ORCHESTRATION.SETTINGS);
  return data;
}

interface ChatMatrixRow {
  modelId: string;
  name: string;
  providerSlug: string;
  tierRole: string;
  deploymentProfiles?: string[];
}

async function getChatModels(): Promise<LoadResult<ModelInfo[]>> {
  // Source from the curated provider-models matrix
  // (`prisma/seeds/009-provider-models.ts`) rather than the chat-only
  // model registry. The matrix has the full vendor catalogue per
  // provider — e.g. GPT-5, GPT-4.1, GPT-4o, GPT-4o Mini for OpenAI —
  // whereas the registry's static fallback only has 2 OpenAI entries.
  //
  // Filter to `capability=chat` so embedding-only models (Voyage, etc.)
  // don't leak into the chat / routing / reasoning dropdowns.
  const result = await loadServerData<ChatMatrixRow[]>(
    `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?capability=chat&isActive=true&limit=100`
  );
  if (!result.ok) return result;
  // Reshape to `ModelInfo` so the form's existing filtering /
  // labelling logic stays the same. The fields that don't apply to
  // matrix rows (cost, context, tool support) get stub values; the
  // form only reads `id`, `name`, `provider`, `tier`.
  return {
    ...result,
    data: result.data.map((row) => ({
      id: row.modelId,
      name: row.name,
      provider: row.providerSlug,
      tier: matrixTierToModelTier(row.tierRole, row.deploymentProfiles),
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      maxContext: 0,
      supportsTools: false,
    })),
  };
}

/** Map matrix `tierRole` strings + `deploymentProfiles` to the registry's narrower `ModelTier`.
 *
 * Sovereign deployment trumps tier classification — a sovereign-deployable
 * thinking-tier model still collapses to the `local` registry label so
 * existing filters keep behaving. Mirrors `mapTierRoleToTier()` in
 * `lib/orchestration/llm/db-model-adapter.ts`. */
function matrixTierToModelTier(tierRole: string, deploymentProfiles?: string[]): ModelInfo['tier'] {
  if (deploymentProfiles?.includes('sovereign')) return 'local';
  switch (tierRole) {
    case 'thinking':
      return 'frontier';
    case 'worker':
      return 'mid';
    case 'infrastructure':
    case 'control_plane':
      return 'budget';
    default:
      return 'mid';
  }
}

interface ProviderSummary {
  slug: string;
  name: string;
  isActive: boolean;
}

function getProviders(): Promise<LoadResult<ProviderSummary[]>> {
  // The form uses configured providers to scope the chat/routing/reasoning
  // dropdowns and to decide whether to render the "configure a provider
  // first" CTA. Inactive rows are still returned so the form can list
  // them but mark them as needing reactivation.
  return loadServerData<ProviderSummary[]>(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=50`);
}

interface EmbeddingModel {
  id: string;
  name: string;
  provider: string;
  model: string;
}

function getEmbeddingModels(): Promise<LoadResult<EmbeddingModel[]>> {
  // The embeddings dropdown is sourced separately from the chat-model
  // registry — chat models can't embed and we don't want to mislead
  // operators by listing them.
  return loadServerData<EmbeddingModel[]>(API.ADMIN.ORCHESTRATION.EMBEDDING_MODELS);
}

interface AudioMatrixRowApi {
  modelId: string;
  name: string;
  providerSlug: string;
}

async function getAudioModels(): Promise<
  LoadResult<Array<{ model: string; name: string; providerSlug: string }>>
> {
  // Audio dropdown is matrix-driven: rows with `capability: audio`.
  // Separate from the chat/registry path because audio support is
  // declared per-row in AiProviderModel, not in the static chat model
  // registry. Mirrors the chat-models fetch above for consistency.
  // The API returns `modelId` but the form's AudioModelSummary uses
  // `model` (matching EmbeddingModelSummary's shape), so reshape here.
  const result = await loadServerData<AudioMatrixRowApi[]>(
    `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?capability=audio&isActive=true&limit=100`
  );
  if (!result.ok) return result;
  return {
    ...result,
    data: result.data.map((row) => ({
      model: row.modelId,
      name: row.name,
      providerSlug: row.providerSlug,
    })),
  };
}

interface EmbeddingMatrixRowApi {
  id: string;
  modelId: string;
  providerSlug: string;
  name: string;
  dimensions: number | null;
}

async function getEmbeddingMatrixRows(): Promise<LoadResult<ActiveEmbeddingModelOption[]>> {
  // The "active embedding model" picker is FK-driven, so it needs the
  // `AiProviderModel.id` for each row — `getEmbeddingModels()` above
  // returns the registry shape (bare model id, no FK), which is fine
  // for the chat-task embeddings dropdown but not for this picker.
  // Filter to embedding-capable, active rows; the form additionally
  // requires a non-null `dimensions` and drops rows that lack it.
  const result = await loadServerData<EmbeddingMatrixRowApi[]>(
    `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?capability=embedding&isActive=true&limit=100`
  );
  if (!result.ok) return result;
  return {
    ...result,
    data: result.data
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
      })),
  };
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
  // full row through.
  const formSettings: OrchestrationSettings = fullSettings;

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <span>Settings</span>
      </nav>

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
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

      <SharedSettingsReadOnlyNotice />

      {/* Each form needs its option lists. Without them its dropdowns would be
          empty and "No providers configured yet" would show, so a failed load
          shows a notice in the form's place (#518). */}
      {models.ok && providers.ok && embeddingModels.ok && audioModels.ok ? (
        <DefaultModelsForm
          settings={fullSettings}
          models={models.data}
          providers={providers.data}
          embeddingModels={embeddingModels.data}
          audioModels={audioModels.data}
        />
      ) : (
        <LoadFailedNotice what="the default model options" />
      )}

      {embeddingMatrixRows.ok ? (
        <ActiveEmbeddingModelForm
          initialActiveEmbeddingModelId={fullSettings.activeEmbeddingModelId ?? null}
          options={embeddingMatrixRows.data}
        />
      ) : (
        <LoadFailedNotice what="the embedding model options" />
      )}

      <SettingsForm
        initialSettings={formSettings}
        // Server-only env, so the client guard cannot read it directly (#553).
        allowPrivateEscalationWebhook={env.ESCALATION_WEBHOOK_ALLOW_PRIVATE}
      />

      <BackupPanel />
    </div>
  );
}
