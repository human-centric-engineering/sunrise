/**
 * Unit tests for lib/privacy/contact-submissions.ts
 *
 * Contract under test: `contactSubmissionsOf(subject)` is the one matcher
 * subject access and erasure share for `ContactSubmission`. It must match the
 * address exactly, in the form the contact route stores it (trimmed,
 * lower-cased), never as a pattern — erasure deletes whatever it matches — and
 * only for an account that has verified the address.
 */

import { describe, it, expect } from 'vitest';
import { contactSubmissionsOf } from '@/lib/privacy/contact-submissions';

describe('contactSubmissionsOf', () => {
  it('normalises a verified address the way the contact route stores it', () => {
    expect(contactSubmissionsOf({ email: '  Subject@Example.COM ', emailVerified: true })).toEqual({
      email: 'subject@example.com',
    });
  });

  it('matches `_` and `%` as literal characters — an equality, with no `mode`', () => {
    // `mode: 'insensitive'` compiles to an unescaped ILIKE, where `_` and `%`
    // are wildcards that reach a stranger's address. The filter must be a bare
    // string (Prisma's `=`), so assert the whole object, not just the value.
    expect(contactSubmissionsOf({ email: 'a_b%c@example.com', emailVerified: true })).toStrictEqual(
      { email: 'a_b%c@example.com' }
    );
  });

  it('matches nothing for an unverified address — the form proves nothing about who typed it', () => {
    // With verification off, anyone can hold an account under someone else's
    // address; matching would hand over or delete that person's messages.
    expect(contactSubmissionsOf({ email: 'subject@example.com', emailVerified: false })).toBeNull();
  });
});
