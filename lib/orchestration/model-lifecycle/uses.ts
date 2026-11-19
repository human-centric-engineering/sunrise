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
 * **A model named by its id alone.** An agent names provider and model; a
 * workflow step's `modelOverride` and most task defaults name the id only.
 * When another provider offers the same id (`gpt-4o` under OpenAI and
 * Azure), such a pin cannot say which row it runs on. It is not guessed
 * (owner ruling): it counts as a use of every row with the id, and
 * `sharedWith` names the other providers so the page can say so. For config
 * health that is narrowed the safe way: a by-id-only use raises a model's
 * alert only when every row with the id is dated, since then it runs on a
 * dated model whichever row it is. t-1068 makes every pin name its provider.
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
  /**
   * The other providers whose catalogue rows have the same model id. Empty
   * when the id is the model's alone; then a by-id-only pin is exactly this
   * model's use.
   */
  sharedWith: string[];
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

/** The other catalogue rows with `model`'s id, on other providers. */
function siblings(model: PinnedModelRef) {
  return prisma.aiProviderModel.findMany({
    where: { modelId: model.modelId, providerSlug: { not: model.providerSlug } },
    select: { providerSlug: true, retiresAt: true },
    orderBy: { providerSlug: 'asc' },
  });
}

/** Everything that uses `model`. `options` as `providerModelUsage`'s. */
export async function modelUses(
  model: PinnedModelRef,
  options: CountScope = {}
): Promise<ModelUses> {
  const [usage, settings, others] = await Promise.all([
    providerModelUsage(model.providerSlug, model.modelId, options),
    getOrchestrationSettings(),
    siblings(model),
  ]);
  return {
    ...usage,
    settings: settingsPinsFor(model, settings),
    sharedWith: others.map((o) => o.providerSlug),
  };
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
    const [usage, others] = await Promise.all([
      providerModelUsage(model.providerSlug, model.modelId),
      siblings(model),
    ]);
    const pins = settingsPinsFor(model, settings);
    // Agents and provider-naming settings are this model's own uses.
    const exact =
      usage.agents.length + usage.otherOrgAgents + pins.filter((p) => !p.byIdOnly).length;
    // Workflow pins and by-id-only settings may be another provider's row's,
    // unless every row with the id is dated: then it is a dated model either way.
    const byIdOnly =
      usage.workflows.length + usage.otherOrgWorkflows + pins.filter((p) => p.byIdOnly).length;
    const allRowsDated = others.every((o) => o.retiresAt != null);
    if (exact > 0 || (byIdOnly > 0 && allRowsDated)) counts[state]++;
  }
  return counts;
}
