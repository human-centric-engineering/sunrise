/**
 * Tests: the subject manifest's `OrgMembership` source carries the
 * membership's named-tier grant (t-1123).
 *
 * `OrgMembershipGrant` has no `userId` of its own, so the manifest's coverage
 * guard (which finds models by their `User` relation) cannot see it. The
 * grant is part of the membership the subject is entitled to, and this pins
 * that it rides along in that source's read.
 */
import { describe, it, expect, vi } from 'vitest';

const prismaMock = vi.hoisted(() => ({ orgMembership: { findMany: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: prismaMock }));

const { SUBJECT_DATA_SOURCES } = await import('@/lib/privacy/export-sources');

describe('the OrgMembership subject source (t-1123)', () => {
  it('exports the subject’s memberships with the org’s name and each one’s tier grant', async () => {
    const row = {
      id: 'm1',
      role: 'MEMBER',
      org: { id: 'o1', slug: 'acme', name: 'Acme' },
      grant: { tiers: ['media'], createdAt: new Date(), updatedAt: new Date() },
    };
    prismaMock.orgMembership.findMany.mockResolvedValue([row]);
    const source = SUBJECT_DATA_SOURCES.find((candidate) => candidate.model === 'OrgMembership');

    const rows = await source!.fetch({
      userId: 'u1',
      email: 'u1@example.com',
      emailVerified: true,
    });

    expect(prismaMock.orgMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
        include: {
          org: { select: { id: true, slug: true, name: true } },
          grant: { select: { tiers: true, createdAt: true, updatedAt: true } },
        },
      })
    );
    expect(rows).toEqual([row]);
    expect(source!.disposition).toBe('export');
  });
});
