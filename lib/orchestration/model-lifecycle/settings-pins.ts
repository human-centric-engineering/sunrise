/**
 * The install settings that name a catalogue model (§136 t-1065).
 *
 * The orchestration settings are one row for the install, so these pins are
 * not per org: an agent with no model of its own falls back to the task
 * defaults, and the confidential-message and active-embedding choices apply
 * to every org. Agents and workflows that name a model are found by
 * `providerModelUsage` in `lib/orchestration/admin/global-config-usage.ts`;
 * this is the other half of "what uses this model".
 *
 * One matching rule per slot, shared by the provider-models list (its
 * `defaultFor` badge) and the model's uses, so the two cannot disagree:
 *
 * - **Task defaults** are model pins (`model-pin.ts`, §136 t-1068):
 *   `${providerSlug}::${modelId}`, which matches when both agree. A bare
 *   model id (saved before t-1068, the system's suggestion for an unsaved
 *   slot, and always the `embeddings` slot, whose provider the embedding
 *   fallback chain chooses) matches on the id alone and is marked
 *   `byIdOnly`: when two providers offer the id (`gpt-4o` under OpenAI and
 *   Azure), the pin cannot say which it runs on, and every row with the id is
 *   given it rather than a guess (owner ruling). The effective map is used,
 *   saved values and the system's suggestions for unsaved slots alike,
 *   because both are what an agent without a model inherits; `source` says
 *   which.
 * - **The confidential model** (§130) stores provider and model apart; both
 *   must agree.
 * - **The active embedding model** is a row id.
 *
 * The two embedding pins are listed with `movedBy: 'embedding_switch'`:
 * changing the embedding model means re-embedding every org's documents,
 * which is §132's job, so the model-lifecycle move never touches them.
 *
 * Pure: no database, no Next.js imports.
 */

import { pinNames } from '@/lib/orchestration/llm/model-pin';
import { TASK_TYPES, type TaskType } from '@/types/orchestration';

/** A settings slot that can name a model. */
export type SettingsPinSlot = TaskType | 'confidential' | 'active_embedding';

export interface SettingsPin {
  slot: SettingsPinSlot;
  /**
   * `saved` — an administrator chose it; `suggested` — the system's pick for a
   * task default nobody saved, which changes on its own as the catalogue does.
   */
  source: 'saved' | 'suggested';
  /** Set when this feature's move leaves the pin alone, and what moves it instead. */
  movedBy?: 'embedding_switch';
  /**
   * Set when the setting names the model by its id alone, with no provider:
   * if another provider offers the same id, it may run on that provider's
   * model instead.
   */
  byIdOnly?: true;
}

/** The model being looked up. */
export interface PinnedModelRef {
  id: string;
  providerSlug: string;
  modelId: string;
}

/** The parts of `OrchestrationSettings` that name a model. */
export interface ModelPinSettings {
  defaultModels: Record<TaskType, string>;
  defaultModelsStored: Partial<Record<TaskType, string>>;
  confidentialModel: { providerSlug: string; model: string } | null;
  activeEmbeddingModelId: string | null;
}

/** Every settings slot that names `model`, task defaults first in `TASK_TYPES` order. */
export function settingsPinsFor(model: PinnedModelRef, settings: ModelPinSettings): SettingsPin[] {
  const pins: SettingsPin[] = [];
  for (const task of TASK_TYPES) {
    const value = settings.defaultModels[task];
    const how = value ? pinNames(value, model) : null;
    if (how === null) continue;
    pins.push({
      slot: task,
      source: settings.defaultModelsStored[task] ? 'saved' : 'suggested',
      ...(task === 'embeddings' ? { movedBy: 'embedding_switch' as const } : {}),
      ...(how === 'id' ? { byIdOnly: true as const } : {}),
    });
  }
  const confidential = settings.confidentialModel;
  if (
    confidential &&
    confidential.providerSlug === model.providerSlug &&
    confidential.model === model.modelId
  ) {
    pins.push({ slot: 'confidential', source: 'saved' });
  }
  if (settings.activeEmbeddingModelId === model.id) {
    pins.push({ slot: 'active_embedding', source: 'saved', movedBy: 'embedding_switch' });
  }
  return pins;
}

function isTaskType(slot: SettingsPinSlot): slot is TaskType {
  return slot !== 'confidential' && slot !== 'active_embedding';
}

/** The task-default slots among `pins`: what the provider-models list shows as `defaultFor`. */
export function defaultSlots(pins: readonly SettingsPin[]): TaskType[] {
  return pins.map((p) => p.slot).filter(isTaskType);
}
