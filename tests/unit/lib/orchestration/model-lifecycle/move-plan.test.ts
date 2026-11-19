/**
 * What the model move rewrites, and what it leaves (§136 t-1066).
 *
 * @see lib/orchestration/model-lifecycle/move-plan.ts
 */

import { describe, expect, it } from 'vitest';

import {
  movedPin,
  planSettingsMove,
  repinDefinition,
  type MovePins,
} from '@/lib/orchestration/model-lifecycle/move-plan';
import {
  settingsPinsFor,
  type ModelPinSettings,
} from '@/lib/orchestration/model-lifecycle/settings-pins';

const PINS: MovePins = {
  providerSlug: 'openai',
  modelId: 'gpt-4o',
  replacementModelId: 'gpt-4.1',
  idShared: false,
};
const SHARED: MovePins = { ...PINS, idShared: true };

function step(id: string, type: string, modelOverride?: unknown) {
  return {
    id,
    name: id,
    type,
    config: modelOverride === undefined ? { prompt: 'x' } : { prompt: 'x', modelOverride },
    nextSteps: [],
  };
}

function definition(...steps: unknown[]) {
  return { entryStepId: 'a', errorStrategy: 'fail', steps };
}

function overrides(def: unknown): unknown[] {
  const { steps } = def as { steps: Array<{ config: { modelOverride?: unknown } }> };
  return steps.map((s) => s.config.modelOverride);
}

describe('repinDefinition', () => {
  it('writes every moved step as a pair on the same provider', () => {
    expect(movedPin(PINS)).toBe('openai::gpt-4.1');
    const def = definition(
      step('a', 'llm_call', 'openai::gpt-4o'),
      step('b', 'supervisor', 'openai::gpt-4o'),
      step('c', 'chat_turn', 'openai::gpt-4o')
    );
    const out = repinDefinition(def, PINS);
    expect(out.moved).toBe(3);
    expect(out.left).toEqual([]);
    expect(overrides(out.definition)).toEqual([
      'openai::gpt-4.1',
      'openai::gpt-4.1',
      'openai::gpt-4.1',
    ]);
  });

  it('moves a bare id, as a pair, when no other provider offers the id', () => {
    const out = repinDefinition(definition(step('a', 'evaluate', 'gpt-4o')), PINS);
    expect(out.moved).toBe(1);
    expect(overrides(out.definition)).toEqual(['openai::gpt-4.1']);
  });

  it('leaves a bare id another provider also offers, and says why', () => {
    const def = definition(step('a', 'guard', 'gpt-4o'), step('b', 'plan', 'openai::gpt-4o'));
    const out = repinDefinition(def, SHARED);
    expect(out.moved).toBe(1);
    expect(out.left).toEqual([{ stepId: 'a', reason: 'shared_id' }]);
    expect(overrides(out.definition)).toEqual(['gpt-4o', 'openai::gpt-4.1']);
  });

  it('leaves a chat_turn bare id even when the id is the model’s alone', () => {
    const out = repinDefinition(definition(step('a', 'chat_turn', 'gpt-4o')), PINS);
    expect(out).toEqual({
      definition: definition(step('a', 'chat_turn', 'gpt-4o')),
      moved: 0,
      left: [{ stepId: 'a', reason: 'chat_turn_by_id' }],
    });
  });

  it('touches no step naming another model, another provider, or no override', () => {
    const def = definition(
      step('a', 'llm_call', 'microsoft::gpt-4o'),
      step('b', 'llm_call', 'openai::gpt-4o-mini'),
      step('c', 'llm_call'),
      step('d', 'tool_call', 'openai::gpt-4o'),
      step('e', 'llm_call', 42)
    );
    const out = repinDefinition(def, PINS);
    expect(out.moved).toBe(0);
    expect(out.left).toEqual([]);
    // The same object: nothing to write.
    expect(out.definition).toBe(def);
  });

  it('keeps the rest of a moved step and of the definition as they were', () => {
    const def = definition(step('a', 'llm_call', 'openai::gpt-4o'), step('b', 'llm_call'));
    const out = repinDefinition(def, PINS);
    expect(out.definition).toEqual(
      definition(step('a', 'llm_call', 'openai::gpt-4.1'), step('b', 'llm_call'))
    );
    // The input is not mutated.
    expect(overrides(def)).toEqual(['openai::gpt-4o', undefined]);
  });

  it('returns anything that is not a definition as it is', () => {
    for (const value of [null, 'x', { steps: 'no' }, []]) {
      expect(repinDefinition(value, PINS)).toEqual({ definition: value, moved: 0, left: [] });
    }
  });
});

const MODEL = { id: 'row-1', providerSlug: 'openai', modelId: 'gpt-4o' };

function settings(overrides: Partial<ModelPinSettings> = {}): ModelPinSettings {
  return {
    defaultModels: {
      routing: 'openai::gpt-4o',
      chat: 'gpt-4o',
      reasoning: 'anthropic::claude-opus',
      embeddings: 'gpt-4o',
      audio: 'openai::whisper-1',
    },
    defaultModelsStored: { routing: 'openai::gpt-4o', embeddings: 'gpt-4o' },
    confidentialModel: { providerSlug: 'openai', model: 'gpt-4o' },
    activeEmbeddingModelId: 'row-1',
    ...overrides,
  };
}

describe('planSettingsMove', () => {
  it('moves the task defaults and the confidential model, and leaves the embedding pins', () => {
    const s = settings();
    const plan = planSettingsMove(settingsPinsFor(MODEL, s), s, PINS);
    expect(plan.moved).toEqual([
      { slot: 'routing', from: 'openai::gpt-4o', to: 'openai::gpt-4.1', source: 'saved' },
      // The system's suggestion, saved as the replacement.
      { slot: 'chat', from: 'gpt-4o', to: 'openai::gpt-4.1', source: 'suggested' },
      // Stored as provider and model apart: only the model id.
      { slot: 'confidential', from: 'gpt-4o', to: 'gpt-4.1', source: 'saved' },
    ]);
    expect(plan.left).toEqual([
      { slot: 'embeddings', reason: 'embedding_switch' },
      { slot: 'active_embedding', reason: 'embedding_switch' },
    ]);
  });

  it('leaves a by-id default when another provider offers the id', () => {
    const s = settings();
    const plan = planSettingsMove(settingsPinsFor(MODEL, s), s, SHARED);
    expect(plan.moved.map((m) => m.slot)).toEqual(['routing', 'confidential']);
    expect(plan.left).toEqual([
      { slot: 'chat', reason: 'shared_id' },
      { slot: 'embeddings', reason: 'embedding_switch' },
      { slot: 'active_embedding', reason: 'embedding_switch' },
    ]);
  });

  it('plans nothing when no setting names the model', () => {
    const s = settings({
      defaultModels: {
        routing: 'x',
        chat: 'y',
        reasoning: 'z',
        embeddings: 'e',
        audio: 'a',
      },
      confidentialModel: null,
      activeEmbeddingModelId: null,
    });
    expect(planSettingsMove(settingsPinsFor(MODEL, s), s, PINS)).toEqual({ moved: [], left: [] });
  });
});
