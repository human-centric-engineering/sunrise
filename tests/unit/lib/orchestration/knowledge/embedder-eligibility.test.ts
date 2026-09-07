/**
 * The embedder's fallback chain is filtered by the provider-eligibility seam.
 *
 * The chain is Sunrise choosing — nobody recorded a decision, we walk a
 * preference order — so it is the same category as `tryAudioRow`'s matrix
 * fallback and the workflow step with no override, and it passes the same
 * `source: 'primary'`. The operator's `activeEmbeddingModelId` pin is NOT
 * filtered, and there is a test below that holds that line.
 *
 * @see lib/orchestration/knowledge/embedder.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db/client';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: { findMany: vi.fn(), findFirst: vi.fn() },
    aiOrchestrationSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    aiProviderModel: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async () => 'text-embedding-3-small'),
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  calculateEmbeddingCost: vi.fn(() => 0),
  logCost: vi.fn(async () => undefined),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { registerProviderEligibility, resetProviderEligibility } =
  await import('@/lib/orchestration/llm/provider-eligibility');
const { embedText, canResolveEmbeddingProvider, UNCONFIGURED_OPENAI_SLUG } =
  await import('@/lib/orchestration/knowledge/embedder');

function row(overrides: Record<string, unknown>) {
  return {
    id: 'p',
    name: 'p',
    slug: 'p',
    providerType: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEnvVar: null,
    isLocal: false,
    isActive: true,
    ...overrides,
  };
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { total_tokens: 1 } }),
    text: async () => '',
  };
}

/** The URL the embedder actually posted to — the only honest witness here. */
function fetchedHost(): string {
  const [url] = mockFetch.mock.calls[0] as [string];
  return new URL(url).host;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderEligibility();
  // `clearAllMocks` resets calls, not implementations — reassert the "no pin"
  // baseline or the pin test below leaks into every test declared after it.
  vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);
  mockFetch.mockResolvedValue(okResponse());
  delete process.env['OPENAI_API_KEY'];
});

afterEach(() => {
  resetProviderEligibility();
  delete process.env['OPENAI_API_KEY'];
});

describe('the fallback chain consults the eligibility seam', () => {
  it('skips a refused arm and uses the next permitted one', async () => {
    // Arrange: both a Voyage row (first preference) and a local row.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'voyage', providerType: 'voyage', baseUrl: null }),
      row({ slug: 'ollama', isLocal: true, baseUrl: 'http://localhost:11434/v1' }),
    ] as never);
    registerProviderEligibility((candidates) => candidates.filter((c) => c !== 'voyage'));

    // Act
    await embedText('hello');

    // Assert: skipping and trying the next is the audio loop's shape — a fork
    // that permits a local embedder but not Voyage gets the local embedder,
    // not a failure.
    expect(fetchedHost()).toBe('localhost:11434');
  });

  it('passes source:primary and task:embeddings, so an existing fork rule already covers it', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'together' }),
    ] as never);
    const resolver = vi.fn((candidates: readonly string[]) => candidates);
    registerProviderEligibility(resolver);

    // Act
    await embedText('hello');

    // Assert: reusing 'primary' rather than inventing a fourth source is what
    // makes a rule written before this path existed apply to it.
    expect(resolver).toHaveBeenCalledWith(['together'], {
      task: 'embeddings',
      source: 'primary',
      primarySlug: null,
    });
  });

  it('gives the bare-OPENAI_API_KEY arm a slug a rule can deny', async () => {
    // Arrange: no provider rows at all — the unconfigured escape hatch.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    process.env['OPENAI_API_KEY'] = 'sk-test';
    registerProviderEligibility((candidates) =>
      candidates.filter((c) => c !== UNCONFIGURED_OPENAI_SLUG)
    );

    // Act + Assert: before it had a name, no rule could reach this arm at all
    // and an org's documents went to api.openai.com regardless.
    await expect(embedText('hello')).rejects.toThrow(/No permitted embedding provider/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still uses the bare arm when the rule permits it', async () => {
    // Arrange: the control for the test above — same setup, permissive rule.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    process.env['OPENAI_API_KEY'] = 'sk-test';
    registerProviderEligibility((candidates) => candidates);

    // Act
    await embedText('hello');

    // Assert: the escape hatch stays; it just stopped being anonymous.
    expect(fetchedHost()).toBe('api.openai.com');
  });

  it('leaves the operator pin unfiltered', async () => {
    // Arrange: an explicit activeEmbeddingModelId, and a rule denying its
    // provider outright.
    vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue({
      activeEmbeddingModelId: 'm1',
    } as never);
    vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue({
      providerSlug: 'together',
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
      schemaCompatible: true,
      capabilities: ['embedding'],
      isActive: true,
    } as never);
    vi.mocked(prisma.aiProviderConfig.findFirst).mockResolvedValue(
      row({ slug: 'together' }) as never
    );
    registerProviderEligibility(() => []);

    // Act
    await embedText('hello');

    // Assert: same line as an explicit `agent.provider` — silently rerouting a
    // recorded operator decision is a worse failure than the one prevented.
    expect(fetchedHost()).toBe('api.example.com');
  });
});

describe('a refusal skips the row, not the category', () => {
  it('tries the next row of the same type when the first is refused', async () => {
    // Arrange: two Voyage rows, the refused one sorting first, and NOTHING else
    // in the chain to fall through to.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'voyage-us', providerType: 'voyage', baseUrl: 'https://us.voyage.test/v1' }),
      row({ slug: 'voyage-eu', providerType: 'voyage', baseUrl: 'https://eu.voyage.test/v1' }),
    ] as never);
    registerProviderEligibility((candidates) => candidates.filter((c) => c !== 'voyage-us'));

    // Act
    await embedText('hello');

    // Assert: `providers.find(...)` sampled ONE row per category, so a refusal
    // abandoned Voyage entirely and this threw — with an approved, active
    // Voyage row sitting right there. The audio loop this is modelled on
    // iterates every matrix row; now so does this.
    expect(fetchedHost()).toBe('eu.voyage.test');
  });

  it('does not record a refusal for a row that was unusable anyway', async () => {
    // Arrange: a local row with no baseUrl (unusable on shape alone) and no
    // other provider. The rule permits everything.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'ollama', isLocal: true, baseUrl: null }),
    ] as never);
    registerProviderEligibility((candidates) => candidates);

    // Act + Assert: shape is checked before policy, so nothing was refused and
    // the operator is sent to the setup wizard rather than to the rule.
    await expect(embedText('hello')).rejects.toThrow(/No embedding provider configured/);
  });
});

describe('canResolveEmbeddingProvider', () => {
  it('reports false when rows exist but the rule refuses them all', async () => {
    // Arrange: exactly the state the old row-count check called "available".
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'together' }),
    ] as never);
    process.env['OPENAI_API_KEY'] = 'sk-test';
    registerProviderEligibility(() => []);

    // Act + Assert: the admin UI gates "Generate Embeddings" on this, so a
    // `true` here is an enabled button for a run that cannot succeed.
    await expect(canResolveEmbeddingProvider()).resolves.toBe(false);
  });

  it('reports true when a permitted arm resolves', async () => {
    // Arrange: the control.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'together' }),
    ] as never);
    registerProviderEligibility((candidates) => candidates);

    // Act + Assert
    await expect(canResolveEmbeddingProvider()).resolves.toBe(true);
  });
});

describe('the two terminal errors stay distinct', () => {
  it('reports "not configured" when nothing was refused', async () => {
    // Arrange: one Anthropic row, which no arm of the chain matches, and no
    // OPENAI_API_KEY. Nothing was denied — there was nothing to deny.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'anthropic', providerType: 'anthropic', baseUrl: null }),
    ] as never);

    // Act + Assert: this operator needs the setup wizard, not the fork's rule.
    await expect(embedText('hello')).rejects.toThrow(/No embedding provider configured/);
  });

  it('reports "not permitted" when the rule refused what was there', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'together' }),
    ] as never);
    registerProviderEligibility(() => []);

    // Act + Assert: this operator needs whoever wrote the rule. Sending both
    // to the same message would send half of them to the wrong place.
    await expect(embedText('hello')).rejects.toThrow(/No permitted embedding provider/);
  });
});
