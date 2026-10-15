/**
 * Tests: which pages the org-tier roster names (§111 t-810)
 *
 * A pattern names one page: segment for segment, `[x]` taking any one
 * segment, and never the pages below it. Everything it does not name is the
 * platform's, including a missing pathname.
 */
import { describe, it, expect } from 'vitest';
import {
  adminPageTier,
  matchesAdminPagePattern,
  ORG_TIER_ADMIN_PAGES,
  viewerReaches,
} from '@/lib/auth/admin-tier';

describe('matchesAdminPagePattern', () => {
  it.each([
    ['/admin/orchestration/agents', '/admin/orchestration/agents', true],
    ['/admin/orchestration/agents', '/admin/orchestration/agents/', true],
    ['/admin/orchestration/agents/[id]', '/admin/orchestration/agents/agent-1', true],
    ['/admin/orchestration/agents/[id]/edit', '/admin/orchestration/agents/a1/edit', true],
  ])('%s names %s', (pattern, pathname, expected) => {
    expect(matchesAdminPagePattern(pattern, pathname)).toBe(expected);
  });

  it.each([
    // Not the pages below it: a sub-page added later is the platform's until listed.
    ['/admin/orchestration/agents', '/admin/orchestration/agents/new'],
    // Not the page above it.
    ['/admin/orchestration/agents/[id]', '/admin/orchestration/agents'],
    // A dynamic segment takes one segment, and not an empty one.
    ['/admin/orchestration/agents/[id]', '/admin/orchestration/agents/a1/edit'],
    ['/admin/orchestration/agents/[id]/edit', '/admin/orchestration/agents//edit'],
    // A literal segment is a literal: no prefix match.
    ['/admin/orchestration/agents', '/admin/orchestration/agents-archive'],
    // A catch-all is not a pattern this roster takes, so it names nothing.
    ['/admin/[...rest]', '/admin/users'],
  ])('%s does not name %s', (pattern, pathname) => {
    expect(matchesAdminPagePattern(pattern, pathname)).toBe(false);
  });
});

describe('adminPageTier', () => {
  const pages = ['/admin/orchestration/agents'];

  it('is org for a listed page and the platform’s (null) for anything else', () => {
    expect(adminPageTier('/admin/orchestration/agents', pages)).toBe('org');
    expect(adminPageTier('/admin/users', pages)).toBeNull();
  });

  it('is the platform’s for a missing pathname: an unknown page is the one that must not open', () => {
    expect(adminPageTier(null, pages)).toBeNull();
    expect(adminPageTier(undefined, pages)).toBeNull();
    expect(adminPageTier('', pages)).toBeNull();
  });

  it('reads the shipped roster by default: the customer’s pages are the org’s, the platform’s are not (t-811)', () => {
    // What the roster holds is pinned in tests/unit/scripts/ci/admin-tier-roster.test.ts.
    expect(ORG_TIER_ADMIN_PAGES).toContain('/admin/orchestration/agents/[id]');
    expect(adminPageTier('/admin/orchestration/agents')).toBe('org');
    expect(adminPageTier('/admin/orchestration/agents/cmagent00000000000000001')).toBe('org');
    expect(adminPageTier('/admin/orchestration/providers')).toBeNull();
    expect(adminPageTier('/admin/orchestration/knowledge/tags')).toBeNull();
    expect(adminPageTier('/admin/users')).toBeNull();
  });
});

describe('viewerReaches', () => {
  it('lets a platform viewer reach every surface and an org viewer the org-tier ones only', () => {
    expect(viewerReaches('platform', null)).toBe(true);
    expect(viewerReaches('platform', 'org')).toBe(true);
    expect(viewerReaches('org', 'org')).toBe(true);
    expect(viewerReaches('org', null)).toBe(false);
    expect(viewerReaches('org', undefined)).toBe(false);
  });
});
