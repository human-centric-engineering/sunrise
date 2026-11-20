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
 * **A model named by its id alone.** An agent names provider and model, and
 * since §136 t-1068 so does a task default or a step's `modelOverride` saved
 * from the admin (`provider::model`, `model-pin.ts`). One saved before then,
 * the system's suggestion for an unsaved default, and the `embeddings`
 * default name the id only. When another provider offers the same id
 * (`gpt-4o` under OpenAI and Azure), such a pin cannot say which row it runs
 * on. It is not guessed (owner ruling): it counts as a use of every row with
 * the id, and `sharedWith` names the other providers so the page can say so.
 * Only active rows count as somewhere it might run: the registry loads no
 * other. For config health that is narrowed the safe way: a by-id-only use
 * raises an alert only when every row with the id is dated, and at the least
 * severe of their states, since it runs on one of them and that is the best
 * case.
 *
 * **An app's own pins** (§136 t-1067). An app may report the models it names
 * in its own code and tables (`app-pins.ts`, the `lib/app/model-pins.ts`
 * seam). They are counted here as this model's uses, the caller's org's named
 * and every other org's counted, like the rest. A report that fails is marked
 * (`appPinsUnavailable`), never guessed.
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
import {
  reportAppModelPins,
  type AppModelPin,
  type AppPinModel,
} from '@/lib/orchestration/model-lifecycle/app-pins';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';

export interface ModelUses extends ProviderModelUsage {
  /** The install settings that name the model. */
  settings: SettingsPin[];
  /**
   * The other providers whose catalogue rows have the same model id. Empty
   * when the id is the model's alone; then a by-id-only pin is exactly this
   * model's use.
   */
  sharedWith: string[];
  /** The app's own uses in the caller's org, as its reporter names them (§136 t-1067). */
  appPins: AppModelPin[];
  /** The app's uses in other orgs, counted. */
  otherOrgAppPins: number;
  /** Some org's report of the app's uses failed: they may be undercounted. */
  appPinsUnavailable: boolean;
}

/** A catalogue row with what the app's reporter is told about it. */
export type UsesModel = PinnedModelRef & Pick<AppPinModel, 'id' | 'name'>;

/**
 * The app's uses of `model`, split into the caller's (named) and every other
 * org's (counted), by the rule `providerModelUsage` keeps: every pin is the
 * caller's at `single`, the entered org's alone at `multi`.
 */
async function appUses(
  model: UsesModel,
  options: CountScope
): Promise<Pick<ModelUses, 'appPins' | 'otherOrgAppPins' | 'appPinsUnavailable'>> {
  const current = isMultiTenant() ? (getTenantContext()?.orgId ?? null) : null;
  const report = await reportAppModelPins(
    { id: model.id, name: model.name, providerSlug: model.providerSlug, modelId: model.modelId },
    options
  );
  const isCallers = (orgId: string) => !isMultiTenant() || orgId === current;
  const own = report.pins.filter((pin) => isCallers(pin.orgId));
  return {
    appPins: own.map(({ label, where }) => ({ label, where })),
    otherOrgAppPins: report.pins.length - own.length,
    appPinsUnavailable: report.failed,
  };
}

/**
 * The other active catalogue rows with `model`'s id, on other providers: the
 * rows a by-id-only pin might run on instead. A turned-off row is left out,
 * since the model registry loads only active rows.
 */
function siblings(model: PinnedModelRef) {
  return prisma.aiProviderModel.findMany({
    where: { modelId: model.modelId, providerSlug: { not: model.providerSlug }, isActive: true },
    select: { providerSlug: true, retiresAt: true },
    orderBy: { providerSlug: 'asc' },
  });
}

/** Everything that uses `model`. `options` as `providerModelUsage`'s. */
export async function modelUses(model: UsesModel, options: CountScope = {}): Promise<ModelUses> {
  const [usage, settings, others, app] = await Promise.all([
    providerModelUsage(model.providerSlug, model.modelId, options),
    getOrchestrationSettings(),
    siblings(model),
    appUses(model, options),
  ]);
  return {
    ...usage,
    settings: settingsPinsFor(model, settings),
    sharedWith: others.map((o) => o.providerSlug),
    ...app,
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
 *
 * The app's reporter (§136 t-1067) is asked only about a dated model nothing
 * of the platform's uses exactly, since it cannot change the answer for the
 * rest. A report that fails throws: config health then reports its checks as
 * not able to run, rather than raise an alert about uses nobody can name or
 * pass a model nobody can clear.
 *
 * @throws Error when the app's report on such a model failed.
 */
export async function retiringModelsInUse(now: Date = new Date()): Promise<RetiringModelsInUse> {
  const dated = await prisma.aiProviderModel.findMany({
    where: { retiresAt: { not: null } },
    select: { id: true, name: true, providerSlug: true, modelId: true, retiresAt: true },
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
    // Agents, and the pins that name the provider, are this model's own uses.
    const ownWorkflowsByIdOnly = usage.workflows.filter((w) => w.byIdOnly).length;
    const exact =
      usage.agents.length +
      usage.otherOrgAgents +
      (usage.workflows.length - ownWorkflowsByIdOnly) +
      (usage.otherOrgWorkflows - usage.otherOrgWorkflowsByIdOnly) +
      pins.filter((p) => !p.byIdOnly).length;
    if (exact > 0) {
      counts[state]++;
      continue;
    }
    // The app reports its uses of this row, so each is exact. A report that
    // failed may have missed one: not known either way.
    const app = await reportAppModelPins({
      id: model.id,
      name: model.name,
      providerSlug: model.providerSlug,
      modelId: model.modelId,
    });
    if (app.pins.length > 0) {
      counts[state]++;
      continue;
    }
    // Pins naming the id alone may run on another row with the id. They alert
    // only when every such row is dated, and at the least severe of their
    // states: retired only when all of them are.
    const byIdOnly =
      ownWorkflowsByIdOnly +
      usage.otherOrgWorkflowsByIdOnly +
      pins.filter((p) => p.byIdOnly).length;
    const states = [state, ...others.map((o) => modelLifecycleState(o, now))];
    if (byIdOnly > 0 && !states.includes('current')) {
      counts[states.includes('retiring') ? 'retiring' : 'retired']++;
      continue;
    }
    if (app.failed) {
      throw new Error(`The app's own uses of dated model ${model.id} could not be read`);
    }
  }
  return counts;
}
