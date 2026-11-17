/**
 * Tests: the privacy stage's confidential-content backstop (§130 t-1037) —
 * each group's policy against providers that are local, trusted, or neither;
 * a classifier failure under a strict policy; scopes that record nowhere;
 * embeddings; and where a refused chat call held the content.
 *
 * The registry, core's detectors and core's phrase classifier are real, so a
 * call is flagged by what it says. The app seam is a stand-in each case
 * fills, and the settings and agent reads are stubbed.
 *
 * @see lib/orchestration/llm/privacy-stage.ts
 * @see .context/privacy/llm-privacy-layer.md — *Confidential content*
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ init: vi.fn<() => void>() }));
const settings = vi.hoisted(() => ({
  read: vi.fn<() => Promise<Record<string, unknown>>>(),
}));
const db = vi.hoisted(() => ({
  agent: vi.fn<() => Promise<Record<string, unknown> | null>>(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: vi.fn(() => db.agent()) },
    org: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('@/lib/app/privacy-adapters', () => ({
  initAppPrivacyAdapters: () => seam.init(),
}));
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: () => settings.read(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  applyPrivacyStage,
  isConfidentialRefusal,
  isLocalOnlyEmbeddingRefusal,
  PrivacyRefusedError,
  type PrivacyStageCall,
} from '@/lib/orchestration/llm/privacy-stage';
import { PRIVACY_CONFIDENTIAL } from '@/lib/orchestration/llm/provider';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  createPrivacyScope,
  privacySummary,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import {
  __resetPrivacyAdaptersForTests,
  registerSensitivityClassifier,
} from '@/lib/privacy/adapters/registry';
import type { ConfidentialPolicy, SensitivityClassifier } from '@/lib/privacy/adapters/types';

const HEALTH = "I've been signed off with depression, how do I tell my manager?";
const LAUNCH = "Write teaser copy for the S27, it's unannounced until March.";
const PLAIN = 'What time is the standup tomorrow?';

function policies(
  personal: ConfidentialPolicy,
  commercial: ConfidentialPolicy,
  privacyMode = 'detect'
) {
  settings.read.mockResolvedValue({
    privacyMode,
    privacyIgnoredEntityTypes: ['DATE', 'LOCATION'],
    privacyProtectLocalProviders: false,
    privacyEmbeddingsPolicy: 'allow',
    privacyConfidentialPersonal: personal,
    privacyConfidentialCommercial: commercial,
  });
}

function chat(...users: string[]): LlmMessage[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    ...users.map((content) => ({ role: 'user' as const, content })),
  ];
}

type Provider = 'cloud' | 'trusted' | 'local';

function chatCall(messages: LlmMessage[], provider: Provider = 'cloud'): PrivacyStageCall {
  return {
    providerSlug: provider,
    isLocal: provider === 'local',
    isTrusted: vi.fn(async () => provider === 'trusted'),
    coverage: 'full',
    args: [messages, { model: 'm' }],
  };
}

function embeddingCall(texts: string[], provider: Provider = 'cloud'): PrivacyStageCall {
  return {
    providerSlug: provider,
    isLocal: provider === 'local',
    isTrusted: vi.fn(async () => provider === 'trusted'),
    coverage: 'count',
    args: [texts],
  };
}

function newScope(): PrivacyScope {
  return createPrivacyScope({ scopeId: 'conversation:c1', agentId: 'agent-1' });
}

async function run(call: PrivacyStageCall, scope: PrivacyScope | null = newScope()) {
  return scope ? runInPrivacyScope(scope, () => applyPrivacyStage(call)) : applyPrivacyStage(call);
}

async function refusal(promise: Promise<unknown>): Promise<PrivacyRefusedError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  if (!(err instanceof PrivacyRefusedError))
    throw new Error(`expected a refusal, got ${String(err)}`);
  return err;
}

/** An app classifier that fails on every call. */
function failingClassifier(egress: SensitivityClassifier['egress'] = 'in_process') {
  const classify = vi.fn(() => Promise.reject(new Error('classifier down')));
  const classifier: SensitivityClassifier = {
    id: 'acme.failing',
    egress,
    categories: { acme_secret: 'commercial' },
    classify,
  };
  return { classifier, classify };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrivacyAdaptersForTests();
  seam.init.mockImplementation(() => undefined);
  db.agent.mockResolvedValue(null);
  policies('allow', 'allow');
});

describe('local_only', () => {
  it('refuses a flagged call to a cloud provider: nothing handed back, the trace says why', async () => {
    policies('local_only', 'allow');
    const scope = newScope();
    const err = await refusal(run(chatCall(chat(HEALTH)), scope));

    expect(err.reason).toBe('confidential_not_permitted');
    expect(err.code).toBe(PRIVACY_CONFIDENTIAL);
    expect(isConfidentialRefusal(err)).toBe(true);
    // Reader-safe: no file, no setting name, no request text.
    expect(err.message).toBe(
      'The request was not sent: it contains confidential content that this deployment does not send to this AI provider.'
    );
    expect(err.message).not.toMatch(/depression|local_only|\.ts/);
    expect(privacySummary(scope)).toMatchObject({
      refused: ['confidential_not_permitted'],
      sensitivity: { personal: ['health'] },
      confidential: { personal: 'refused' },
    });
  });

  it('sends the same call to a local provider, unchanged, and records it allowed', async () => {
    policies('local_only', 'allow');
    const scope = newScope();
    const call = chatCall(chat(HEALTH), 'local');
    const result = await run(call, scope);

    expect(result.args).toBe(call.args);
    expect(privacySummary(scope)?.confidential).toEqual({ personal: 'allowed' });
  });

  it('does not count a trusted provider as local', async () => {
    policies('local_only', 'allow');
    await expect(run(chatCall(chat(HEALTH), 'trusted'))).rejects.toMatchObject({
      reason: 'confidential_not_permitted',
    });
  });

  it('sends a call that holds nothing confidential, and records no decision', async () => {
    policies('local_only', 'local_only');
    const scope = newScope();
    await run(chatCall(chat(PLAIN)), scope);
    expect(privacySummary(scope)?.confidential).toBeUndefined();
  });
});

describe('approved_only', () => {
  it('sends a flagged call to a trusted provider', async () => {
    policies('allow', 'approved_only');
    const scope = newScope();
    await run(chatCall(chat(LAUNCH), 'trusted'), scope);
    expect(privacySummary(scope)?.confidential).toEqual({ commercial: 'allowed' });
  });

  it('sends it to a local provider without asking whether it is trusted', async () => {
    policies('allow', 'approved_only');
    const call = chatCall(chat(LAUNCH), 'local');
    await run(call);
    expect(call.isTrusted).not.toHaveBeenCalled();
  });

  it('refuses it to a provider that is neither', async () => {
    policies('allow', 'approved_only');
    await expect(run(chatCall(chat(LAUNCH)))).rejects.toMatchObject({
      reason: 'confidential_not_permitted',
    });
  });

  it('refuses when the trusted lookup fails, or the call has none', async () => {
    policies('allow', 'approved_only');
    const failing = chatCall(chat(LAUNCH));
    failing.isTrusted = vi.fn(() => Promise.reject(new Error('db down')));
    await expect(run(failing)).rejects.toMatchObject({ reason: 'confidential_not_permitted' });

    const none = chatCall(chat(LAUNCH), 'trusted');
    delete none.isTrusted;
    await expect(run(none)).rejects.toMatchObject({ reason: 'confidential_not_permitted' });
  });

  it('never asks whether the provider is trusted when no policy needs it', async () => {
    policies('local_only', 'allow');
    const call = chatCall(chat(LAUNCH));
    await run(call);
    expect(call.isTrusted).not.toHaveBeenCalled();
  });
});

describe('block', () => {
  it('refuses a flagged call whatever the provider, local included', async () => {
    policies('block', 'allow');
    for (const provider of ['cloud', 'trusted', 'local'] as const) {
      await expect(run(chatCall(chat(HEALTH), provider))).rejects.toMatchObject({
        reason: 'confidential_blocked',
        code: PRIVACY_CONFIDENTIAL,
      });
    }
  });

  it('refuses in mode off too: the backstop is not the masking', async () => {
    policies('block', 'allow', 'off');
    await expect(run(chatCall(chat(HEALTH)))).rejects.toMatchObject({
      reason: 'confidential_blocked',
    });
  });
});

describe('warn and allow', () => {
  it('sends under warn and records the group warned', async () => {
    policies('warn', 'allow');
    const scope = newScope();
    const call = chatCall(chat(HEALTH));
    const result = await run(call, scope);
    expect(result.args).toBe(call.args);
    expect(privacySummary(scope)?.confidential).toEqual({ personal: 'warned' });
  });

  it('sends under allow and records the group allowed', async () => {
    const scope = newScope();
    await run(chatCall(chat(LAUNCH)), scope);
    expect(privacySummary(scope)?.confidential).toEqual({ commercial: 'allowed' });
  });
});

describe('two groups', () => {
  it("holds a call flagged in both to each group's policy: the stricter refuses", async () => {
    policies('allow', 'block');
    const scope = newScope();
    const err = await refusal(run(chatCall(chat(`${HEALTH} ${LAUNCH}`)), scope));
    expect(err.reason).toBe('confidential_blocked');
    // Nothing was sent, so neither group's content went anywhere.
    expect(privacySummary(scope)?.confidential).toEqual({
      personal: 'refused',
      commercial: 'refused',
    });
  });

  it("applies a group's policy only to its own content", async () => {
    policies('local_only', 'allow');
    const scope = newScope();
    await run(chatCall(chat(LAUNCH)), scope);
    expect(privacySummary(scope)?.confidential).toEqual({ commercial: 'allowed' });
  });
});

describe('a classifier that fails', () => {
  it.each(['approved_only', 'local_only', 'block'] as const)(
    'counts as flagged under %s: a call it could not check is refused',
    async (strict) => {
      seam.init.mockImplementation(() => {
        registerSensitivityClassifier(failingClassifier().classifier);
      });
      policies(strict, 'allow');
      const scope = newScope();
      // Nothing confidential in the text: the failure alone refuses it.
      const err = await refusal(run(chatCall(chat(PLAIN)), scope));
      expect(err.reason).toBe(
        strict === 'block' ? 'confidential_blocked' : 'confidential_not_permitted'
      );
      expect(privacySummary(scope)).toMatchObject({
        degraded: true,
        failedAdapters: ['acme.failing'],
      });
      // No content was found, so there is no group to place it by.
      expect(err.found).toBeUndefined();
    }
  );

  it.each(['allow', 'warn'] as const)('is only recorded, degraded, under %s', async (loose) => {
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(failingClassifier().classifier);
    });
    policies(loose, loose);
    const scope = newScope();
    await run(chatCall(chat(PLAIN)), scope);
    expect(privacySummary(scope)).toMatchObject({
      degraded: true,
      failedAdapters: ['acme.failing'],
    });
    expect(privacySummary(scope)?.refused).toBeUndefined();
  });

  it('does not refuse a local call under local_only: the policy permits it either way', async () => {
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(failingClassifier().classifier);
    });
    policies('local_only', 'local_only');
    await expect(run(chatCall(chat(PLAIN), 'local'))).resolves.toBeDefined();
  });
});

describe('scopes that record nowhere', () => {
  it('classifies and refuses a call with no scope when a policy could refuse it', async () => {
    policies('local_only', 'allow');
    await expect(run(chatCall(chat(HEALTH)), null)).rejects.toMatchObject({
      reason: 'confidential_not_permitted',
    });
  });

  it("refuses an agent's reply embedding (a scope that records nowhere) under local_only", async () => {
    policies('local_only', 'allow');
    const scope = createPrivacyScope({
      scopeId: 'message-embedding:agent:agent-1',
      agentId: 'agent-1',
      recordsNowhere: true,
    });
    const err = await refusal(
      run(embeddingCall(['You mentioned your depression diagnosis.']), scope)
    );
    expect(isConfidentialRefusal(err)).toBe(true);
    expect(isLocalOnlyEmbeddingRefusal(err)).toBe(false);
  });

  it('does not classify a call with no scope when no policy could refuse it', async () => {
    const classify = vi.fn(async () => []);
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier({
        id: 'acme.spy',
        egress: 'in_process',
        categories: { acme_secret: 'commercial' },
        classify,
      });
    });
    policies('warn', 'local_only');
    // Local, so local_only cannot refuse it; warn never refuses.
    await run(chatCall(chat(HEALTH), 'local'), null);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('embeddings', () => {
  it('refuses a flagged embedding input under block, with no place to report', async () => {
    policies('allow', 'block');
    const err = await refusal(run(embeddingCall([LAUNCH])));
    expect(err.reason).toBe('confidential_blocked');
    expect(err.found).toBeUndefined();
  });

  it('sends a flagged embedding to a local model under local_only', async () => {
    policies('local_only', 'local_only');
    const call = embeddingCall([HEALTH], 'local');
    await expect(run(call)).resolves.toEqual({ args: call.args });
  });
});

describe('where a refused chat call held the content', () => {
  it('names the messages that held the refused group, in order, and not the others', async () => {
    policies('local_only', 'allow');
    // 0 system · 1 health · 2 plain · 3 launch (commercial: allowed) · 4 health again
    const messages = chat(HEALTH, PLAIN, LAUNCH, 'My diabetes diagnosis came through today.');
    const err = await refusal(run(chatCall(messages)));
    expect(err.found).toEqual({ messageCount: 5, messageIndices: [1, 4] });
  });

  it('places an earlier message when the newest one holds nothing', async () => {
    policies('block', 'allow');
    const err = await refusal(run(chatCall(chat(HEALTH, PLAIN))));
    expect(err.found).toEqual({ messageCount: 3, messageIndices: [1] });
  });

  it('places nothing when a classifier fails on a message: the turn alone is left out', async () => {
    let calls = 0;
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier({
        id: 'acme.flaky',
        egress: 'in_process',
        categories: { acme_secret: 'commercial' },
        // The whole call classifies; the per-message pass then fails.
        classify: () => (calls++ === 0 ? Promise.resolve([]) : Promise.reject(new Error('down'))),
      });
    });
    policies('local_only', 'allow');
    const err = await refusal(run(chatCall(chat(HEALTH))));
    expect(err.found).toBeUndefined();
  });
});

describe('external classifiers', () => {
  it('are not sent a call the mode forwards untouched, even under a strict policy', async () => {
    const { classifier, classify } = failingClassifier('external');
    seam.init.mockImplementation(() => {
      registerSensitivityClassifier(classifier);
    });
    policies('block', 'block', 'off');
    // Core's in-process classifier still decides.
    await expect(run(chatCall(chat(HEALTH)))).rejects.toMatchObject({
      reason: 'confidential_blocked',
    });
    await expect(run(chatCall(chat(PLAIN)))).resolves.toBeDefined();
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("an agent's own policy", () => {
  it('tightens the install’s: an agent on block refuses where the install allows', async () => {
    db.agent.mockResolvedValue({
      privacyMode: null,
      privacyConfidentialPersonal: 'block',
      privacyConfidentialCommercial: null,
    });
    await expect(run(chatCall(chat(HEALTH)))).rejects.toMatchObject({
      reason: 'confidential_blocked',
    });
  });

  it('cannot loosen it: an agent on warn under an install on local_only is still refused', async () => {
    policies('local_only', 'allow');
    db.agent.mockResolvedValue({
      privacyMode: null,
      privacyConfidentialPersonal: 'warn',
      privacyConfidentialCommercial: null,
    });
    await expect(run(chatCall(chat(HEALTH)))).rejects.toMatchObject({
      reason: 'confidential_not_permitted',
    });
  });

  it('refuses every call while its stored policy is not one this version knows', async () => {
    db.agent.mockResolvedValue({
      privacyMode: null,
      privacyConfidentialPersonal: 'ask_first',
      privacyConfidentialCommercial: null,
    });
    await expect(run(chatCall(chat(PLAIN)))).rejects.toMatchObject({
      reason: 'policy_resolver_failed',
    });
  });
});

describe('an install-wide policy this version cannot read', () => {
  it('reads as block, so a corrupted row never loosens it', async () => {
    settings.read.mockResolvedValue({
      privacyMode: 'detect',
      privacyIgnoredEntityTypes: [],
      privacyProtectLocalProviders: false,
      privacyConfidentialPersonal: 'garbled',
      privacyConfidentialCommercial: 'allow',
    });
    await expect(run(chatCall(chat(HEALTH), 'local'))).rejects.toMatchObject({
      reason: 'confidential_blocked',
    });
  });
});
