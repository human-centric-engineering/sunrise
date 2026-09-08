/**
 * Tests: lib/auth/roles.ts — the role vocabulary
 *
 * Two jobs here, and the second is the one that is easy to lose.
 *
 * The predicates are straightforward. The **import purity** of the module is
 * not, and it is the property the whole design rests on: several of the sites
 * that read this module are `'use client'` components, and others are Prisma
 * seeds and standalone smoke scripts. A single `import { prisma }` or
 * `next/headers` added here would break all of them at once, and would do it at
 * bundle time rather than at type-check — which is exactly why
 * `lib/auth/api-key-scopes.ts` had to be split out of `lib/auth/api-keys.ts`
 * in the first place. So the constraint is asserted, not left as a docblock
 * promise.
 *
 * @see lib/auth/roles.ts · lib/auth/account.ts (the sibling axis, same shape)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  USER_ROLES,
  DEFAULT_USER_ROLE,
  PLATFORM_ADMIN_ROLE,
  isUserRole,
  isPlatformAdmin,
  roleLabel,
} from '@/lib/auth/roles';

describe('the vocabulary', () => {
  it('names the two roles the schema ships with', () => {
    expect([...USER_ROLES]).toEqual(['USER', 'ADMIN']);
  });

  it('points its named constants at members of that list', () => {
    // Guards against the constants drifting away from the list they describe —
    // a renamed role that updated USER_ROLES and not PLATFORM_ADMIN_ROLE would
    // leave every guard comparing against a value no user can hold, which fails
    // open to "nobody is an admin" rather than loudly.
    expect(USER_ROLES).toContain(DEFAULT_USER_ROLE);
    expect(USER_ROLES).toContain(PLATFORM_ADMIN_ROLE);
    expect(DEFAULT_USER_ROLE).not.toBe(PLATFORM_ADMIN_ROLE);
  });
});

describe('isUserRole', () => {
  it('accepts every known role', () => {
    for (const role of USER_ROLES) expect(isUserRole(role)).toBe(true);
  });

  it('rejects values that merely look like one', () => {
    // Case and whitespace matter: `role` is compared with `===` everywhere, so
    // a lax guard here would hand a caller a value that then matches nothing.
    expect(isUserRole('admin')).toBe(false);
    expect(isUserRole('ADMIN ')).toBe(false);
    expect(isUserRole('MODERATOR')).toBe(false);
  });

  it('rejects non-strings rather than coercing them', () => {
    // The reason it takes `unknown`: `UserCreateData` types `role` through an
    // index signature, and the better-auth session field is untyped on the
    // client. Both reach this with something that is not necessarily a string.
    expect(isUserRole(null)).toBe(false);
    expect(isUserRole(undefined)).toBe(false);
    expect(isUserRole(0)).toBe(false);
    expect(isUserRole(['ADMIN'])).toBe(false);
  });
});

describe('isPlatformAdmin', () => {
  it('is true only for the platform-admin role', () => {
    expect(isPlatformAdmin({ role: PLATFORM_ADMIN_ROLE })).toBe(true);
    expect(isPlatformAdmin({ role: DEFAULT_USER_ROLE })).toBe(false);
  });

  it('is false for a principal with no role at all', () => {
    // The absent-role cases are the ones that matter: a truthiness check here
    // would make an unrecognised or missing role read as "not admin" by luck
    // rather than by rule, and a future `role: 'ADMINISTRATOR'` would flip it.
    expect(isPlatformAdmin({})).toBe(false);
    expect(isPlatformAdmin({ role: null })).toBe(false);
    expect(isPlatformAdmin({ role: 'ADMINISTRATOR' })).toBe(false);
  });

  it('is null-safe, because call sites read through an optional session', () => {
    // `session?.user` is the real shape at three call sites. If this threw, each
    // would need its own guard, and the one that forgot would be a 500 rather
    // than a denial.
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin(undefined)).toBe(false);
  });
});

describe('roleLabel', () => {
  it('title-cases a role for display', () => {
    expect(roleLabel('USER')).toBe('User');
    expect(roleLabel('ADMIN')).toBe('Admin');
  });

  it('derives the label rather than looking it up, so a new role needs no table', () => {
    // The property the admin form's select depends on. Cast because the point
    // is behaviour for a value not yet in the union — a table-driven
    // implementation would return undefined here and render a blank option.
    expect(roleLabel('MODERATOR' as (typeof USER_ROLES)[number])).toBe('Moderator');
  });
});

describe('import purity — what makes this module usable everywhere', () => {
  const source = readFileSync(path.join(process.cwd(), 'lib/auth/roles.ts'), 'utf8');

  /** Import specifiers, from `import … from 'x'` and `import('x')` alike. */
  const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g)]
    .map((m) => m[1] ?? m[2])
    .filter((s): s is string => typeof s === 'string');

  it('imports nothing at all', () => {
    // Stronger than "imports nothing forbidden", and deliberately so: this is a
    // list of two string constants and three pure functions, so any import is a
    // change of kind worth a second look rather than a line to wave through.
    expect(specifiers).toEqual([]);
  });

  it('names no server-only or framework module', () => {
    // The assertion above already covers today. This one states the actual rule,
    // so that if an import is ever legitimately added, the constraint that
    // matters is still checked rather than silently deleted with the row above.
    const forbidden = /^(@prisma\/|better-auth|next\/|next$|@\/lib\/db|@\/lib\/logging)/;
    expect(specifiers.filter((s) => forbidden.test(s))).toEqual([]);
  });
});
