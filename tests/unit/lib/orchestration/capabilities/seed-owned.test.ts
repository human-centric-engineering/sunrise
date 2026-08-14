/**
 * Tests for `lib/orchestration/capabilities/seed-owned.ts`.
 *
 * Both write paths that guard system capabilities consult this module, and the
 * two ways it can be got wrong were both shipped and reverted once on #596:
 *
 * 1. gating on the field being PRESENT rather than on the value CHANGING —
 *    which 403s an admin who only edited the description, because the
 *    capability form PATCHes the whole form on every save;
 * 2. comparing `functionDefinition` with `JSON.stringify` — which 403s a save
 *    that changed nothing, because the same `jsonb` value comes back from
 *    Postgres and from Zod in two different key orders.
 *
 * The fixture below deliberately does NOT share a key order with the payloads
 * that are compared against it. Unit tests missed (2) the first time precisely
 * because the fixture and the payload had the same author and the same shape.
 *
 * @see lib/orchestration/capabilities/seed-owned.ts
 */

import { describe, it, expect } from 'vitest';

import {
  SEED_OWNED_CAPABILITY_FIELDS,
  changedSeedOwnedFields,
  type SeedOwnedCapabilityValues,
} from '@/lib/orchestration/capabilities/seed-owned';

/**
 * A stored system capability, with `functionDefinition` keys in the order
 * Postgres canonicalises `jsonb` to — shortest key first, then bytewise. That
 * is `name` (4), then `parameters` (10), then `description` (11).
 */
const STORED: SeedOwnedCapabilityValues = {
  slug: 'search_knowledge_base',
  functionDefinition: {
    name: 'search_knowledge_base',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', description: 'The search query' } },
    },
    description: 'Semantic search over the knowledge base.',
  },
  executionType: 'internal',
  executionHandler: 'SearchKnowledgeCapability',
};

/**
 * The same definition as the client sends it back: Zod rebuilds a parsed object
 * in schema-declaration order, which for `capabilityFunctionDefinitionSchema`
 * is `name`, `description`, `parameters` — a different order to STORED's.
 */
const ECHOED_DEFINITION = {
  name: 'search_knowledge_base',
  description: 'Semantic search over the knowledge base.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query' } },
    required: ['query'],
  },
};

describe('changedSeedOwnedFields — nothing changed', () => {
  it('returns nothing for an empty body', () => {
    expect(changedSeedOwnedFields(STORED, {})).toEqual([]);
  });

  it('returns nothing when the whole form is resubmitted unchanged', () => {
    // What the capability form actually sends when an admin edits only the
    // description: every seed-owned field present, none of them different.
    expect(
      changedSeedOwnedFields(STORED, {
        slug: STORED.slug,
        functionDefinition: ECHOED_DEFINITION,
        executionType: STORED.executionType,
        executionHandler: STORED.executionHandler,
      })
    ).toEqual([]);
  });

  it('returns nothing when only the key order of functionDefinition differs', () => {
    // The trap on its own. Assert the naive comparison would have fired, so
    // this test cannot pass for the wrong reason.
    expect(JSON.stringify(ECHOED_DEFINITION)).not.toBe(JSON.stringify(STORED.functionDefinition));
    expect(changedSeedOwnedFields(STORED, { functionDefinition: ECHOED_DEFINITION })).toEqual([]);
  });

  it('ignores fields that are not seed-owned', () => {
    expect(
      changedSeedOwnedFields(STORED, {
        // `executionConfig`, `name`, `rateLimit` and friends are the
        // operator's; they are not in the list and must never appear.
        ...({ name: 'Renamed', description: 'new', executionConfig: { a: 1 } } as Record<
          string,
          unknown
        >),
      })
    ).toEqual([]);
  });
});

describe('changedSeedOwnedFields — real changes', () => {
  it('reports a changed nested parameter', () => {
    const edited = {
      ...ECHOED_DEFINITION,
      parameters: { ...ECHOED_DEFINITION.parameters, required: ['query', 'topK'] },
    };

    expect(changedSeedOwnedFields(STORED, { functionDefinition: edited })).toEqual([
      'functionDefinition',
    ]);
  });

  it('reports a changed description inside functionDefinition', () => {
    // The LLM-facing description lives inside the JSON column and is seeded,
    // unlike the row's own `description` column, which the operator owns.
    expect(
      changedSeedOwnedFields(STORED, {
        functionDefinition: { ...ECHOED_DEFINITION, description: 'Something else' },
      })
    ).toEqual(['functionDefinition']);
  });

  it('reports a slug rename', () => {
    expect(changedSeedOwnedFields(STORED, { slug: 'search_kb' })).toEqual(['slug']);
  });

  it('reports a changed executionType and executionHandler', () => {
    expect(
      changedSeedOwnedFields(STORED, {
        executionType: 'api',
        executionHandler: 'https://example.com/hook',
      })
    ).toEqual(['executionType', 'executionHandler']);
  });

  it('reports every changed field, in the declared order', () => {
    expect(
      changedSeedOwnedFields(STORED, {
        executionHandler: 'OtherCapability',
        slug: 'renamed',
        functionDefinition: { ...ECHOED_DEFINITION, name: 'renamed' },
        executionType: 'api',
      })
    ).toEqual([...SEED_OWNED_CAPABILITY_FIELDS]);
  });
});

describe('changedSeedOwnedFields — edge cases', () => {
  it('reports a change when the stored definition is unparseable junk', () => {
    // A row whose JSON column holds something the schema cannot read is still
    // a row a write would change. Nothing here parses, so nothing can decide
    // the write is a no-op.
    const junk: SeedOwnedCapabilityValues = { ...STORED, functionDefinition: 'not-an-object' };

    expect(changedSeedOwnedFields(junk, { functionDefinition: ECHOED_DEFINITION })).toEqual([
      'functionDefinition',
    ]);
  });

  it('treats an explicit null functionDefinition as a change', () => {
    expect(changedSeedOwnedFields(STORED, { functionDefinition: null })).toEqual([
      'functionDefinition',
    ]);
  });

  it('covers exactly the four documented fields', () => {
    // A field added to the constant without a decision recorded in
    // `.context/database/seeding.md` should fail here first.
    expect([...SEED_OWNED_CAPABILITY_FIELDS]).toEqual([
      'slug',
      'functionDefinition',
      'executionType',
      'executionHandler',
    ]);
  });
});
