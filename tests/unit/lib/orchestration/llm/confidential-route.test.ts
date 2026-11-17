/**
 * Tests: routing a turn that holds confidential content to the model for
 * confidential messages (§130 t-1038) — when a turn moves, stays or cannot
 * move; the fallbacks a flagged turn keeps; stickiness; and the check that a
 * model can be the one.
 *
 * The registry, core's phrase classifier, the policy resolution and the
 * per-group rule are real (the stage's own), so a turn is routed by what it
 * says and by the same rule the backstop refuses with. Settings, the agent's
 * stored policy, the provider lookups and the database are stubbed.
 *
 * @see lib/orchestration/llm/confidential-route.ts
 * @see lib/orchestration/llm/privacy-stage.ts — confidentialRouting
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({
  read: vi.fn<() => Promise<Record<string, unknown>>>(),
}));
const db = vi.hoisted(() => ({
  agent: vi.fn<() => Promise<Record<string, unknown> | null>>(),
  conversation: vi.fn<() => Promise<{ metadata: unknown } | null>>(),
  updateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(),
  model: vi.fn<() => Promise<Record<string, unknown> | null>>(),
  provider: vi.fn<() => Promise<Record<string, unknown> | null>>(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn(() => db.agent()) },
    org: { findUnique: vi.fn(async () => null) },
    aiConversation: {
      findFirst: vi.fn(() => db.conversation()),
      updateMany: vi.fn((args: unknown) => db.updateMany(args)),
    },
    aiProviderModel: { findUnique: vi.fn(() => db.model()) },
    aiProviderConfig: { findUnique: vi.fn(() => db.provider()) },
  },
}));
vi.mock('@/lib/app/privacy-adapters', () => ({ initAppPrivacyAdapters: () => undefined }));
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: () => settings.read(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// `ollama` is local, `trusted` is ticked trusted, everything else is neither.
vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isLocalProvider: vi.fn(async (slug: string) => slug === 'ollama'),
  isTrustedProvider: vi.fn(async (slug: string) => slug === 'trusted'),
}));

import { Prisma } from '@prisma/client';
import { logger } from '@/lib/logging';
import type { ResolvedAgentBinding } from '@/lib/orchestration/llm/agent-resolver';
import {
  confidentialModelProblem,
  keepFlaggedGroups,
  readFlaggedGroups,
  routeConfidentialTurn,
  routingParts,
} from '@/lib/orchestration/llm/confidential-route';
import { applyPrivacyStage, PrivacyRefusedError } from '@/lib/orchestration/llm/privacy-stage';
import { isTrustedProvider } from '@/lib/orchestration/llm/provider-manager';
import { createPrivacyScope, runInPrivacyScope } from '@/lib/orchestration/privacy/scope';
import {
  __resetPrivacyAdaptersForTests,
  registerSensitivityClassifier,
} from '@/lib/privacy/adapters/registry';
import type { ConfidentialPolicy, SensitivityClassifier } from '@/lib/privacy/adapters/types';

const HEALTH = "I've been signed off with depression, how do I tell my manager?";
const LAUNCH = "Write teaser copy for the S27, it's unannounced until March.";
const PLAIN = 'What time is the standup tomorrow?';

const LOCAL_MODEL = { providerSlug: 'ollama', model: 'llama3.1:8b' };
const TRUSTED_MODEL = { providerSlug: 'trusted', model: 'claude-x' };

function setUp(
  personal: ConfidentialPolicy,
  commercial: ConfidentialPolicy,
  confidentialModel: { providerSlug: string; model: string } | null = LOCAL_MODEL
) {
  settings.read.mockResolvedValue({
    privacyMode: 'detect',
    privacyIgnoredEntityTypes: ['DATE', 'LOCATION'],
    privacyProtectLocalProviders: false,
    privacyEmbeddingsPolicy: 'allow',
    privacyConfidentialPersonal: personal,
    privacyConfidentialCommercial: commercial,
    confidentialModel,
  });
}

function binding(providerSlug = 'cloud', fallbacks: string[] = []): ResolvedAgentBinding {
  return {
    providerSlug,
    model: 'gpt-x',
    fallbacks,
    provenance: { task: 'chat', primary: 'primary', fallbacks: 'system' },
  };
}

/** A turn: the system prompt and the user's messages, in the agent's privacy scope. */
function route(
  users: string[],
  b: ResolvedAgentBinding = binding(),
  sticky: ('personal' | 'commercial')[] = []
) {
  const scope = createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'agent-1' });
  return runInPrivacyScope(scope, () =>
    routeConfidentialTurn({
      binding: b,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        ...users.map((content) => ({ role: 'user', content })),
      ],
      sticky,
    })
  );
}

/** An app classifier that fails on every call. */
function failingClassifier(): SensitivityClassifier {
  return {
    id: 'acme.failing',
    egress: 'in_process',
    categories: { acme_secret: 'commercial' },
    classify: () => Promise.reject(new Error('classifier down')),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrivacyAdaptersForTests();
  db.agent.mockResolvedValue(null);
  db.conversation.mockResolvedValue(null);
  db.updateMany.mockResolvedValue({ count: 1 });
  setUp('allow', 'allow');
});

describe('routeConfidentialTurn', () => {
  it('moves a flagged turn the policy refuses at its provider to a local model, with no fallbacks', async () => {
    setUp('local_only', 'allow');
    const result = await route([HEALTH], binding('cloud', ['cloud-b']));

    expect(result).toEqual({
      kind: 'move',
      binding: {
        providerSlug: 'ollama',
        model: 'llama3.1:8b',
        fallbacks: [],
        provenance: { task: 'chat', primary: 'explicit', fallbacks: 'explicit' },
      },
      to: 'local',
      found: ['personal'],
    });
  });

  it('agrees with the backstop: the stage refuses the turn where it was, and sends it where it moved', async () => {
    setUp('local_only', 'allow');
    const messages = [{ role: 'user' as const, content: HEALTH }];
    const result = await route([HEALTH]);
    expect(result.kind).toBe('move');

    const scope = createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'agent-1' });
    const call = (slug: string, isLocal: boolean) =>
      runInPrivacyScope(scope, () =>
        applyPrivacyStage({
          providerSlug: slug,
          isLocal,
          isTrusted: () => isTrustedProvider(slug),
          coverage: 'full',
          args: [messages, { model: 'm' }],
        })
      );
    await expect(call('cloud', false)).rejects.toBeInstanceOf(PrivacyRefusedError);
    await expect(call(result.binding.providerSlug, true)).resolves.toBeDefined();
  });

  it('moves a commercial turn under approved_only to a trusted model, said as trusted', async () => {
    setUp('allow', 'approved_only', TRUSTED_MODEL);
    const result = await route([LAUNCH]);

    expect(result.kind).toBe('move');
    expect(result.binding.providerSlug).toBe('trusted');
    expect(result).toMatchObject({ to: 'trusted', found: ['commercial'] });
  });

  it('cannot move a turn when no model is set: the binding is kept, and the operator is told', async () => {
    setUp('local_only', 'allow', null);
    const b = binding('cloud', ['ollama']);
    const result = await route([HEALTH], b);

    expect(result).toEqual({ kind: 'unavailable', binding: b, found: ['personal'] });
    expect(logger.warn).toHaveBeenCalledWith(
      'privacy: a turn needed the model for confidential messages and none is usable',
      { provider: 'cloud', confidentialModelSet: false }
    );
  });

  it('cannot move a turn to a model the policy refuses too: a trusted one under local_only', async () => {
    setUp('local_only', 'allow', TRUSTED_MODEL);
    const result = await route([HEALTH]);

    expect(result.kind).toBe('unavailable');
    expect(result.binding.providerSlug).toBe('cloud');
  });

  it('keeps a turn under block where it is: no provider is permitted, so the stage refuses it', async () => {
    setUp('block', 'allow');
    const result = await route([HEALTH]);

    expect(result).toMatchObject({ kind: 'stay', found: ['personal'] });
    expect(result.binding.providerSlug).toBe('cloud');
  });

  it('keeps a turn its provider is permitted, taking out the fallbacks the policy refuses', async () => {
    setUp('approved_only', 'allow');
    const result = await route([HEALTH], binding('trusted', ['cloud-b', 'ollama']));

    expect(result.kind).toBe('stay');
    expect(result.binding).toMatchObject({ providerSlug: 'trusted', fallbacks: ['ollama'] });
  });

  it('keeps every fallback, and classifies nothing, when no policy could refuse one', async () => {
    const classify = vi.fn(async () => []);
    registerSensitivityClassifier({
      id: 'acme.spy',
      egress: 'in_process',
      categories: { acme_secret: 'commercial' },
      classify,
    });
    setUp('warn', 'allow');
    const b = binding('cloud', ['cloud-b']);
    const result = await route([HEALTH], b);

    expect(result).toEqual({ kind: 'stay', binding: b, found: [] });
    expect(classify).not.toHaveBeenCalled();
  });

  it('classifies nothing for an agent on a local provider: only block refuses there', async () => {
    const classify = vi.fn(async () => []);
    registerSensitivityClassifier({
      id: 'acme.spy',
      egress: 'in_process',
      categories: { acme_secret: 'commercial' },
      classify,
    });
    setUp('local_only', 'local_only');
    const result = await route([HEALTH], binding('ollama'));

    expect(result.kind).toBe('stay');
    expect(classify).not.toHaveBeenCalled();
  });

  it('leaves a turn with nothing confidential where it is', async () => {
    setUp('local_only', 'local_only');
    const result = await route([PLAIN]);

    expect(result).toMatchObject({ kind: 'stay', found: [] });
    expect(result.binding.providerSlug).toBe('cloud');
  });

  it('moves a turn whose conversation was flagged before, though this turn says nothing confidential', async () => {
    setUp('local_only', 'allow');
    const result = await route([PLAIN], binding(), ['personal']);

    expect(result.kind).toBe('move');
    // Found is what THIS turn's classification found: nothing new to keep.
    expect(result.found).toEqual([]);
  });

  it('counts a classifier that failed as flagged under a strict policy, and moves the turn', async () => {
    registerSensitivityClassifier(failingClassifier());
    setUp('allow', 'local_only');
    const result = await route([PLAIN]);

    expect(result.kind).toBe('move');
  });

  it('does not count a classifier that failed under warn', async () => {
    registerSensitivityClassifier(failingClassifier());
    setUp('local_only', 'warn');
    // The policy that could refuse is personal's; the failure flags only
    // groups whose policy can refuse, and nothing was found.
    const resultStrict = await route([PLAIN]);
    expect(resultStrict.kind).toBe('move');

    setUp('warn', 'warn');
    const resultWarn = await route([PLAIN]);
    expect(resultWarn.kind).toBe('stay');
  });

  it("applies the agent's own stricter policy, read in its scope", async () => {
    setUp('allow', 'allow');
    db.agent.mockResolvedValue({
      privacyMode: null,
      privacyConfidentialPersonal: 'local_only',
      privacyConfidentialCommercial: null,
    });
    const result = await route([HEALTH]);

    expect(result.kind).toBe('move');
  });

  it('keeps the binding when routing itself fails, and logs it', async () => {
    settings.read.mockRejectedValue(new Error('db down'));
    const b = binding();
    const result = await route([HEALTH], b);

    expect(result).toEqual({ kind: 'stay', binding: b, found: [] });
    expect(logger.error).toHaveBeenCalledWith(
      'privacy: routing a turn for confidential content failed',
      expect.any(Error),
      { provider: 'cloud' }
    );
  });
});

describe('routingParts', () => {
  it('gives each text part its role, and drops empty text and a role that is no message role', () => {
    expect(
      routingParts([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: '' },
        { role: 'narrator', content: 'not sent' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
          ],
        } as never,
      ])
    ).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'user', text: 'part one' },
    ]);
  });
});

describe('stickiness', () => {
  it('reads the groups kept on a conversation, ignoring anything else', () => {
    expect(readFlaggedGroups({ confidentialFlagged: ['commercial', 'medical'] })).toEqual([
      'commercial',
    ]);
    expect(readFlaggedGroups({ confidentialFlagged: 'personal' })).toEqual([]);
    expect(readFlaggedGroups(null)).toEqual([]);
    expect(readFlaggedGroups(['personal'])).toEqual([]);
  });

  it('adds what a turn found to what was kept, over the metadata it read', async () => {
    const stored = { confidentialNoted: ['personal'], confidentialFlagged: ['commercial'] };
    db.conversation.mockResolvedValue({ metadata: stored });
    await keepFlaggedGroups({ id: 'c1', userId: 'u1' }, ['personal']);

    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', userId: 'u1', metadata: { equals: stored } },
      data: {
        metadata: {
          confidentialNoted: ['personal'],
          confidentialFlagged: ['personal', 'commercial'],
        },
      },
    });
  });

  it('writes over metadata that was null as null, not over an empty object', async () => {
    db.conversation.mockResolvedValue({ metadata: null });
    await keepFlaggedGroups({ id: 'c1' }, ['commercial']);

    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1', metadata: { equals: Prisma.AnyNull } },
      data: { metadata: { confidentialFlagged: ['commercial'] } },
    });
  });

  it('writes nothing when the turn found nothing, or nothing new', async () => {
    await keepFlaggedGroups({ id: 'c1' }, []);
    db.conversation.mockResolvedValue({ metadata: { confidentialFlagged: ['personal'] } });
    await keepFlaggedGroups({ id: 'c1' }, ['personal']);

    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it('logs a failure to keep them rather than end the turn', async () => {
    db.conversation.mockRejectedValue(new Error('db down'));
    await expect(keepFlaggedGroups({ id: 'c1' }, ['personal'])).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'privacy: could not keep the confidential groups found on the conversation',
      { conversationId: 'c1', error: 'db down' }
    );
  });
});

describe('confidentialModelProblem', () => {
  const USABLE_PROVIDER = {
    isActive: true,
    isLocal: true,
    providerType: 'openai-compatible',
    trustedForConfidential: false,
  };
  const USABLE_MODEL = { isActive: true, capabilities: ['chat'] };

  beforeEach(() => {
    db.provider.mockResolvedValue(USABLE_PROVIDER);
    db.model.mockResolvedValue(USABLE_MODEL);
  });

  it('accepts an active chat model on an active local provider, or a trusted one', async () => {
    expect(await confidentialModelProblem(LOCAL_MODEL)).toBeNull();
    db.provider.mockResolvedValue({
      ...USABLE_PROVIDER,
      isLocal: false,
      trustedForConfidential: true,
    });
    expect(await confidentialModelProblem(TRUSTED_MODEL)).toBeNull();
  });

  it.each([
    [
      'no provider row',
      () => db.provider.mockResolvedValue(null),
      'Its provider is not configured.',
    ],
    [
      'a provider turned off',
      () => db.provider.mockResolvedValue({ ...USABLE_PROVIDER, isActive: false }),
      'Its provider is turned off.',
    ],
    [
      'a provider neither local nor trusted',
      () => db.provider.mockResolvedValue({ ...USABLE_PROVIDER, isLocal: false }),
      'Its provider is neither local nor ticked "Trusted with confidential content".',
    ],
    [
      'a Voyage row marked local, which never builds a local client',
      () => db.provider.mockResolvedValue({ ...USABLE_PROVIDER, providerType: 'voyage' }),
      'Its provider is neither local nor ticked "Trusted with confidential content".',
    ],
    [
      'no model row',
      () => db.model.mockResolvedValue(null),
      'The model is not in the provider models list.',
    ],
    [
      'a model turned off',
      () => db.model.mockResolvedValue({ ...USABLE_MODEL, isActive: false }),
      'The model is turned off in the provider models list.',
    ],
    [
      'an embedding model',
      () => db.model.mockResolvedValue({ ...USABLE_MODEL, capabilities: ['embedding'] }),
      'The model is not a chat model.',
    ],
  ])('refuses %s', async (_name, arrange, problem) => {
    arrange();
    expect(await confidentialModelProblem(LOCAL_MODEL)).toBe(problem);
  });
});
