/**
 * Tests: an agent's privacy mode and an org's minimum and protected terms
 * (§127, t-1010), through the real privacy stage and its real registry.
 *
 * The database reads are scripted: the agent's `privacyMode` column and the
 * org's `settings` JSON. The install's settings read is stubbed, because the
 * stage takes the global mode from it.
 *
 * @see lib/orchestration/privacy/scope-settings.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What the scripted database holds: the agent's column and the org's JSON. */
interface ScriptedDb {
  agentMode: unknown;
  /** A mode for one agent id, over `agentMode`. */
  byAgent: Record<string, unknown>;
  orgSettings: unknown;
  agentReads: number;
  orgReads: number;
  failNext: boolean;
}
const db = vi.hoisted((): ScriptedDb => ({
  agentMode: null,
  byAgent: {},
  orgSettings: null,
  agentReads: 0,
  orgReads: 0,
  failNext: false,
}));
const settings = vi.hoisted((): { mode: string; embeddings: string; ignored: string[] } => ({
  mode: 'off',
  embeddings: 'allow',
  ignored: ['DATE', 'LOCATION'],
}));
const tenancy = vi.hoisted((): { TENANCY_MODE: string } => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: tenancy }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findUnique: vi.fn(async (query: { where: { id: string } }) => {
        db.agentReads++;
        if (db.failNext) {
          db.failNext = false;
          throw new Error('connection reset');
        }
        const id = query.where.id;
        return { privacyMode: id in db.byAgent ? db.byAgent[id] : db.agentMode };
      }),
    },
    org: {
      findUnique: vi.fn(async () => {
        db.orgReads++;
        return { settings: db.orgSettings };
      }),
    },
  },
}));
vi.mock('@/lib/app/privacy-adapters', () => ({ initAppPrivacyAdapters: () => undefined }));
vi.mock('@/lib/orchestration/settings', () => ({
  getOrchestrationSettings: async () => ({
    privacyMode: settings.mode,
    privacyIgnoredEntityTypes: settings.ignored,
    privacyProtectLocalProviders: false,
    privacyEmbeddingsPolicy: settings.embeddings,
  }),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import { applyPrivacyStage, PrivacyRefusedError } from '@/lib/orchestration/llm/privacy-stage';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  agentPrivacyScope,
  createPrivacyScope,
  privacySummary,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import { scopePrivacySettings } from '@/lib/orchestration/privacy/scope-settings';
import {
  PRIVACY_MODES_AVAILABLE,
  PRIVACY_TIGHTENING_MODES,
} from '@/lib/orchestration/privacy/settings-policy';
import { __resetPrivacyAdaptersForTests } from '@/lib/privacy/adapters/registry';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { PRIVACY_MODES_BY_STRICTNESS, type PrivacyMode } from '@/lib/privacy/adapters/types';

const AGENT = 'agent-hr';
const ORG = 'org-acme';

/** A message with nothing in it to find, so no mode refuses or masks it. */
const PLAIN: LlmMessage[] = [{ role: 'user', content: 'What is the holiday policy?' }];

function chatCall(messages: LlmMessage[] = PLAIN) {
  return {
    providerSlug: 'openai',
    isLocal: false,
    coverage: 'full' as const,
    args: [messages, { model: 'm' }],
  };
}

function scope(fields: { agentId?: string; orgId?: string } = { agentId: AGENT, orgId: ORG }) {
  return createPrivacyScope({ scopeId: 'conversation:c1', ...fields });
}

function orgPrivacy(minimumMode: string | null, protectedTerms: unknown[] = []) {
  return { privacy: { minimumMode, protectedTerms } };
}

async function run(s: PrivacyScope, messages?: LlmMessage[]) {
  return runInPrivacyScope(s, () => applyPrivacyStage(chatCall(messages)));
}

/** The strictest of the modes given, by the one ordering the spec defines. */
function strictest(...modes: (PrivacyMode | null)[]): PrivacyMode {
  return modes
    .filter((m): m is PrivacyMode => m !== null)
    .reduce((a, b) =>
      PRIVACY_MODES_BY_STRICTNESS.indexOf(b) > PRIVACY_MODES_BY_STRICTNESS.indexOf(a) ? b : a
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrivacyAdaptersForTests();
  Object.assign(db, {
    agentMode: null,
    byAgent: {},
    orgSettings: null,
    agentReads: 0,
    orgReads: 0,
    failNext: false,
  });
  settings.mode = 'off';
  settings.embeddings = 'allow';
  settings.ignored = ['DATE', 'LOCATION'];
  tenancy.TENANCY_MODE = 'multi';
});

describe('global mode, agent mode and org minimum', () => {
  const agentChoices = [null, ...PRIVACY_TIGHTENING_MODES];
  const orgChoices = [null, ...PRIVACY_TIGHTENING_MODES];
  const cases = PRIVACY_MODES_AVAILABLE.flatMap((global) =>
    agentChoices.flatMap((agent) => orgChoices.map((org) => ({ global, agent, org })))
  );

  it('covers every combination', () => {
    expect(cases).toHaveLength(5 * 5 * 5);
  });

  it.each(cases)(
    'global $global, agent $agent, org $org: the strictest applies, and the org minimum never loosens it',
    async ({ global, agent, org }) => {
      settings.mode = global;
      db.agentMode = agent;
      db.orgSettings = orgPrivacy(org);
      const s = scope();

      await run(s);

      const expected = strictest(global, agent, org);
      // A call that ends up `off` is not scanned, so the scope records no mode.
      expect(privacySummary(s)?.mode ?? 'off').toBe(expected);
    }
  );
});

describe('reading the settings', () => {
  it('reads the agent and the org once per scope, however many calls it makes', async () => {
    settings.mode = 'detect';
    const s = scope();

    await run(s);
    await run(s);
    await run(s);

    expect(db.agentReads).toBe(1);
    expect(db.orgReads).toBe(1);
  });

  it('reads again in a new scope, so a change applies from the next turn', async () => {
    settings.mode = 'detect';
    await run(scope());
    db.agentMode = 'block';
    const next = scope();

    await run(next);

    expect(db.agentReads).toBe(2);
    expect(privacySummary(next)?.mode).toBe('block');
  });

  it('follows the scope when its agent is bound after the first call', async () => {
    settings.mode = 'detect';
    const s = scope({ orgId: ORG });
    await run(s);
    db.agentMode = 'redact';

    s.agentId = AGENT;
    await run(s);

    expect(db.agentReads).toBe(1);
    expect(privacySummary(s)?.mode).toBe('redact');
  });

  it('does not keep a read that failed: the call is refused, and the next one asks again', async () => {
    settings.mode = 'detect';
    db.failNext = true;
    const s = scope();

    await expect(run(s)).rejects.toMatchObject({ reason: 'policy_resolver_failed' });
    await run(s);

    expect(db.agentReads).toBe(2);
  });

  it('reads nothing for a call that names neither agent nor org at multi', async () => {
    settings.mode = 'detect';

    await run(scope({}));

    expect(db.agentReads + db.orgReads).toBe(0);
  });

  it('applies the install org’s floor at single to a call with no org in context', async () => {
    // An admin API key's request enters no org; at `single` the install org
    // is the one org there is, as the spend caps read it.
    tenancy.TENANCY_MODE = 'single';
    db.orgSettings = orgPrivacy('redact');
    const { prisma } = await import('@/lib/db/client');
    const s = scope({});

    await run(s);

    expect(prisma.org.findUnique).toHaveBeenCalledWith({
      where: { id: INSTALL_ORG_ID },
      select: { settings: true },
    });
    expect(privacySummary(s)?.mode).toBe('redact');
  });

  it('reads each time for a call with no scope', async () => {
    await expect(
      scopePrivacySettings({ agentId: AGENT }, undefined).then(() =>
        scopePrivacySettings({ agentId: AGENT }, undefined)
      )
    ).resolves.toMatchObject({ agentMode: null });
    expect(db.agentReads).toBe(2);
  });
});

describe('a stored value that cannot be read refuses the call', () => {
  it('an agent mode that is not a mode, naming the agent and not the value', async () => {
    db.agentMode = 'off-ish';
    settings.mode = 'detect';

    const err = await run(scope()).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(PrivacyRefusedError);
    expect(err).toMatchObject({ reason: 'policy_resolver_failed' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('agent form'), {
      agentId: AGENT,
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('off-ish');
  });

  it('an org slice that does not parse, even under mode off', async () => {
    db.orgSettings = { privacy: { minimumMode: 'loose', protectedTerms: [] } };

    await expect(run(scope())).rejects.toMatchObject({ reason: 'policy_resolver_failed' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('organisation page'), {
      orgId: ORG,
      issues: ['minimumMode'],
    });
  });

  it('an agent that is gone sets nothing', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValueOnce(null);
    settings.mode = 'detect';
    const s = scope();

    await run(s);

    expect(privacySummary(s)?.mode).toBe('detect');
  });
});

describe('protected terms', () => {
  // An organisation's name with no legal suffix: tier C has no rule for it,
  // so only the org's protected term can find it.
  const MESSAGE: LlmMessage[] = [
    { role: 'user', content: 'Draft a renewal note for Brightwater about next year.' },
  ];

  it('are counted in detect mode, by tier B', async () => {
    settings.mode = 'detect';
    db.orgSettings = orgPrivacy(null, [{ value: 'Brightwater', type: 'ORG' }]);
    const s = scope();

    await run(s, MESSAGE);

    expect(privacySummary(s)?.counts).toEqual({ ORG: 1 });
  });

  it('find nothing without the term: the count above is the term', async () => {
    settings.mode = 'detect';
    const s = scope();

    await run(s, MESSAGE);

    expect(privacySummary(s)?.counts ?? {}).toEqual({});
  });

  it('are counted even when the install ignores their type: the org asked for them', async () => {
    settings.mode = 'detect';
    settings.ignored = ['DATE', 'LOCATION', 'ORG'];
    db.orgSettings = orgPrivacy(null, [{ value: 'Brightwater', type: 'ORG' }]);
    const s = scope();

    await run(s, MESSAGE);

    expect(privacySummary(s)?.counts).toEqual({ ORG: 1 });
  });

  it('leave an ignored type ignored for an org that protects no name of it', async () => {
    settings.mode = 'detect';
    settings.ignored = ['DATE', 'LOCATION', 'PERSON'];
    db.orgSettings = orgPrivacy(null, [{ value: 'Brightwater', type: 'ORG' }]);
    const s = scope();

    await run(s, [{ role: 'user', content: 'Brightwater wrote to Dr Priya Sharma.' }]);

    expect(privacySummary(s)?.counts.PERSON).toBeUndefined();
  });

  it('are masked under pseudonymise', async () => {
    settings.mode = 'pseudonymise';
    db.orgSettings = orgPrivacy(null, [{ value: 'Brightwater', type: 'ORG' }]);

    const { args } = await run(scope(), MESSAGE);

    expect(JSON.stringify(args)).not.toContain('Brightwater');
  });
});

describe('the resolver', () => {
  it('cannot be replaced or registered by an app: the core. prefix is reserved', async () => {
    const { registerPrivacyPolicyResolver } = await import('@/lib/privacy/adapters/registry');

    expect(() =>
      registerPrivacyPolicyResolver({ id: 'core.scope-settings', resolve: () => undefined })
    ).toThrow('reserved');
  });

  it('is registered with a timeout long enough for a cold database read', async () => {
    const { getPrivacyAdapters } = await import('@/lib/privacy/adapters/registry');
    const { SCOPE_SETTINGS_RESOLVER_TIMEOUT_MS } =
      await import('@/lib/privacy/adapters/core-defaults');
    const { SCOPE_SETTINGS_RESOLVER_ID } =
      await import('@/lib/orchestration/privacy/scope-settings');

    const core = getPrivacyAdapters().policyResolvers.find(
      (r) => r.id === SCOPE_SETTINGS_RESOLVER_ID
    );

    expect(core?.timeoutMs).toBe(SCOPE_SETTINGS_RESOLVER_TIMEOUT_MS);
    expect(SCOPE_SETTINGS_RESOLVER_TIMEOUT_MS).toBeGreaterThan(1_000);
  });
});

describe('a scope that records nowhere (a reply embedding)', () => {
  const embedCall = {
    providerSlug: 'openai',
    isLocal: false,
    coverage: 'count' as const,
    args: [['Jane Hart asked about her leave']],
  };
  const embeddingScope = () =>
    createPrivacyScope({
      scopeId: 'message-embedding:agent:x',
      agentId: AGENT,
      recordsNowhere: true,
    });

  it("still applies the agent's mode: local_only refuses the remote embedding", async () => {
    settings.mode = 'detect';
    settings.embeddings = 'local_only';
    db.agentMode = 'pseudonymise';

    await expect(
      runInPrivacyScope(embeddingScope(), () => applyPrivacyStage(embedCall))
    ).rejects.toMatchObject({ reason: 'embeddings_local_only' });
  });

  it('is not scanned for counts nothing reads', async () => {
    settings.mode = 'detect';
    const s = embeddingScope();

    const result = await runInPrivacyScope(s, () => applyPrivacyStage(embedCall));

    expect(result.args).toBe(embedCall.args);
    expect(privacySummary(s)).toBeUndefined();
  });
});

describe('agentPrivacyScope', () => {
  it('is a child of the current scope carrying the agent, and records there too', async () => {
    settings.mode = 'detect';
    const step = createPrivacyScope({ scopeId: 'execution:e1:step:s1', orgId: ORG });
    db.agentMode = 'redact';

    const child = agentPrivacyScope(AGENT, step);
    await run(child);

    expect(child.agentId).toBe(AGENT);
    expect(child.parent).toBe(step);
    expect(step.agentId).toBeUndefined();
    expect(privacySummary(step)?.mode).toBe('redact');
  });

  it('keeps two agents apart when they run at once on one step scope', async () => {
    settings.mode = 'detect';
    const step = createPrivacyScope({ scopeId: 'execution:e1:step:s1', orgId: ORG });
    db.byAgent = { 'agent-strict': 'block' };
    const strict = agentPrivacyScope('agent-strict', step);
    const plain = agentPrivacyScope('agent-plain', step);

    await Promise.all([run(strict), run(plain)]);

    expect(privacySummary(strict)?.mode).toBe('block');
    expect(privacySummary(plain)?.mode).toBe('detect');
  });

  it('stands alone when there is no current scope', () => {
    const s = agentPrivacyScope(AGENT, null);

    expect(s).toMatchObject({ scopeId: `agent:${AGENT}`, agentId: AGENT });
    expect(s.parent).toBeUndefined();
  });
});
