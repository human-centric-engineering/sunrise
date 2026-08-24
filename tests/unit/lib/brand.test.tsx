/**
 * Brand seam resolution (#305, #519, #661)
 *
 * `BRAND` resolves from `lib/app/brand.ts`, a committed fork-owned file. The
 * `NEXT_PUBLIC_*` vars this used to read were removed in #661 — inlined at build
 * time, delivered by no container build, so a configured fork still shipped
 * "Sunrise".
 *
 * ## Why these call a function instead of mocking a module
 *
 * The seam is read at module scope, so an earlier version of this file drove each
 * case with `vi.doMock` + `vi.resetModules()` + a dynamic re-import. That races
 * whatever already holds an evaluated copy of `@/lib/brand`: it failed about one
 * run in three locally and took out a CI shard. `resolveBrand()` is the same
 * logic as a pure function, so these are deterministic by construction.
 *
 * The wiring — that `BRAND` really is `resolveBrand()` applied to the seam, and
 * that the result reaches a rendered surface — lives in
 * `tests/unit/emails/brand-wiring.test.tsx`, which mocks the seam to a
 * distinctive value. Asserting it here under the suite-wide null pin would only
 * have shown that `resolveBrand(nulls)` returns the defaults.
 */

import { describe, it, expect } from 'vitest';
import { resolveBrand } from '@/lib/brand';

describe('resolveBrand — name', () => {
  it('falls back to "Sunrise" when the seam is null', () => {
    expect(resolveBrand({ name: null, legalName: null, description: null }).name).toBe('Sunrise');
  });

  it('falls back to "Sunrise" when the seam is only whitespace', () => {
    expect(resolveBrand({ name: '   ', legalName: null, description: null }).name).toBe('Sunrise');
  });

  it('uses a custom name verbatim', () => {
    expect(resolveBrand({ name: 'Acme', legalName: null, description: null }).name).toBe('Acme');
  });

  it('trims surrounding whitespace', () => {
    expect(resolveBrand({ name: '  Acme Corp  ', legalName: null, description: null }).name).toBe(
      'Acme Corp'
    );
  });
});

describe('resolveBrand — legalName', () => {
  it('uses the legal name verbatim when set, distinct from the product', () => {
    expect(
      resolveBrand({ name: 'ConQuest', legalName: 'All Too Human Ltd', description: null })
        .legalName
    ).toBe('All Too Human Ltd');
  });

  it('trims surrounding whitespace', () => {
    expect(
      resolveBrand({ name: 'ConQuest', legalName: '  All Too Human Ltd  ', description: null })
        .legalName
    ).toBe('All Too Human Ltd');
  });

  it('falls back to the RESOLVED product name when unset', () => {
    expect(resolveBrand({ name: 'ConQuest', legalName: null, description: null }).legalName).toBe(
      'ConQuest'
    );
  });

  it('falls back to the resolved product name when only whitespace', () => {
    expect(resolveBrand({ name: 'ConQuest', legalName: '   ', description: null }).legalName).toBe(
      'ConQuest'
    );
  });

  it('falls back to the TRIMMED name — the resolved value, not the raw seam', () => {
    // The distinguishing case. Every other fallback row uses an already-trimmed
    // name, so they cannot tell `|| name` (resolved) from `|| seam.name` (raw) —
    // a mutation to the latter passed all of them. Both derived fields inherit
    // the trim precisely because they fall back to the resolved product name.
    const brand = resolveBrand({ name: '  Acme Corp  ', legalName: null, description: null });
    expect(brand.legalName).toBe('Acme Corp');
    expect(brand.description).toBe('Acme Corp');
  });

  it('falls back to "Sunrise" when neither is set', () => {
    expect(resolveBrand({ name: null, legalName: null, description: null }).legalName).toBe(
      'Sunrise'
    );
  });
});

describe('resolveBrand — description', () => {
  it('uses the description verbatim when set', () => {
    expect(
      resolveBrand({ name: 'Acme', legalName: null, description: 'Everything your team needs' })
        .description
    ).toBe('Everything your team needs');
  });

  it('falls back to the product name, not to a sentence', () => {
    expect(resolveBrand({ name: 'Acme', legalName: null, description: null }).description).toBe(
      'Acme'
    );
  });

  it('never returns the starter blurb (#519 — the whole point of the seam)', () => {
    // The old hardcoded root description shipped from every fork that had not
    // edited app/layout.tsx. Assert on the substring, not the whole sentence, so
    // a reworded blurb cannot sneak back in.
    for (const seam of [
      { name: 'Acme', legalName: null, description: null },
      { name: null, legalName: null, description: null },
    ]) {
      expect(resolveBrand(seam).description).not.toMatch(/starter template/i);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(
      resolveBrand({ name: 'Acme', legalName: null, description: '  Spaced out  ' }).description
    ).toBe('Spaced out');
  });
});
