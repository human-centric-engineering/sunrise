import { describe, it, expect } from 'vitest';

import {
  MODEL_CAPABILITIES,
  STORAGE_ONLY_CAPABILITIES,
  type ModelCapability,
} from '@/types/orchestration';

describe('MODEL_CAPABILITIES', () => {
  it('includes vision (image input on chat models)', () => {
    expect((MODEL_CAPABILITIES as readonly string[]).includes('vision')).toBe(true);
  });

  it('includes documents (PDF input on chat models)', () => {
    expect((MODEL_CAPABILITIES as readonly string[]).includes('documents')).toBe(true);
  });

  it('preserves the original engine and storage-only capabilities', () => {
    for (const cap of ['chat', 'reasoning', 'embedding', 'audio', 'image', 'moderation']) {
      expect((MODEL_CAPABILITIES as readonly string[]).includes(cap)).toBe(true);
    }
  });

  it('does not duplicate any capability string', () => {
    const set = new Set(MODEL_CAPABILITIES);
    expect(set.size).toBe(MODEL_CAPABILITIES.length);
  });
});

describe('STORAGE_ONLY_CAPABILITIES', () => {
  it('does not include vision (vision is engine-invoked)', () => {
    expect((STORAGE_ONLY_CAPABILITIES as readonly ModelCapability[]).includes('vision')).toBe(
      false
    );
  });

  it('does not include documents (documents are engine-invoked)', () => {
    expect((STORAGE_ONLY_CAPABILITIES as readonly ModelCapability[]).includes('documents')).toBe(
      false
    );
  });

  it('still treats `image` (generation) as storage-only', () => {
    expect((STORAGE_ONLY_CAPABILITIES as readonly ModelCapability[]).includes('image')).toBe(true);
  });
});
