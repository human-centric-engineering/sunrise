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

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError, ValidationError } from '@/lib/api/errors';
import { platformAgentFieldNames } from '@/lib/orchestration/agents/agent-field-registry';
import {
  assertAgentSlugNotReserved,
  assertBindingFieldsUnchanged,
  assertBindingsEditable,
  assertPlatformOwnedFieldsUnchanged,
  bindingOwnerForPatch,
  changedPlatformOwnedFields,
  picksOwnBinding,
  isReservedAgentSlug,
  bindingFollowsPlatform,
  platformAgentEditPolicy,
  platformBindingsLocked,
  platformSlugWhere,
  platformSlugsWhere,
  type PlatformOwnedCurrentValues,
} from '@/lib/orchestration/agents/platform-agent-guard';
import {
  __resetPlatformAgentsForTests,
  registerPlatformAgent,
} from '@/lib/orchestration/agents/platform-agents';

// The registry these cases read is core's plus the registrations they make:
// the fork's seam is held empty, so a fork's own agents (the docs' example is
// `intake-triage`) do not change what they assert (#974).
vi.mock('@/lib/app/platform-agents', () => ({ initAppPlatformAgents: () => undefined }));

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
    // A repeated id grants nothing new: the write path skips duplicates.
    expect(
      changedPlatformOwnedFields(current(), { grantedTagIds: ['tag-a', 'tag-b', 'tag-b'] })
    ).toEqual([]);
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
    expect(
      platformAgentEditPolicy({ isSystem: true, slug: 'mcp-system', bindingOwner: null })
    ).toEqual({
      lockedFields: platformAgentFieldNames('code'),
      tunableFields: platformAgentFieldNames('org'),
      bindingsLocked: false,
      picksOwnBinding: false,
      bindingFollowsPlatform: false,
    });
  });

  it('says whether the platform picks the agent’s provider and model, and holds them now (t-818, t-821)', () => {
    const cleanup = (bindingOwner: string | null) =>
      platformAgentEditPolicy({ isSystem: true, slug: 'cleanup-agent', bindingOwner });
    expect(cleanup('platform')).toMatchObject({
      picksOwnBinding: true,
      bindingFollowsPlatform: true,
    });
    expect(cleanup('org')).toMatchObject({ picksOwnBinding: true, bindingFollowsPlatform: false });
    expect(cleanup(null)).toMatchObject({ picksOwnBinding: true, bindingFollowsPlatform: false });
    expect(
      platformAgentEditPolicy({ isSystem: true, slug: 'pattern-advisor', bindingOwner: 'platform' })
    ).toMatchObject({ picksOwnBinding: false, bindingFollowsPlatform: false });
  });

  it("is null for an org's own agent", () => {
    expect(
      platformAgentEditPolicy({ isSystem: false, slug: 'mine', bindingOwner: null })
    ).toBeNull();
  });
});

describe('bindingFollowsPlatform (t-821)', () => {
  it('holds only for an agent that picks its binding while the platform owns it', () => {
    expect(
      bindingFollowsPlatform({ isSystem: true, slug: 'cleanup-agent', bindingOwner: 'platform' })
    ).toBe(true);
    expect(
      bindingFollowsPlatform({ isSystem: true, slug: 'cleanup-agent', bindingOwner: 'org' })
    ).toBe(false);
    // A stray owner on an agent that does not pick its own binding counts for nothing.
    expect(
      bindingFollowsPlatform({ isSystem: false, slug: 'cleanup-agent', bindingOwner: 'platform' })
    ).toBe(false);
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

describe('binding fields', () => {
  const binding = { isEnabled: true };

  it('refuses switching a binding on or off, naming the field', () => {
    expect(() =>
      assertBindingFieldsUnchanged({ name: 'Judge' }, binding, { isEnabled: false })
    ).toThrow(/isEnabled on its capabilities is set by the platform/);
  });

  it('leaves custom config and rate limit to the org: the reconcile never writes them', () => {
    const body: Record<string, unknown> = {
      isEnabled: true,
      customConfig: { forcedUrl: 'https://x.test' },
      customRateLimit: 5,
    };
    expect(() => assertBindingFieldsUnchanged({ name: 'Judge' }, binding, body)).not.toThrow();
    expect(() => assertBindingFieldsUnchanged({ name: 'Judge' }, binding, {})).not.toThrow();
  });
});

describe('platformSlugWhere', () => {
  it('constrains a platform slug to system rows and leaves any other slug alone', () => {
    expect(platformSlugWhere('eval-case-generator')).toEqual({ isSystem: true });
    expect(platformSlugWhere('my-agent')).toEqual({});
  });
});

describe('platformSlugsWhere', () => {
  it("excludes an org's own agent under any platform slug in the list", () => {
    expect(platformSlugsWhere(['summarizer', 'quiz-master', 'cleanup-agent'])).toEqual({
      NOT: { slug: { in: ['quiz-master', 'cleanup-agent'] }, isSystem: false },
    });
  });

  it('adds nothing when no slug is a platform slug', () => {
    expect(platformSlugsWhere(['summarizer', 'triage'])).toEqual({});
  });
});

describe('picksOwnBinding (t-798)', () => {
  it('is true only for a platform agent whose definition leaves the binding to the pick', () => {
    expect(picksOwnBinding({ isSystem: true, slug: 'cleanup-agent' })).toBe(true);
    expect(picksOwnBinding({ isSystem: false, slug: 'cleanup-agent' })).toBe(false);
    expect(picksOwnBinding({ isSystem: true, slug: 'pattern-advisor' })).toBe(false);
  });

  it('is false for a definition that also sets its own starting binding', () => {
    registerPlatformAgent({
      slug: 'fork-picker',
      audience: 'every-org',
      agent: {
        name: 'Picker',
        description: 'Fork agent',
        systemInstructions: 'x',
        temperature: 0.2,
        maxTokens: 10,
      },
      capabilities: [],
      knowledgeTags: [],
      defaults: { provider: 'anthropic', model: 'claude' },
      defaultBinding: async () => ({ provider: 'openai', model: 'gpt-5' }),
    });
    expect(picksOwnBinding({ isSystem: true, slug: 'fork-picker' })).toBe(false);
  });
});

describe('bindingOwnerForPatch (t-798)', () => {
  // The clean-up agent picks its own binding; the Pattern Advisor does not.
  const cleanup = {
    isSystem: true,
    slug: 'cleanup-agent',
    provider: 'anthropic',
    model: 'claude',
    bindingOwner: 'platform',
  };

  it('makes the binding the org’s on a change, and leaves it alone otherwise', () => {
    expect(bindingOwnerForPatch(cleanup, { provider: 'openai' })).toBe('org');
    expect(bindingOwnerForPatch(cleanup, { provider: 'anthropic', model: 'claude' })).toBe(
      undefined
    );
    // Every other agent keeps no owner, whatever it writes.
    expect(
      bindingOwnerForPatch({ ...cleanup, isSystem: false, slug: 'mine' }, { model: 'x' })
    ).toBe(undefined);
  });

  it('hands the binding back, or takes it as it stands, when the body says so', () => {
    expect(
      bindingOwnerForPatch({ ...cleanup, bindingOwner: 'org' }, { bindingOwner: 'platform' })
    ).toBe('platform');
    expect(bindingOwnerForPatch(cleanup, { bindingOwner: 'org' })).toBe('org');
    // Already so: nothing to write.
    expect(bindingOwnerForPatch(cleanup, { bindingOwner: 'platform' })).toBe(undefined);
    // Taking it while changing it is consistent, so allowed.
    expect(bindingOwnerForPatch(cleanup, { bindingOwner: 'org', provider: 'openai' })).toBe('org');
  });

  it('ignores an echo of the stored owner, on any agent', () => {
    const mine = { ...cleanup, isSystem: false, slug: 'mine', bindingOwner: null };
    expect(bindingOwnerForPatch(mine, { bindingOwner: null })).toBe(undefined);
    expect(bindingOwnerForPatch(cleanup, { bindingOwner: 'platform' })).toBe(undefined);
  });

  it('reads a null owner as an echo, even one read before the row was classified', () => {
    expect(bindingOwnerForPatch(cleanup, { bindingOwner: null })).toBe(undefined);
    expect(bindingOwnerForPatch(cleanup, { bindingOwner: null, provider: 'openai' })).toBe('org');
  });

  it('refuses a hand-back in the same request that changes the binding', () => {
    expect(() =>
      bindingOwnerForPatch(
        { ...cleanup, bindingOwner: 'org' },
        { bindingOwner: 'platform', provider: 'openai' }
      )
    ).toThrow(ValidationError);
  });

  it('refuses an owner on an agent the platform does not pick a binding for', () => {
    expect(() =>
      bindingOwnerForPatch(
        { ...cleanup, slug: 'pattern-advisor', bindingOwner: null },
        { bindingOwner: 'platform' }
      )
    ).toThrow(ValidationError);
    expect(() =>
      bindingOwnerForPatch(
        { ...cleanup, isSystem: false, bindingOwner: null },
        { bindingOwner: 'platform' }
      )
    ).toThrow(ValidationError);
  });
});
