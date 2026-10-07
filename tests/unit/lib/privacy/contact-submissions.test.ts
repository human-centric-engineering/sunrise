/**
 * Unit tests for lib/privacy/contact-submissions.ts
 *
 * Contract under test: `contactSubmissionsOf(email)` is the one matcher
 * subject access and erasure share for `ContactSubmission`. It must match the
 * address exactly, in the form the contact route stores it (trimmed,
 * lower-cased), and never as a pattern — erasure deletes whatever it matches.
 */

import { describe, it, expect } from 'vitest';
import { contactSubmissionsOf } from '@/lib/privacy/contact-submissions';

describe('contactSubmissionsOf', () => {
  it('normalises the address the way the contact route stores it', () => {
    expect(contactSubmissionsOf('  Subject@Example.COM ')).toEqual({
      email: 'subject@example.com',
    });
  });

  it('matches `_` and `%` as literal characters — an equality, with no `mode`', () => {
    // `mode: 'insensitive'` compiles to an unescaped ILIKE, where `_` and `%`
    // are wildcards that reach a stranger's address. The filter must be a bare
    // string (Prisma's `=`), so assert the whole object, not just the value.
    expect(contactSubmissionsOf('a_b%c@example.com')).toStrictEqual({
      email: 'a_b%c@example.com',
    });
  });
});
