/**
 * Tests: every NEXT_PUBLIC_* has a build-time delivery path (#662).
 *
 * The logic is pure functions taking file CONTENTS, so these call them with
 * literals rather than mocking the filesystem — deterministic, and the failure
 * points at the rule rather than at a fixture.
 */

import { describe, it, expect } from 'vitest';
import {
  scanClientEnvVars,
  scanUninlinableReads,
  findDeliveryGaps,
} from '@/scripts/ci/client-env-delivery';

const wired = (v: string) => `ARG ${v}\nENV ${v}=$${v}\n`;
const composed = (v: string) => `        - ${v}=\${${v}}\n`;

describe('scanClientEnvVars', () => {
  it('finds the static member-expression form the compiler inlines', () => {
    expect(scanClientEnvVars(['const a = process.env.NEXT_PUBLIC_POSTHOG_KEY;'])).toEqual([
      'NEXT_PUBLIC_POSTHOG_KEY',
    ]);
  });

  it('deduplicates across files and sorts', () => {
    expect(
      scanClientEnvVars([
        'process.env.NEXT_PUBLIC_SENTRY_DSN',
        'process.env.NEXT_PUBLIC_APP_URL; process.env.NEXT_PUBLIC_SENTRY_DSN',
      ])
    ).toEqual(['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SENTRY_DSN']);
  });

  it('ignores server vars — they are runtime reads and must not become build args', () => {
    expect(scanClientEnvVars(['process.env.RESEND_API_KEY; process.env.DATABASE_URL'])).toEqual([]);
  });

  it('ignores a mention inside a line comment', () => {
    // `lib/errors/sentry.ts` documents this var in three @example lines. A fork
    // that deletes the last real read but keeps the docblock would otherwise be
    // told to wire a build arg for something nothing consumes.
    expect(scanClientEnvVars(['// see process.env.NEXT_PUBLIC_SENTRY_DSN'])).toEqual([]);
  });

  it('ignores a mention inside a block comment', () => {
    expect(scanClientEnvVars(['/**\n * process.env.NEXT_PUBLIC_SENTRY_DSN\n */'])).toEqual([]);
  });

  it('still finds a real read on a line that also has a trailing comment', () => {
    expect(scanClientEnvVars(['const k = process.env.NEXT_PUBLIC_POSTHOG_KEY; // key'])).toEqual([
      'NEXT_PUBLIC_POSTHOG_KEY',
    ]);
  });

  it('does not match bracket access, which the compiler cannot inline either', () => {
    // The soundness argument for the whole check: what this misses, Next misses.
    expect(scanClientEnvVars(["process.env['NEXT_PUBLIC_POSTHOG_KEY']"])).toEqual([]);
  });
});

describe('scanUninlinableReads', () => {
  it('reports bracket access separately, since a build arg would not help', () => {
    expect(scanUninlinableReads(["process.env['NEXT_PUBLIC_GA4_MEASUREMENT_ID']"])).toEqual([
      'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
    ]);
  });

  it('accepts any quote style', () => {
    expect(
      scanUninlinableReads(['process.env["NEXT_PUBLIC_A"]', 'process.env[`NEXT_PUBLIC_B`]'])
    ).toEqual(['NEXT_PUBLIC_A', 'NEXT_PUBLIC_B']);
  });

  it('says nothing about the inlinable form', () => {
    expect(scanUninlinableReads(['process.env.NEXT_PUBLIC_POSTHOG_KEY'])).toEqual([]);
  });
});

describe('findDeliveryGaps', () => {
  const V = 'NEXT_PUBLIC_POSTHOG_KEY';

  it('passes a fully wired variable', () => {
    expect(findDeliveryGaps([V], { dockerfile: wired(V), compose: composed(V) })).toEqual([]);
  });

  it('reports a variable wired nowhere', () => {
    expect(findDeliveryGaps([V], { dockerfile: '', compose: '' })).toEqual([
      {
        variable: V,
        missing: ['Dockerfile ARG', 'Dockerfile ENV', 'docker-compose.prod.yml build arg'],
      },
    ]);
  });

  it('reports ARG without ENV — the shape that LOOKS wired and is not', () => {
    // An ARG accepts the value; only the ENV puts it where `next build` reads it.
    const gaps = findDeliveryGaps([V], { dockerfile: `ARG ${V}\n`, compose: composed(V) });
    expect(gaps).toEqual([{ variable: V, missing: ['Dockerfile ENV'] }]);
  });

  it('reports ENV without ARG', () => {
    const gaps = findDeliveryGaps([V], { dockerfile: `ENV ${V}=$${V}\n`, compose: composed(V) });
    expect(gaps).toEqual([{ variable: V, missing: ['Dockerfile ARG'] }]);
  });

  it('accepts ENV in the ${VAR} form', () => {
    // Both spellings are valid Dockerfile syntax. Demanding one reported a
    // correctly-wired fork as broken.
    const df = `ARG ${V}\nENV ${V}=\${${V}}\n`;
    expect(findDeliveryGaps([V], { dockerfile: df, compose: composed(V) })).toEqual([]);
  });

  it('accepts an ENV line with a trailing comment', () => {
    const df = `ARG ${V}\nENV ${V}=$${V}  # analytics\n`;
    expect(findDeliveryGaps([V], { dockerfile: df, compose: composed(V) })).toEqual([]);
  });

  it('rejects a compose entry whose value interpolates a DIFFERENT variable', () => {
    // `- FOO=${FOO_BAR}` satisfies a brace-less regex while delivering the wrong
    // value — the same "looks wired and is not" shape as ARG-without-ENV.
    const compose = `        - ${V}=\${${V}_TYPO}\n`;
    const gaps = findDeliveryGaps([V], { dockerfile: wired(V), compose });
    expect(gaps).toEqual([{ variable: V, missing: ['docker-compose.prod.yml build arg'] }]);
  });

  it('does not accept a prefix match for a different variable', () => {
    // `ARG NEXT_PUBLIC_POSTHOG_KEY` must not satisfy `NEXT_PUBLIC_POSTHOG_KEY_2`.
    const gaps = findDeliveryGaps(['NEXT_PUBLIC_POSTHOG'], {
      dockerfile: wired(V),
      compose: composed(V),
    });
    expect(gaps[0]?.variable).toBe('NEXT_PUBLIC_POSTHOG');
    expect(gaps[0]?.missing).toContain('Dockerfile ARG');
  });

  it('SKIPS a target the fork does not ship, rather than failing it', () => {
    // A fork deploying only to a dashboard platform may delete the Dockerfile.
    // Failing it for the absence of a file it removed on purpose would be one
    // more core check a fork cannot satisfy — the class #660 was about.
    expect(findDeliveryGaps([V], { dockerfile: null, compose: composed(V) })).toEqual([]);
    expect(findDeliveryGaps([V], { dockerfile: wired(V), compose: null })).toEqual([]);
    expect(findDeliveryGaps([V], { dockerfile: null, compose: null })).toEqual([]);
  });

  it('reports every gapped variable, not just the first', () => {
    const gaps = findDeliveryGaps(['NEXT_PUBLIC_A', 'NEXT_PUBLIC_B'], {
      dockerfile: '',
      compose: '',
    });
    expect(gaps.map((g) => g.variable)).toEqual(['NEXT_PUBLIC_A', 'NEXT_PUBLIC_B']);
  });
});
