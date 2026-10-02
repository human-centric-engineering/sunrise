/**
 * Tests: lib/orchestration/workflows/slug-availability.ts (§107 t-728)
 *
 * `AiWorkflow.slug` is unique across the install, and at `multi` a plain read
 * cannot see another org's workflows. What is pinned: the probe runs under
 * the system scope (so the policy does not hide another org's slug), returns
 * only a boolean, and the free-slug search suffixes until no org holds one.
 * The policy itself is proven by the two-org smoke against Postgres.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ aiWorkflow: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: db }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  findFreeWorkflowSlug,
  isWorkflowSlugTaken,
  WORKFLOW_SLUG_MAX_LENGTH,
} from '@/lib/orchestration/workflows/slug-availability';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';

/** Slugs some org holds; records the scope each probe ran in. */
function held(...slugs: string[]) {
  const scopes: Array<string | null | undefined> = [];
  db.aiWorkflow.findUnique.mockImplementation(async (args: { where: { slug: string } }) => {
    const ctx = getTenantContext();
    scopes.push(ctx?.source === 'system' ? 'system' : ctx?.orgId);
    return slugs.includes(args.where.slug) ? { id: `id-${args.where.slug}` } : null;
  });
  return scopes;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isWorkflowSlugTaken', () => {
  it('answers true for a slug some org holds, false otherwise', async () => {
    held('taken');

    expect(await isWorkflowSlugTaken('taken')).toBe(true);
    expect(await isWorkflowSlugTaken('free')).toBe(false);
  });

  it('asks under the system scope, even from inside an org', async () => {
    const scopes = held('taken');

    await runAsOrg('cmorg0000000000000000orgb', () => isWorkflowSlugTaken('taken'));

    expect(scopes).toEqual(['system']);
  });

  it('selects nothing but the id', async () => {
    held();

    await isWorkflowSlugTaken('x');

    expect(db.aiWorkflow.findUnique).toHaveBeenCalledWith({
      where: { slug: 'x' },
      select: { id: true },
    });
  });
});

describe('findFreeWorkflowSlug', () => {
  it('returns the base when no org holds it', async () => {
    held();

    expect(await findFreeWorkflowSlug('support-template')).toBe('support-template');
  });

  it('suffixes past every slug an org holds, probing each under the system scope', async () => {
    const scopes = held('support-template', 'support-template-1');

    const slug = await runAsOrg('cmorg0000000000000000orgb', () =>
      findFreeWorkflowSlug('support-template')
    );

    expect(slug).toBe('support-template-2');
    expect(scopes).toEqual(['system', 'system', 'system']);
  });

  it('cuts a long base so every candidate fits the cap the API validates against', async () => {
    const base = `${'a'.repeat(95)}-template`; // 104 characters
    held(base.slice(0, WORKFLOW_SLUG_MAX_LENGTH));

    const slug = await findFreeWorkflowSlug(base);

    expect(slug).toBe(`${'a'.repeat(95)}-te-1`);
    expect(slug).toHaveLength(WORKFLOW_SLUG_MAX_LENGTH);
  });

  it('leaves no hyphen dangling where the cut lands', async () => {
    held();

    // The cut at 100 lands just after a hyphen.
    expect(await findFreeWorkflowSlug(`${'a'.repeat(99)}-bcd`)).toBe('a'.repeat(99));
  });

  it('leaves a base within the cap untouched', async () => {
    held('short-template');

    expect(await findFreeWorkflowSlug('short-template')).toBe('short-template-1');
  });
});
