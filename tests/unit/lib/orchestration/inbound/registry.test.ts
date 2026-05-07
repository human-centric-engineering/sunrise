/**
 * Tests: Inbound adapter registry.
 *
 * The registry is a module-level singleton (a Map). Each test resets it with
 * `resetInboundAdapters()` in `beforeEach` to guarantee isolation.
 *
 * @see lib/orchestration/inbound/registry.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger before importing the registry so the spy is in place at module load.
vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '@/lib/logging';
import {
  getInboundAdapter,
  registerInboundAdapter,
  listInboundChannels,
  resetInboundAdapters,
} from '@/lib/orchestration/inbound/registry';
import type { InboundAdapter, NormalisedTriggerPayload } from '@/lib/orchestration/inbound/types';

// ---------------------------------------------------------------------------
// Minimal stub adapter factory
// ---------------------------------------------------------------------------

function makeAdapter(channel: string): InboundAdapter {
  return {
    channel,
    verify: vi.fn().mockResolvedValue({ valid: true }),
    normalise: vi.fn().mockReturnValue({
      channel,
      payload: {},
    } satisfies NormalisedTriggerPayload),
  };
}

// ---------------------------------------------------------------------------
// Reset registry + clear mock call history before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetInboundAdapters();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getInboundAdapter — before any registration
// ---------------------------------------------------------------------------

describe('getInboundAdapter', () => {
  it('returns null for an unknown channel before any registration', () => {
    // Arrange: registry is empty (reset in beforeEach)

    // Act
    const result = getInboundAdapter('slack');

    // Assert
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerInboundAdapter — store and retrieve
// ---------------------------------------------------------------------------

describe('registerInboundAdapter', () => {
  it('stores an adapter and makes it retrievable via getInboundAdapter', () => {
    // Arrange
    const adapter = makeAdapter('slack');

    // Act
    registerInboundAdapter(adapter);

    // Assert — returned adapter is the exact same object we registered
    const retrieved = getInboundAdapter('slack');
    expect(retrieved).toBe(adapter);
  });

  it('replaces an existing registration; the new adapter wins on subsequent get', () => {
    // Arrange
    const adapterA = makeAdapter('hmac');
    const adapterB = makeAdapter('hmac');

    // Act
    registerInboundAdapter(adapterA);
    registerInboundAdapter(adapterB);

    // Assert — second registration overwrites the first
    const retrieved = getInboundAdapter('hmac');
    expect(retrieved).toBe(adapterB);
    expect(retrieved).not.toBe(adapterA);
  });

  it('calls logger.warn exactly once when replacing an existing channel', () => {
    // Arrange
    const adapterA = makeAdapter('postmark');
    const adapterB = makeAdapter('postmark');

    // Act — register A (no prior entry → no warn); register B (prior entry → warn)
    registerInboundAdapter(adapterA);
    registerInboundAdapter(adapterB);

    // Assert — warn fired exactly once (for the second registration, not the first)
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      'Inbound adapter already registered; replacing',
      { channel: 'postmark' }
    );
  });

  it('does NOT call logger.warn when registering a channel for the first time', () => {
    // Arrange
    const adapter = makeAdapter('slack');

    // Act
    registerInboundAdapter(adapter);

    // Assert — no warn on first registration
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listInboundChannels
// ---------------------------------------------------------------------------

describe('listInboundChannels', () => {
  it('returns an empty array when no adapters are registered', () => {
    // Arrange: registry is empty (reset in beforeEach)

    // Act
    const channels = listInboundChannels();

    // Assert
    expect(channels).toEqual([]);
  });

  it('returns sorted channel slugs when multiple adapters are registered', () => {
    // Arrange — register in non-alphabetical order
    registerInboundAdapter(makeAdapter('c'));
    registerInboundAdapter(makeAdapter('a'));
    registerInboundAdapter(makeAdapter('b'));

    // Act
    const channels = listInboundChannels();

    // Assert — sorted ascending regardless of insertion order
    expect(channels).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// resetInboundAdapters
// ---------------------------------------------------------------------------

describe('resetInboundAdapters', () => {
  it('clears the registry so getInboundAdapter returns null after reset', () => {
    // Arrange — register an adapter, confirm it's there
    registerInboundAdapter(makeAdapter('slack'));
    expect(getInboundAdapter('slack')).not.toBeNull();

    // Act
    resetInboundAdapters();

    // Assert — adapter is gone after reset
    expect(getInboundAdapter('slack')).toBeNull();
  });
});
