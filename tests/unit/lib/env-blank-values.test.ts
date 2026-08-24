/**
 * Blank `NEXT_PUBLIC_*` values mean "unset"; blank server values do not (#662).
 *
 * A Dockerfile `ENV VAR=$VAR` whose `ARG VAR` was not passed materialises as the
 * EMPTY STRING. Zod's `.optional()` accepts `undefined` and rejects `''`, so
 * forwarding the client vars as build args — the thing that makes them
 * deliverable at all — turned every unset one into a hard `next build` failure
 * on "Invalid URL". Only a real container build caught that.
 *
 * The SCOPE is the half worth testing hardest. Stripping every blank value would
 * also reach the server schema's `.default()` enums, turning `SIGNUP_MODE=""`
 * from a boot refusal into a silent `'open'` — an invite-only deployment quietly
 * accepting public signups. Blank-is-unset is right where Docker gives us no way
 * to tell the two apart, and wrong where a blank means a template misfired.
 */

import { describe, it, expect } from 'vitest';
import { withoutBlankClientValues } from '@/lib/env';

describe('withoutBlankClientValues — client vars', () => {
  it('drops an empty string, which is what an unset Docker ARG becomes', () => {
    expect(withoutBlankClientValues({ NEXT_PUBLIC_POSTHOG_HOST: '' })).toEqual({});
  });

  it('drops a whitespace-only value', () => {
    expect(withoutBlankClientValues({ NEXT_PUBLIC_POSTHOG_HOST: '   ' })).toEqual({});
  });

  it('keeps a real value untouched, including surrounding whitespace', () => {
    // Trimming is a separate decision; this only decides present-or-absent.
    expect(withoutBlankClientValues({ NEXT_PUBLIC_POSTHOG_HOST: ' https://x.example ' })).toEqual({
      NEXT_PUBLIC_POSTHOG_HOST: ' https://x.example ',
    });
  });

  it('keeps "false", which is meaningful for the consent toggle', () => {
    // A truthiness filter would have eaten this one.
    expect(withoutBlankClientValues({ NEXT_PUBLIC_COOKIE_CONSENT_ENABLED: 'false' })).toEqual({
      NEXT_PUBLIC_COOKIE_CONSENT_ENABLED: 'false',
    });
  });
});

describe('withoutBlankClientValues — server vars keep failing loudly', () => {
  it('does NOT drop a blank server var, so the enum still rejects it', () => {
    // The regression this scope exists to prevent: dropping it would let
    // `.default('open')` apply and boot an invite-only deployment open.
    expect(withoutBlankClientValues({ SIGNUP_MODE: '' })).toEqual({ SIGNUP_MODE: '' });
  });

  it('does not drop blank TENANCY_MODE, MCP_SESSION_MODE or CAPABILITY_BINDING_MODE', () => {
    const blanks = { TENANCY_MODE: '', MCP_SESSION_MODE: '', CAPABILITY_BINDING_MODE: '' };
    expect(withoutBlankClientValues(blanks)).toEqual(blanks);
  });

  it('does not drop a blank secret', () => {
    expect(withoutBlankClientValues({ BETTER_AUTH_SECRET: '' })).toEqual({
      BETTER_AUTH_SECRET: '',
    });
  });
});

describe('withoutBlankClientValues — mixed', () => {
  it('drops only the blank client vars', () => {
    expect(
      withoutBlankClientValues({
        NEXT_PUBLIC_POSTHOG_KEY: '',
        NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        SIGNUP_MODE: '',
        DATABASE_URL: 'postgresql://x',
      })
    ).toEqual({
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      SIGNUP_MODE: '',
      DATABASE_URL: 'postgresql://x',
    });
  });
});
