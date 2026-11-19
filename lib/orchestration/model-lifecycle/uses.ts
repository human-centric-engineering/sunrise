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

/** Everything that uses `model`. `options` as `providerModelUsage`'s. */
export async function modelUses(
  model: PinnedModelRef,
  options: CountScope = {}
): Promise<ModelUses> {
  const [usage, settings] = await Promise.all([
    providerModelUsage(model.providerSlug, model.modelId, options),
    getOrchestrationSettings(),
  ]);
  return { ...usage, settings: settingsPinsFor(model, settings) };
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
    const usage = await providerModelUsage(model.providerSlug, model.modelId);
    if (isInUse({ ...usage, settings: settingsPinsFor(model, settings) })) counts[state]++;
  }
  return counts;
}
