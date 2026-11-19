/**
 * Everything that uses a catalogue model (§136 t-1065): agents and workflows,
 * in every org, and the install settings that name it.
 *
 * Agents and workflows come from `providerModelUsage`, the one module allowed
 * to count across orgs (`global-config-usage.ts`): the caller's own are named,
 * every other org's only counted. The settings pins come from
 * `settingsPinsFor`. This composes the two for the model's page and for
 * config health; it reads nothing across orgs itself.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import {
  providerModelUsage,
  type CountScope,
  type ProviderModelUsage,
} from '@/lib/orchestration/admin/global-config-usage';
import {
  settingsPinsFor,
  type PinnedModelRef,
  type SettingsPin,
} from '@/lib/orchestration/model-lifecycle/settings-pins';
import { modelLifecycleState } from '@/lib/orchestration/model-lifecycle/state';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { hydrateFromDb } from '@/lib/orchestration/llm/model-registry-db-hydrate';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { logger } from '@/lib/logging';

export interface ModelUses extends ProviderModelUsage {
  /** The install settings that name the model. */
  settings: SettingsPin[];
}

/** Whether anything at all uses the model. */
export function isInUse(uses: ModelUses): boolean {
  return (
    uses.agents.length +
      uses.otherOrgAgents +
      uses.workflows.length +
      uses.otherOrgWorkflows +
      uses.settings.length >
    0
  );
}

/**
 * The provider the runtime resolves a bare model id to, or `null` when it
 * cannot tell. A task default and a workflow's `modelOverride` name an id
 * alone; when two providers offer it, the registry settles it on one (its
 * built-in and OpenRouter entries first, then the catalogue's, oldest row
 * first), and only that provider's row is the one they use. The registry is
 * hydrated from the catalogue first, as every LLM call does; a failed
 * hydrate answers `null`, which counts every row with the id, rather than
 * hiding a use.
 */
export async function bareIdProvider(modelId: string): Promise<string | null> {
  return (await hydrateRegistry()) ? registryProvider(modelId) : null;
}

/**
 * Hydrate the model registry from the catalogue (throttled, as every LLM call
 * does). `false` when that failed: the caller then knows nothing about which
 * provider an id resolves to.
 */
export async function hydrateRegistry(): Promise<boolean> {
  try {
    await hydrateFromDb();
    return true;
  } catch (err) {
    logger.warn('Model registry hydrate failed; counting every row with a shared id', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** The provider the (hydrated) registry resolves `modelId` to, or `null`. */
export function registryProvider(modelId: string): string | null {
  return getModel(modelId)?.provider ?? null;
}

/** Everything that uses `model`. `options` as `providerModelUsage`'s. */
export async function modelUses(
  model: PinnedModelRef,
  options: CountScope = {}
): Promise<ModelUses> {
  const resolved = await bareIdProvider(model.modelId);
  const [usage, settings] = await Promise.all([
    providerModelUsage(model.providerSlug, model.modelId, { ...options, bareIdProvider: resolved }),
    getOrchestrationSettings(),
  ]);
  return { ...usage, settings: settingsPinsFor(model, settings, { bareIdProvider: resolved }) };
}

/** How many models with a retirement date are still in use, by state. */
export interface RetiringModelsInUse {
  retiring: number;
  retired: number;
}

/**
 * The models with a retirement date that something still uses, in every org,
 * counted by state at `now`. For config health, which reports presence only.
 * Few models carry a date at once, so each is looked up on its own.
 */
export async function retiringModelsInUse(now: Date = new Date()): Promise<RetiringModelsInUse> {
  const dated = await prisma.aiProviderModel.findMany({
    where: { retiresAt: { not: null } },
    select: { id: true, providerSlug: true, modelId: true, retiresAt: true },
  });
  const counts: RetiringModelsInUse = { retiring: 0, retired: 0 };
  if (dated.length === 0) return counts;
  const settings = await getOrchestrationSettings();
  for (const model of dated) {
    const state = modelLifecycleState(model, now);
    if (state === 'current') continue;
    const resolved = await bareIdProvider(model.modelId);
    const usage = await providerModelUsage(model.providerSlug, model.modelId, {
      bareIdProvider: resolved,
    });
    const pins = settingsPinsFor(model, settings, { bareIdProvider: resolved });
    if (isInUse({ ...usage, settings: pins })) counts[state]++;
  }
  return counts;
}
