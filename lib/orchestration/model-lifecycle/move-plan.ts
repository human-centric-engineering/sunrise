/**
 * What the model move rewrites, and what it leaves (§136 t-1066).
 *
 * The move takes every use of a model to its replacement on the same provider
 * (`move.ts`). This module decides, for one workflow definition and for the
 * install settings, which pins move and which stay, so the preview and the
 * move cannot disagree: both call it, the move on what it reads under its
 * lock.
 *
 * **Every moved pin is written as a pair**, `provider::model` (§136 t-1068):
 * the replacement's id may be one another provider also offers, so a bare id
 * written now could run elsewhere.
 *
 * **A pin naming the model by its id alone** (one saved before t-1068) moves
 * when no other active provider offers the id, since it can then only mean
 * this model. When another does, it is left (`shared_id`): it may be running
 * on that provider's model, and the move does not guess (the t-1065 ruling).
 * A `chat_turn` step's bare override is always left (`chat_turn_by_id`): it
 * runs on the step's agent's provider, which the definition does not say, and
 * a pair there would also drop the step's fallbacks (t-1068).
 *
 * **The embedding pins are never moved** (`embedding_switch`): changing the
 * embedding model means re-embedding every org's documents, which is §132's
 * job.
 *
 * Pure: no database, no Next.js imports. Safe in client components, which
 * read {@link LEFT_REASON_TEXT}.
 */

import {
  formatModelPin,
  MODEL_OVERRIDE_STEP_TYPES,
  pinNames,
} from '@/lib/orchestration/llm/model-pin';
import type {
  ModelPinSettings,
  SettingsPin,
  SettingsPinSlot,
} from '@/lib/orchestration/model-lifecycle/settings-pins';
import type { TaskType } from '@/types/orchestration';

/** Why a pin naming the model is left where it is. */
export type LeftReason = 'shared_id' | 'chat_turn_by_id' | 'embedding_switch';

/** What a person reads for each {@link LeftReason}. */
export const LEFT_REASON_TEXT: Record<LeftReason, string> = {
  shared_id:
    'It names the model by its id alone, which another provider also offers, so it may be running there. Choose the model again where it is set.',
  chat_turn_by_id:
    'A chat-turn step that names the model by its id alone runs on its agent’s provider. Choose the model again in the step.',
  embedding_switch:
    'Changing the embedding model means re-embedding every document, so it is not moved with the rest.',
};

/** The model whose uses move, and the replacement's model id on the same provider. */
export interface MovePins {
  providerSlug: string;
  modelId: string;
  replacementModelId: string;
  /** Whether another active provider offers `modelId` too. */
  idShared: boolean;
}

/** The pin a moved use is given. */
export function movedPin(pins: MovePins): string {
  return formatModelPin(pins.providerSlug, pins.replacementModelId);
}

/** One definition, rewritten. */
export interface DefinitionRepin {
  /** The rewritten definition; the same object when no step moved. */
  definition: unknown;
  /** Steps whose override now names the replacement. */
  moved: number;
  /** Steps naming the model that were left, and why. */
  left: Array<{ stepId: string; reason: LeftReason }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `definition` with every step override naming the model moved to the
 * replacement, as {@link MovePins} rules. Reads the same steps the uses finder
 * counts (`definitionPinsModel`): the LLM step types and `chat_turn`. Anything
 * that is not a definition with a `steps` array is returned as it is.
 */
export function repinDefinition(definition: unknown, pins: MovePins): DefinitionRepin {
  const unchanged: DefinitionRepin = { definition, moved: 0, left: [] };
  if (!isRecord(definition) || !Array.isArray(definition.steps)) return unchanged;
  const model = { providerSlug: pins.providerSlug, modelId: pins.modelId };
  const to = movedPin(pins);
  let moved = 0;
  const left: DefinitionRepin['left'] = [];
  const steps = definition.steps.map((step: unknown) => {
    if (!isRecord(step) || typeof step.type !== 'string' || !isRecord(step.config)) return step;
    const chatTurn = step.type === 'chat_turn';
    if (!chatTurn && !MODEL_OVERRIDE_STEP_TYPES.has(step.type)) return step;
    const override = step.config.modelOverride;
    if (typeof override !== 'string') return step;
    const how = pinNames(override, model);
    if (how === null) return step;
    const stepId = typeof step.id === 'string' ? step.id : '';
    if (how === 'id' && chatTurn) {
      left.push({ stepId, reason: 'chat_turn_by_id' });
      return step;
    }
    if (how === 'id' && pins.idShared) {
      left.push({ stepId, reason: 'shared_id' });
      return step;
    }
    moved++;
    return { ...step, config: { ...step.config, modelOverride: to } };
  });
  if (moved === 0) return { ...unchanged, left };
  return { definition: { ...definition, steps }, moved, left };
}

/** One settings slot the move changes. */
export interface SettingsSlotMove {
  slot: SettingsPinSlot;
  from: string;
  to: string;
  /** `suggested`: the system's pick for a slot nobody saved; the move saves it. */
  source: 'saved' | 'suggested';
}

/** What the move does to the install settings. */
export interface SettingsMovePlan {
  moved: SettingsSlotMove[];
  left: Array<{ slot: SettingsPinSlot; reason: LeftReason }>;
}

/**
 * The settings slots naming the model (`pins`, from `settingsPinsFor`) the
 * move changes, and those it leaves. A suggested task default is saved as the
 * replacement: an agent with no model of its own inherits it, and otherwise
 * it would stay on the retiring model until the system's pick changed.
 */
export function planSettingsMove(
  pins: readonly SettingsPin[],
  settings: Pick<ModelPinSettings, 'defaultModels'>,
  move: MovePins
): SettingsMovePlan {
  const plan: SettingsMovePlan = { moved: [], left: [] };
  for (const pin of pins) {
    if (pin.movedBy === 'embedding_switch' || pin.slot === 'active_embedding') {
      plan.left.push({ slot: pin.slot, reason: 'embedding_switch' });
      continue;
    }
    if (pin.byIdOnly && move.idShared) {
      plan.left.push({ slot: pin.slot, reason: 'shared_id' });
      continue;
    }
    if (pin.slot === 'confidential') {
      // Stored as provider and model apart; only the model changes.
      plan.moved.push({
        slot: 'confidential',
        from: move.modelId,
        to: move.replacementModelId,
        source: 'saved',
      });
      continue;
    }
    const task: TaskType = pin.slot;
    plan.moved.push({
      slot: task,
      from: settings.defaultModels[task],
      to: movedPin(move),
      source: pin.source,
    });
  }
  return plan;
}
