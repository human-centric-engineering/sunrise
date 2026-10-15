/**
 * uniqueViolation / isUniqueViolationOn (t-796).
 *
 * The first case is the error object Prisma 7's driver adapter threw when the
 * dev DB was made to collide on `ai_agent_orgId_slug_key`, copied verbatim.
 * It has no `meta.target`, which is why every `meta.target` reader was wrong.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  isUniqueViolationOn,
  uniqueViolation,
  UNIQUE_CONSTRAINTS,
} from '@/lib/db/unique-violation';
import { uniqueViolationError } from '@/tests/helpers/prisma-errors';

function p2002(meta: Record<string, unknown> | undefined) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.0.0',
    meta,
  });
}

/** Captured from the dev DB: `prisma.aiAgent.update` onto another agent's slug. */
const MEASURED_AGENT_SLUG_META = {
  driverAdapterError: {
    name: 'DriverAdapterError',
    cause: {
      originalCode: '23505',
      originalMessage: 'duplicate key value violates unique constraint "ai_agent_orgId_slug_key"',
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'ai_agent_orgId_slug_key' },
      table: 'ai_agent',
    },
  },
  modelName: 'AiAgent',
};

describe('uniqueViolation', () => {
  it('reads the index name from a measured driver-adapter P2002', () => {
    const err = p2002(MEASURED_AGENT_SLUG_META);
    expect(err.meta?.target).toBeUndefined();
    expect(uniqueViolation(err)).toEqual({
      modelName: 'AiAgent',
      index: 'ai_agent_orgId_slug_key',
      fields: null,
    });
  });

  it('reads the columns when the adapter reports fields instead of a name', () => {
    const err = p2002({
      modelName: 'AiWorkflowExecution',
      // adapter-pg copies Postgres's `Key ("dedupKey")=...` detail, quotes included.
      driverAdapterError: { cause: { constraint: { fields: ['"dedupKey"'] } } },
    });
    expect(uniqueViolation(err)).toEqual({
      modelName: 'AiWorkflowExecution',
      index: null,
      fields: ['dedupKey'],
    });
  });

  it('falls back to a legacy meta.target field list or constraint name', () => {
    expect(uniqueViolation(p2002({ target: ['email'] }))).toEqual({
      modelName: null,
      index: null,
      fields: ['email'],
    });
    expect(uniqueViolation(p2002({ target: 'user_email_key' }))).toEqual({
      modelName: null,
      index: 'user_email_key',
      fields: null,
    });
  });

  it('names nothing when meta is missing or malformed, but still reports the P2002', () => {
    const empty = { modelName: null, index: null, fields: null };
    expect(uniqueViolation(p2002(undefined))).toEqual(empty);
    expect(uniqueViolation(p2002({ target: 123 }))).toEqual(empty);
  });

  it('keeps the adapter constraint when a stray meta.target is malformed', () => {
    const err = p2002({ ...MEASURED_AGENT_SLUG_META, target: 123 });
    expect(uniqueViolation(err)?.index).toBe('ai_agent_orgId_slug_key');
  });

  it('keeps modelName when the adapter error has a shape it does not know', () => {
    const err = p2002({
      modelName: 'AiAgent',
      driverAdapterError: { cause: { constraint: null } },
    });
    expect(uniqueViolation(err)).toEqual({ modelName: 'AiAgent', index: null, fields: null });
  });

  it('is null for anything that is not a P2002', () => {
    const p2025 = new Prisma.PrismaClientKnownRequestError('Not found', {
      code: 'P2025',
      clientVersion: '7.0.0',
    });
    expect(uniqueViolation(p2025)).toBeNull();
    expect(uniqueViolation(new Error('P2002'))).toBeNull();
    expect(uniqueViolation({ code: 'P2002' })).toBeNull();
  });
});

describe('isUniqueViolationOn', () => {
  it('matches the measured error on its own constraint and no other', () => {
    const err = p2002(MEASURED_AGENT_SLUG_META);
    expect(isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.agentSlug)).toBe(true);
    expect(isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.knowledgeDocumentSlug)).toBe(false);
  });

  it('does not match a primary-key collision on the same table', () => {
    const err = uniqueViolationError({ index: 'ai_agent_pkey', modelName: 'AiAgent' });
    expect(isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.agentSlug)).toBe(false);
  });

  const fields = (f: string[], modelName?: string) =>
    p2002({ modelName, driverAdapterError: { cause: { constraint: { fields: f } } } });

  it('matches reported fields on the same model as a set, in any order, and not a subset', () => {
    const agent = (f: string[]) => fields(f, 'AiAgent');
    expect(isUniqueViolationOn(agent(['slug', '"orgId"']), UNIQUE_CONSTRAINTS.agentSlug)).toBe(
      true
    );
    expect(isUniqueViolationOn(agent(['slug']), UNIQUE_CONSTRAINTS.agentSlug)).toBe(false);
    expect(
      isUniqueViolationOn(agent(['orgId', 'slug', 'name']), UNIQUE_CONSTRAINTS.agentSlug)
    ).toBe(false);
  });

  it("does not match another table's key on the same columns, or a columns-only error with no model", () => {
    const docSlug = fields(['orgId', 'slug'], 'AiKnowledgeDocument');
    expect(isUniqueViolationOn(docSlug, UNIQUE_CONSTRAINTS.knowledgeDocumentSlug)).toBe(true);
    expect(isUniqueViolationOn(docSlug, UNIQUE_CONSTRAINTS.agentSlug)).toBe(false);
    expect(isUniqueViolationOn(fields(['orgId', 'slug']), UNIQUE_CONSTRAINTS.agentSlug)).toBe(
      false
    );
  });

  it('is false when the P2002 names no constraint at all', () => {
    expect(isUniqueViolationOn(p2002(undefined), UNIQUE_CONSTRAINTS.userEmail)).toBe(false);
  });
});
