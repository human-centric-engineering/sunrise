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
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import type { EmbedManyOptions, EmbedManyResult } from '@/lib/orchestration/llm/types';

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

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  getProvider: vi.fn(),
  isApiKeyEnvVarSet: vi.fn(),
}));

const { registerProviderEligibility, resetProviderEligibility } =
  await import('@/lib/orchestration/llm/provider-eligibility');
const { logger } = await import('@/lib/logging');
const { getProvider, isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
const { NoProviderConfiguredError } = await import('@/lib/orchestration/llm/agent-resolver');
const { embedText, resolveEmbeddingAvailability } =
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

type EmbedManyFn = (texts: string[], options: EmbedManyOptions) => Promise<EmbedManyResult>;

/** Point `getProvider` at a fake whose `embedMany` is the returned mock. */
function installEmbedMany() {
  const impl: EmbedManyFn = async (texts) => ({
    embeddings: texts.map(() => [0.1]),
    inputTokens: 1,
  });
  const embedMany = vi.fn(impl);
  vi.mocked(getProvider).mockResolvedValue({
    name: 'fake',
    isLocal: false,
    embedMany,
  } as unknown as LlmProvider);
  return embedMany;
}

/** The slug the embedder asked the provider manager for — the only honest witness here. */
function fetchedSlug(): string {
  expect(getProvider).toHaveBeenCalledTimes(1);
  return vi.mocked(getProvider).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderEligibility();
  // `clearAllMocks` resets calls, not implementations — reassert the "no pin"
  // baseline or the pin test below leaks into every test declared after it.
  vi.mocked(prisma.aiOrchestrationSettings.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.aiProviderModel.findUnique).mockResolvedValue(null);
  installEmbedMany();
  vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);
});

afterEach(() => {
  resetProviderEligibility();
});

describe('the fallback chain consults the eligibility seam', () => {
  it('skips a refused arm and uses the next permitted one', async () => {
    // Arrange: both a Voyage row (first preference) and a local row.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'voyage', providerType: 'voyage', baseUrl: null }),
      row({ slug: 'ollama', isLocal: true, baseUrl: 'http://localhost:11434/v1' }),
    ] as never);
    registerProviderEligibility((candidates) => candidates.filter((c) => c !== 'voyage'));
    const embedMany = installEmbedMany();

    // Act
    await embedText('hello');

    // Assert: skipping and trying the next is the audio loop's shape — a fork
    // that permits a local embedder but not Voyage gets the local embedder,
    // not a failure.
    expect(fetchedSlug()).toBe('ollama');
    expect(embedMany).toHaveBeenCalledWith(['hello'], { model: 'nomic-embed-text' });
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

  it('has no bare-OPENAI_API_KEY arm for a rule to reach: a key with no rows fails, and the rule is never consulted', async () => {
    // Arrange: no provider rows, the key is set, and a permissive rule. The
    // bare arm used to have a slug (`env:openai`) so a rule could deny it; it
    // is gone (t-740), so there is nothing to deny.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
    const resolver = vi.fn((candidates: readonly string[]) => candidates);
    registerProviderEligibility(resolver);

    // Act
    const err = await embedText('hello').catch((e: unknown) => e);

    // Assert: the terminal error is the not-configured one (NOT "not permitted"),
    // it names the retired behaviour, and no vendor or rule was touched.
    expect(err).toBeInstanceOf(NoProviderConfiguredError);
    expect((err as Error).message).toMatch(/key alone no longer enables embeddings/);
    expect(resolver).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
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
    const embedMany = installEmbedMany();

    // Act
    await embedText('hello');

    // Assert: same line as an explicit `agent.provider` — silently rerouting a
    // recorded operator decision is a worse failure than the one prevented.
    expect(fetchedSlug()).toBe('together');
    expect(embedMany).toHaveBeenCalledWith(['hello'], {
      model: 'text-embedding-3-small',
      dimensions: 1536,
    });
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
    const embedMany = installEmbedMany();

    // Act
    await embedText('hello');

    // Assert: `providers.find(...)` sampled ONE row per category, so a refusal
    // abandoned Voyage entirely and this threw — with an approved, active
    // Voyage row sitting right there. The audio loop this is modelled on
    // iterates every matrix row; now so does this.
    expect(fetchedSlug()).toBe('voyage-eu');
    expect(embedMany).toHaveBeenCalledWith(['hello'], { model: 'voyage-3', dimensions: 1536 });
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

describe('resolveEmbeddingAvailability', () => {
  it('reports false when rows exist but the rule refuses them all', async () => {
    // Arrange: exactly the state the old row-count check called "available".
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'together' }),
    ] as never);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
    registerProviderEligibility(() => []);

    // Act + Assert: the admin UI gates "Generate Embeddings" on this, so a
    // `true` here is an enabled button for a run that cannot succeed.
    await expect(resolveEmbeddingAvailability()).resolves.toBe('none_permitted');
  });

  it('reports true when a permitted arm resolves', async () => {
    // Arrange: the control.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'together' }),
    ] as never);
    registerProviderEligibility((candidates) => candidates);

    // Act + Assert
    await expect(resolveEmbeddingAvailability()).resolves.toBe('ok');
  });

  it('reports none_configured when only the OPENAI_API_KEY is set and there are no rows', async () => {
    // Arrange: the state the retired bare-key arm used to turn into 'ok'.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([] as never);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);

    // Act + Assert: the operator needs to add a provider row, not to ask about a rule.
    await expect(resolveEmbeddingAvailability()).resolves.toBe('none_configured');
    expect(getProvider).not.toHaveBeenCalled();
  });
});

describe('resolveEmbeddingAvailability distinguishes a verdict from a failure', () => {
  it('reports "unknown" for a database error, not a verdict', async () => {
    // Arrange: the chain's own uncaught query fails, as it would under
    // connection-pool pressure.
    vi.mocked(prisma.aiProviderConfig.findMany).mockRejectedValue(
      new Error('Timed out fetching a new connection from the connection pool')
    );

    // Act + Assert: "I cannot answer" is not the answer "no". Swallowing this
    // tells an operator they have no embedding provider configured and sends
    // them to reconfigure providers that were fine all along.
    await expect(resolveEmbeddingAvailability()).resolves.toBe('unknown');
  });
});

describe('the eligibility rule is asked once per slug', () => {
  it('does not re-evaluate a row that matches two arms', async () => {
    // Arrange: an Ollama row is `isLocal` AND `openai-compatible` — the common
    // local setup, so it matches the local arm and the openai-compatible arm.
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'ollama', isLocal: true, baseUrl: 'http://localhost:11434/v1' }),
    ] as never);
    const resolver = vi.fn(() => [] as string[]);
    registerProviderEligibility(resolver);

    // Act
    await expect(embedText('hello')).rejects.toThrow(/No permitted embedding provider/);

    // Assert: one evaluation, not two. This runs per knowledge-search query and
    // a fork's rule may do a policy lookup, so the duplicate was a real cost.
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

describe('the winning arm is per-call provenance, not the drop-through signal', () => {
  it('logs at debug, leaving the production-visible signal to the drop-through warns', async () => {
    // Arrange
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
      row({ slug: 'together' }),
    ] as never);

    // Act
    await embedText('hello');

    // Assert: this fires once per knowledge-search query and once per chat
    // message on any install without an `activeEmbeddingModelId` pin — the
    // out-of-the-box state. It is per-call provenance, so `debug`. The pin
    // drop-through it was once justified by is ALREADY logged at `warn`, five
    // times over, inside `resolveActiveEmbeddingConfig` — production-visible
    // without putting an info line on the hot path.
    expect(logger.debug).toHaveBeenCalledWith('Embedding provider resolved by the fallback chain', {
      arm: 'openai-compatible',
      providerSlug: 'together',
    });
    expect(logger.info).not.toHaveBeenCalledWith(
      'Embedding provider resolved by the fallback chain',
      expect.anything()
    );
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
