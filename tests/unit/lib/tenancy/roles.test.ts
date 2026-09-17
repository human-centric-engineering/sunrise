/**
 * Tests: lib/tenancy/roles.ts — the org-role vocabulary
 *
 * The `lib/auth/roles.test.ts` shape, for the same two reasons: the predicates
 * are simple, and the **import purity** is the property everything rests on —
 * `'use client'` components, seeds and smoke scripts all read this module, and
 * a single server-only import would break them at bundle time.
 *
 * Plus one thing the platform axis does not need: the list here and the Prisma
 * `OrgRole` enum are two spellings of one closed set, and nothing but this test
 * notices when they drift.
 *
 * @see lib/tenancy/roles.ts · prisma/schema/tenancy.prisma
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { OrgRole as PrismaOrgRole } from '@prisma/client';
import {
  ORG_ROLES,
  DEFAULT_ORG_ROLE,
  ORG_OWNER_ROLE,
  ORG_ADMIN_ROLE,
  isOrgRole,
  orgAdministers,
} from '@/lib/tenancy/roles';

describe('the vocabulary', () => {
  it('names the three roles, most privileged first', () => {
    expect(ORG_ROLES).toEqual(['OWNER', 'ADMIN', 'MEMBER']);
  });

  it('agrees with the Prisma enum, both ways', () => {
    // The schema is the enforcement (a fourth value is refused at the
    // database); this list is what code reads. Same set, or one of them lies.
    expect([...ORG_ROLES].sort()).toEqual(Object.values(PrismaOrgRole).sort());
  });

  it('names the default and the two administering roles from the list', () => {
    expect(ORG_ROLES).toContain(DEFAULT_ORG_ROLE);
    expect(ORG_ROLES).toContain(ORG_OWNER_ROLE);
    expect(ORG_ROLES).toContain(ORG_ADMIN_ROLE);
    expect(DEFAULT_ORG_ROLE).not.toBe(ORG_OWNER_ROLE);
  });
});

describe('isOrgRole', () => {
  it('narrows a known value', () => {
    for (const role of ORG_ROLES) expect(isOrgRole(role)).toBe(true);
  });

  it('rejects anything else, including the platform vocabulary spelled wrong', () => {
    expect(isOrgRole('owner')).toBe(false);
    expect(isOrgRole('USER')).toBe(false);
    expect(isOrgRole('')).toBe(false);
    expect(isOrgRole(null)).toBe(false);
    expect(isOrgRole(undefined)).toBe(false);
    expect(isOrgRole(1)).toBe(false);
  });
});

describe('orgAdministers', () => {
  it('is true for OWNER and ADMIN, false for MEMBER', () => {
    expect(orgAdministers(ORG_OWNER_ROLE)).toBe(true);
    expect(orgAdministers(ORG_ADMIN_ROLE)).toBe(true);
    expect(orgAdministers(DEFAULT_ORG_ROLE)).toBe(false);
  });

  it('is null-safe and false for an unknown value', () => {
    expect(orgAdministers(null)).toBe(false);
    expect(orgAdministers(undefined)).toBe(false);
    expect(orgAdministers('SUPERUSER')).toBe(false);
  });
});

describe('import purity — what makes this module usable everywhere', () => {
  const source = readFileSync(path.join(process.cwd(), 'lib/tenancy/roles.ts'), 'utf8');

  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g)]
    .map((m) => m[1] ?? m[2])
    .filter((s): s is string => typeof s === 'string');

  it('imports nothing at all', () => {
    // Not even lib/auth/roles.ts: a shared constant would invite
    // `isPlatformAdmin(member)` to mean something it does not.
    expect(specifiers).toEqual([]);
  });

  it('names no server-only or framework module', () => {
    const forbidden = /^(@prisma\/|better-auth|next\/|next$|@\/lib\/db|@\/lib\/logging)/;
    expect(specifiers.filter((s) => forbidden.test(s))).toEqual([]);
  });
});
