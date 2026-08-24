/**
 * The removed brand env vars are reported on an un-migrated upgrade (#661).
 *
 * `NEXT_PUBLIC_APP_NAME` / `_LEGAL_NAME` / `_APP_DESCRIPTION` were removed when
 * brand identity moved to `lib/app/brand.ts`. `clientEnvSchema` is not strict, so
 * Zod strips a leftover rather than rejecting it: an upgrading fork gets no
 * error, no build warning and no log, and simply finds its brand back to
 * "Sunrise" on a deployed site. A fork on Vercel is the sharp case — there the
 * env vars genuinely did work before.
 *
 * The detection is a pure function so these cases can call it. Driving it by
 * mocking the seam and re-importing `lib/env.ts` is what turned a CI shard red:
 * that module reads the seam at import scope, so the mock raced an already
 * evaluated copy and the "stays silent" cases saw a warning anyway.
 */

import { describe, it, expect } from 'vitest';
import { findOrphanedBrandEnvVars } from '@/lib/env';

const NONE = { name: null, legalName: null, description: null };
const from = (env: Record<string, string>) => (name: string) => env[name];

describe('findOrphanedBrandEnvVars', () => {
  it('reports a var that is set while its seam field is empty', () => {
    expect(findOrphanedBrandEnvVars(from({ NEXT_PUBLIC_APP_NAME: 'ConQuest' }), NONE)).toEqual([
      'NEXT_PUBLIC_APP_NAME',
    ]);
  });

  it('reports every orphaned var, not just the first', () => {
    expect(
      findOrphanedBrandEnvVars(
        from({
          NEXT_PUBLIC_APP_NAME: 'ConQuest',
          NEXT_PUBLIC_LEGAL_NAME: 'All Too Human Ltd',
          NEXT_PUBLIC_APP_DESCRIPTION: 'A thing',
        }),
        NONE
      )
    ).toEqual(['NEXT_PUBLIC_APP_NAME', 'NEXT_PUBLIC_LEGAL_NAME', 'NEXT_PUBLIC_APP_DESCRIPTION']);
  });

  it('stays silent for a fork that has migrated, even with a stale .env line', () => {
    // The false-alarm case. A migrated fork is already correct, and warning at it
    // every boot is how the real warning gets tuned out.
    expect(
      findOrphanedBrandEnvVars(from({ NEXT_PUBLIC_APP_NAME: 'ConQuest' }), {
        ...NONE,
        name: 'ConQuest',
      })
    ).toEqual([]);
  });

  it('reports per field — migrating one does not silence the others', () => {
    expect(
      findOrphanedBrandEnvVars(
        from({ NEXT_PUBLIC_APP_NAME: 'ConQuest', NEXT_PUBLIC_LEGAL_NAME: 'All Too Human Ltd' }),
        { ...NONE, name: 'ConQuest' }
      )
    ).toEqual(['NEXT_PUBLIC_LEGAL_NAME']);
  });

  it('reports nothing when nothing is set', () => {
    expect(findOrphanedBrandEnvVars(from({}), NONE)).toEqual([]);
  });

  it('treats a whitespace-only env value as unset', () => {
    expect(findOrphanedBrandEnvVars(from({ NEXT_PUBLIC_APP_NAME: '   ' }), NONE)).toEqual([]);
  });

  it('treats a whitespace-only SEAM value as unset, so the var is still orphaned', () => {
    // `resolveBrand` trims the seam too: a whitespace seam resolves to "Sunrise",
    // so the fork is not actually migrated and does need telling.
    expect(
      findOrphanedBrandEnvVars(from({ NEXT_PUBLIC_APP_NAME: 'ConQuest' }), {
        ...NONE,
        name: '   ',
      })
    ).toEqual(['NEXT_PUBLIC_APP_NAME']);
  });
});

describe('the removed vars are absent from the parsed env', () => {
  it('does not appear on `env` even when set in process.env', async () => {
    // This file runs under NODE, so lib/env.ts takes the
    // `envSchema.safeParse(process.env)` branch and a re-declared schema entry
    // would put the var straight into the parsed object — which is what makes
    // this able to fail. The same assertion under happy-dom could not: there
    // parsing goes through the hand-written client MAPPING, so a schema-only
    // re-add is invisible and a mapping-only re-add is stripped by Zod.
    const { env } = await import('@/lib/env');
    expect(env).not.toHaveProperty('NEXT_PUBLIC_APP_NAME');
    expect(env).not.toHaveProperty('NEXT_PUBLIC_LEGAL_NAME');
    expect(env).not.toHaveProperty('NEXT_PUBLIC_APP_DESCRIPTION');
  });
});
