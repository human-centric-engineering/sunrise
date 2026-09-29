/**
 * Tests: the platform-agent registry (§116 t-724).
 *
 * The roster is the migration's contract: the sixteen agents the eight seeds
 * used to write, with the audience each gets. The fork seam is the other half:
 * a registration lands, a core replacement is named in the log, a throwing
 * init is rolled back, and the digest moves when — and only when — something
 * a reconcile writes from moves.
 *
 * @see lib/orchestration/agents/platform-agents.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockInit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/app/platform-agents', () => ({ initAppPlatformAgents: mockInit }));

/** The patterns document's slug, which a new `chunks.json` changes (t-726). */
const patternsKnowledge = vi.hoisted(() => ({
  PATTERNS_DOCUMENT_SLUG: 'patterns-aaaaaaaa',
  PATTERNS_TAG_SLUG: 'agentic-design-patterns',
}));
vi.mock('@/lib/orchestration/knowledge/patterns-knowledge', () => patternsKnowledge);

import {
  CORE_PLATFORM_AGENTS,
  PLATFORM_AGENT_BASELINE,
  listPlatformAgents,
  platformAgentRegistryHash,
  platformAgentsForOrg,
  registerPlatformAgent,
  __resetPlatformAgentsForTests,
  type PlatformAgentDefinition,
} from '@/lib/orchestration/agents/platform-agents';
import { platformAgentFieldNames } from '@/lib/orchestration/agents/agent-field-registry';

const EVERY_ORG = [
  'mcp-system',
  'eval-judge-correctness',
  'eval-judge-relevance',
  'eval-judge-coherence',
  'eval-judge-faithfulness',
  'eval-judge-groundedness',
  'eval-judge-brand-voice',
  'eval-case-generator',
  'eval-judge-context-precision',
  'eval-judge-context-recall',
  'eval-judge-answer-similarity',
  'cleanup-agent',
];
// The provider auditors write the catalogue every org reads; the Learn page's
// advisor and quiz serve the install's app admins (§116 t-733).
const INSTALL_ONLY = [
  'pattern-advisor',
  'quiz-master',
  'provider-model-auditor',
  'audit-report-writer',
];

function fork(slug: string): PlatformAgentDefinition {
  return {
    slug,
    audience: 'every-org',
    agent: {
      name: 'Intake Triage',
      description: 'Routes requests.',
      systemInstructions: 'You triage.',
      temperature: 0.2,
      maxTokens: 512,
    },
    capabilities: [],
    knowledgeTags: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInit.mockImplementation(() => {});
  __resetPlatformAgentsForTests();
});

describe('the core roster', () => {
  it('is the sixteen agents the seeds used to write, twelve for every org', () => {
    expect(CORE_PLATFORM_AGENTS.map((d) => d.slug).sort()).toEqual(
      [...EVERY_ORG, ...INSTALL_ONLY].sort()
    );
    expect(
      CORE_PLATFORM_AGENTS.filter((d) => d.audience === 'install-only').map((d) => d.slug)
    ).toEqual(INSTALL_ONLY);
  });

  it('gives the install org all sixteen and any other org the twelve', () => {
    expect(platformAgentsForOrg('install')).toHaveLength(16);
    expect(
      platformAgentsForOrg('cmorg-other')
        .map((d) => d.slug)
        .sort()
    ).toEqual([...EVERY_ORG].sort());
  });

  it('marks the judges and the generator by kind, and keeps the auditor’s budget as a starting default', () => {
    const bySlug = new Map(CORE_PLATFORM_AGENTS.map((d) => [d.slug, d]));
    const judges = CORE_PLATFORM_AGENTS.filter((d) => d.slug.startsWith('eval-judge-'));
    expect(judges).toHaveLength(9);
    for (const judge of judges) expect(judge.agent.kind).toBe('judge');
    expect(bySlug.get('eval-case-generator')!.agent.kind).toBe('generator');
    expect(bySlug.get('provider-model-auditor')!.defaults).toEqual({ monthlyBudgetUsd: 25 });
    expect(bySlug.get('cleanup-agent')!.defaultBinding).toBeTypeOf('function');
    expect(bySlug.get('cleanup-agent')!.capabilities).toHaveLength(14);
  });

  it('leaves mcp-system’s bindings to the org, and only mcp-system’s', () => {
    // Its tools are the MCP Tools page's; under CAPABILITY_BINDING_MODE=strict
    // an operator grants them by adding binding rows the reconcile must keep.
    expect(
      CORE_PLATFORM_AGENTS.filter((d) => d.capabilityBindings === 'org').map((d) => d.slug)
    ).toEqual(['mcp-system']);
  });

  it('sets only code-owned fields in any definition', () => {
    // An org-tunable field in `agent` would be written back by every
    // reconcile, overriding the org's choice of provider or budget.
    const codeOwned = new Set(platformAgentFieldNames('code'));
    for (const definition of CORE_PLATFORM_AGENTS) {
      for (const field of Object.keys(definition.agent)) {
        expect(codeOwned.has(field), `${definition.slug}.${field}`).toBe(true);
      }
    }
  });

  it('has a baseline for every code-owned field a definition may leave out', () => {
    const always = [
      'slug',
      'name',
      'description',
      'systemInstructions',
      'temperature',
      'maxTokens',
    ];
    const codeOwnedScalars = platformAgentFieldNames('code').filter(
      (f) => !f.startsWith('granted') && !always.includes(f)
    );
    expect(Object.keys(PLATFORM_AGENT_BASELINE).sort()).toEqual(codeOwnedScalars.sort());
  });
});

describe('the fork seam', () => {
  it('runs the fork’s init once, before the first read', () => {
    mockInit.mockImplementation(() => registerPlatformAgent(fork('intake-triage')));

    const slugs = listPlatformAgents().map((d) => d.slug);
    listPlatformAgents();

    expect(slugs).toContain('intake-triage');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('lets a fork replace a core agent by slug, and says so', () => {
    const replacement = { ...fork('cleanup-agent') };
    mockInit.mockImplementation(() => registerPlatformAgent(replacement));

    const cleanup = listPlatformAgents().find((d) => d.slug === 'cleanup-agent');

    expect(cleanup).toBe(replacement);
    expect(listPlatformAgents()).toHaveLength(16);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/replaced a core platform agent/),
      { slug: 'cleanup-agent' }
    );
  });

  it('rolls back every registration of an init that throws', () => {
    mockInit.mockImplementation(() => {
      registerPlatformAgent(fork('first'));
      registerPlatformAgent(fork('cleanup-agent'));
      throw new Error('fork bug');
    });

    const definitions = listPlatformAgents();

    expect(definitions).toEqual(CORE_PLATFORM_AGENTS);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('refuses a slug that is not lowercase kebab-case', () => {
    expect(() => registerPlatformAgent(fork('Intake Triage'))).toThrow(/kebab-case/);
  });

  it('refuses a definition that repeats a capability or tag slug', () => {
    // The repeat would meet a unique key inside the create transaction, which
    // the reconcile reads as a concurrent run and retries for ever.
    expect(() => registerPlatformAgent({ ...fork('dup'), capabilities: ['a', 'a'] })).toThrow(
      /repeats a slug in capabilities/
    );
    expect(() => registerPlatformAgent({ ...fork('dup'), knowledgeTags: ['t', 't'] })).toThrow(
      /repeats a slug in knowledgeTags/
    );
    for (const definition of CORE_PLATFORM_AGENTS) {
      expect(() => registerPlatformAgent(definition), definition.slug).not.toThrow();
    }
  });

  it('refuses declared capabilities on an agent whose bindings are the org’s', () => {
    expect(() =>
      registerPlatformAgent({
        ...fork('dispatcher'),
        capabilities: ['search_knowledge_base'],
        capabilityBindings: 'org',
      })
    ).toThrow(/cannot declare capabilities/);
  });
});

describe('platformAgentRegistryHash', () => {
  it('is stable across reads', () => {
    expect(platformAgentRegistryHash()).toBe(platformAgentRegistryHash());
  });

  it('moves when a definition changes, including a registration from a fork', () => {
    const before = platformAgentRegistryHash();
    __resetPlatformAgentsForTests();
    mockInit.mockImplementation(() => registerPlatformAgent(fork('intake-triage')));

    expect(platformAgentRegistryHash()).not.toBe(before);
  });

  it('moves when a definition is registered after the digest was read', () => {
    const before = platformAgentRegistryHash();

    registerPlatformAgent(fork('late-arrival'));

    expect(platformAgentRegistryHash()).not.toBe(before);
  });

  it('moves when the patterns knowledge changes, so every org is reconciled for its copy', () => {
    const before = platformAgentRegistryHash();
    __resetPlatformAgentsForTests();
    patternsKnowledge.PATTERNS_DOCUMENT_SLUG = 'patterns-bbbbbbbb';

    try {
      expect(platformAgentRegistryHash()).not.toBe(before);
    } finally {
      patternsKnowledge.PATTERNS_DOCUMENT_SLUG = 'patterns-aaaaaaaa';
    }
  });

  it('does not depend on registration order', () => {
    mockInit.mockImplementation(() => {
      registerPlatformAgent(fork('a-one'));
      registerPlatformAgent(fork('b-two'));
    });
    const forward = platformAgentRegistryHash();
    __resetPlatformAgentsForTests();
    mockInit.mockImplementation(() => {
      registerPlatformAgent(fork('b-two'));
      registerPlatformAgent(fork('a-one'));
    });

    expect(platformAgentRegistryHash()).toBe(forward);
  });
});
