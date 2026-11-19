/**
 * The install settings that name a model (§136 t-1065).
 *
 * @see lib/orchestration/model-lifecycle/settings-pins.ts
 */

import { describe, expect, it } from 'vitest';

import {
  defaultSlots,
  settingsPinsFor,
  type ModelPinSettings,
} from '@/lib/orchestration/model-lifecycle/settings-pins';

const MODEL = { id: 'm1', providerSlug: 'openai', modelId: 'gpt-4o' };

function settings(overrides: Partial<ModelPinSettings> = {}): ModelPinSettings {
  return {
    defaultModels: {
      routing: 'gpt-4o-mini',
      chat: 'claude-sonnet',
      reasoning: 'o3',
      embeddings: 'text-embedding-3-small',
      audio: 'openai::whisper-1',
    },
    defaultModelsStored: {},
    confidentialModel: null,
    activeEmbeddingModelId: null,
    ...overrides,
  };
}

describe('settingsPinsFor', () => {
  it('finds nothing for a model no setting names (the population is not empty)', () => {
    // Every slot is set, to other models.
    expect(settingsPinsFor(MODEL, settings())).toEqual([]);
  });

  it('marks a task default saved or suggested by whether an admin saved it', () => {
    const pins = settingsPinsFor(
      MODEL,
      settings({
        defaultModels: { ...settings().defaultModels, chat: 'gpt-4o', reasoning: 'gpt-4o' },
        defaultModelsStored: { chat: 'gpt-4o' },
      })
    );
    expect(pins).toEqual([
      { slot: 'chat', source: 'saved' },
      { slot: 'reasoning', source: 'suggested' },
    ]);
  });

  it('matches audio on provider and model, and a legacy bare id on the id alone', () => {
    const on = (audio: string) =>
      settingsPinsFor(
        { id: 'w', providerSlug: 'openai', modelId: 'whisper-1' },
        settings({ defaultModels: { ...settings().defaultModels, audio } })
      );
    expect(on('openai::whisper-1')).toEqual([{ slot: 'audio', source: 'suggested' }]);
    expect(on('groq::whisper-1')).toEqual([]);
    expect(on('whisper-1')).toEqual([{ slot: 'audio', source: 'suggested' }]);
  });

  it('matches the confidential model on provider and model both', () => {
    expect(
      settingsPinsFor(
        MODEL,
        settings({ confidentialModel: { providerSlug: 'openai', model: 'gpt-4o' } })
      )
    ).toEqual([{ slot: 'confidential', source: 'saved' }]);
    expect(
      settingsPinsFor(
        MODEL,
        settings({ confidentialModel: { providerSlug: 'azure', model: 'gpt-4o' } })
      )
    ).toEqual([]);
  });

  it('marks both embedding pins as moved by the embedding switch, not by this feature', () => {
    const model = { id: 'e1', providerSlug: 'openai', modelId: 'text-embedding-3-small' };
    expect(settingsPinsFor(model, settings({ activeEmbeddingModelId: 'e1' }))).toEqual([
      { slot: 'embeddings', source: 'suggested', movedBy: 'embedding_switch' },
      { slot: 'active_embedding', source: 'saved', movedBy: 'embedding_switch' },
    ]);
  });
});

describe('defaultSlots', () => {
  it('keeps only the task-default slots, in order', () => {
    expect(
      defaultSlots([
        { slot: 'chat', source: 'saved' },
        { slot: 'confidential', source: 'saved' },
        { slot: 'audio', source: 'suggested' },
        { slot: 'active_embedding', source: 'saved', movedBy: 'embedding_switch' },
      ])
    ).toEqual(['chat', 'audio']);
  });
});
