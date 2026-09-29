/**
 * The platform-agent edit guard (§116 t-725).
 *
 * Every write path to an agent consults this module, so each rule it holds
 * is pinned here once:
 * - a system agent's platform-owned fields are refused when they CHANGE,
 *   compared by value (jsonb key order, grant order), never on presence;
 * - its org-tunable fields and an org's own agent are never refused;
 * - bindings follow the definition's `capabilityBindings`, not the slug, and
 *   a retired slug with no definition stays locked;
 * - every registered slug is reserved, install-only ones included, and a
 *   fork's registration reserves its slug too.
 *
 * @see lib/orchestration/agents/platform-agent-guard.ts
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ForbiddenError, ValidationError } from '@/lib/api/errors';
import { platformAgentFieldNames } from '@/lib/orchestration/agents/agent-field-registry';
import {
  assertAgentSlugNotReserved,
  assertBindingsEditable,
  assertPlatformOwnedFieldsUnchanged,
  changedPlatformOwnedFields,
  isReservedAgentSlug,
  platformAgentEditPolicy,
  platformBindingsLocked,
  type PlatformOwnedCurrentValues,
} from '@/lib/orchestration/agents/platform-agent-guard';
import {
  __resetPlatformAgentsForTests,
  registerPlatformAgent,
} from '@/lib/orchestration/agents/platform-agents';

afterEach(() => {
  __resetPlatformAgentsForTests();
});

function current(overrides: Partial<PlatformOwnedCurrentValues> = {}): PlatformOwnedCurrentValues {
  return {
    name: 'Pattern Advisor',
    slug: 'pattern-advisor',
    temperature: 0.7,
    metadata: { b: 2, a: 1 },
    topicBoundaries: ['x', 'y'],
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    grantedTagIds: ['tag-a', 'tag-b'],
    grantedDocumentIds: [],
    ...overrides,
  };
}

describe('changedPlatformOwnedFields', () => {
  it('names a platform-owned field whose value changes', () => {
    expect(changedPlatformOwnedFields(current(), { temperature: 0.2 })).toEqual(['temperature']);
  });

  it('ignores a platform-owned field sent unchanged', () => {
    expect(
      changedPlatformOwnedFields(current(), { temperature: 0.7, name: 'Pattern Advisor' })
    ).toEqual([]);
  });

  it('ignores an org-tunable field whatever its value', () => {
    expect(
      changedPlatformOwnedFields(current(), {
        model: 'gpt-5',
        provider: 'openai',
        retentionDays: 5,
      })
    ).toEqual([]);
  });

  it('compares JSON by value, not key order', () => {
    expect(changedPlatformOwnedFields(current(), { metadata: { a: 1, b: 2 } })).toEqual([]);
    expect(changedPlatformOwnedFields(current(), { metadata: { a: 1, b: 3 } })).toEqual([
      'metadata',
    ]);
  });

  it('compares grants as sets but ordinary arrays in order', () => {
    expect(changedPlatformOwnedFields(current(), { grantedTagIds: ['tag-b', 'tag-a'] })).toEqual(
      []
    );
    expect(changedPlatformOwnedFields(current(), { grantedTagIds: ['tag-a'] })).toEqual([
      'grantedTagIds',
    ]);
    expect(changedPlatformOwnedFields(current(), { grantedTagIds: ['tag-a', 'tag-c'] })).toEqual([
      'grantedTagIds',
    ]);
    // topicBoundaries is a list the prompt reads in order, so a reorder counts.
    expect(changedPlatformOwnedFields(current(), { topicBoundaries: ['y', 'x'] })).toEqual([
      'topicBoundaries',
    ]);
  });

  it('treats null and a value as different, both ways', () => {
    expect(changedPlatformOwnedFields(current({ persona: null }), { persona: 'x' })).toEqual([
      'persona',
    ]);
    expect(changedPlatformOwnedFields(current({ persona: 'x' }), { persona: null })).toEqual([
      'persona',
    ]);
  });
});

describe('assertPlatformOwnedFieldsUnchanged', () => {
  const system = { isSystem: true, name: 'Pattern Advisor' };

  it('throws a 403 naming the changed fields and what the org may change', () => {
    let thrown: unknown;
    try {
      assertPlatformOwnedFieldsUnchanged(system, current(), { temperature: 0.2, name: 'X' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ForbiddenError);
    const message = (thrown as ForbiddenError).message;
    expect(message).toContain('name, temperature are set by the platform');
    for (const field of platformAgentFieldNames('org')) expect(message).toContain(field);
  });

  it("never refuses an org's own agent", () => {
    expect(() =>
      assertPlatformOwnedFieldsUnchanged({ isSystem: false, name: 'Mine' }, current(), {
        temperature: 0.2,
      })
    ).not.toThrow();
  });

  it('lets an org-tunable-only write through on a system agent', () => {
    expect(() =>
      assertPlatformOwnedFieldsUnchanged(system, current(), { model: 'gpt-5' })
    ).not.toThrow();
  });
});

describe('bindings', () => {
  it('are locked on a platform-bound system agent', () => {
    expect(platformBindingsLocked({ isSystem: true, slug: 'pattern-advisor' })).toBe(true);
    expect(() =>
      assertBindingsEditable({ isSystem: true, slug: 'pattern-advisor', name: 'Pattern Advisor' })
    ).toThrow(ForbiddenError);
  });

  it("are the org's on mcp-system, whose definition says so", () => {
    expect(platformBindingsLocked({ isSystem: true, slug: 'mcp-system' })).toBe(false);
    expect(() =>
      assertBindingsEditable({ isSystem: true, slug: 'mcp-system', name: 'MCP' })
    ).not.toThrow();
  });

  it("follow the definition, not the slug: a fork can leave any agent's bindings to the org", () => {
    registerPlatformAgent({
      slug: 'intake-triage',
      audience: 'every-org',
      agent: {
        name: 'Intake',
        description: 'Fork agent',
        systemInstructions: 'x',
        temperature: 0.2,
        maxTokens: 10,
      },
      capabilities: [],
      capabilityBindings: 'org',
      knowledgeTags: [],
    });
    expect(platformBindingsLocked({ isSystem: true, slug: 'intake-triage' })).toBe(false);
  });

  it('stay locked on a retired system agent with no definition', () => {
    expect(platformBindingsLocked({ isSystem: true, slug: 'retired-agent' })).toBe(true);
  });

  it("are never locked on an org's own agent, even one holding a platform slug", () => {
    expect(platformBindingsLocked({ isSystem: false, slug: 'pattern-advisor' })).toBe(false);
  });
});

describe('platformAgentEditPolicy', () => {
  it('gives a system agent the registry split and its bindings answer', () => {
    expect(platformAgentEditPolicy({ isSystem: true, slug: 'mcp-system' })).toEqual({
      lockedFields: platformAgentFieldNames('code'),
      tunableFields: platformAgentFieldNames('org'),
      bindingsLocked: false,
    });
  });

  it("is null for an org's own agent", () => {
    expect(platformAgentEditPolicy({ isSystem: false, slug: 'mine' })).toBeNull();
  });
});

describe('reserved slugs', () => {
  it.each(['pattern-advisor', 'mcp-system', 'eval-judge-relevance', 'cleanup-agent'])(
    'reserves the every-org slug %s',
    (slug) => {
      expect(isReservedAgentSlug(slug)).toBe(true);
    }
  );

  it('reserves install-only slugs too, in every org', () => {
    expect(isReservedAgentSlug('provider-model-auditor')).toBe(true);
    expect(isReservedAgentSlug('audit-report-writer')).toBe(true);
  });

  it('leaves every other slug free', () => {
    expect(isReservedAgentSlug('pattern-advisor-copy')).toBe(false);
    expect(isReservedAgentSlug('my-agent')).toBe(false);
  });

  it("reserves a fork's registered slug", () => {
    expect(isReservedAgentSlug('intake-triage')).toBe(false);
    registerPlatformAgent({
      slug: 'intake-triage',
      audience: 'every-org',
      agent: {
        name: 'Intake',
        description: 'Fork agent',
        systemInstructions: 'x',
        temperature: 0.2,
        maxTokens: 10,
      },
      capabilities: [],
      knowledgeTags: [],
    });
    expect(isReservedAgentSlug('intake-triage')).toBe(true);
  });

  it('refuses a reserved slug as a validation error on the slug field', () => {
    let thrown: unknown;
    try {
      assertAgentSlugNotReserved('quiz-master');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).details).toEqual({
      slug: ['The slug "quiz-master" is reserved for a platform agent'],
    });
    expect(() => assertAgentSlugNotReserved('quiz-master-2')).not.toThrow();
  });
});
