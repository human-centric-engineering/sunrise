// @vitest-environment happy-dom

/**
 * What a FORK's brand looks like on every surface that renders it (#661).
 *
 * `tests/setup.ts` pins `lib/app/brand.ts` to null for the whole suite, so every
 * other test sees the "Sunrise" default. This is the one file that fills the
 * seam, and it renders each surface for real: the header `<BrandMark>`, both
 * footers, the two `document.title` writers, and a transactional email.
 *
 * ## Why one file with a HOISTED mock
 *
 * These cases used to live beside their subjects, driving the brand with
 * `vi.doMock` + `vi.resetModules()` + a dynamic re-import. The seam is read at
 * module scope, so that races whatever already holds an evaluated copy of
 * `@/lib/brand`. It failed about one run in three locally, took out two CI
 * shards, and reordering the calls made one file worse (5 failures in 6 runs).
 * Fixing it file-by-file missed a fourth instance, which then failed CI again.
 *
 * `vi.mock` is hoisted above the imports, so everything below is BUILT with the
 * fork brand. Nothing is re-imported and there is nothing to race. The
 * DEFAULT-brand cases stay in their original files, where the suite-wide pin
 * already gives them "Sunrise" with no mocking at all.
 *
 * `resolveBrand()` — the resolution logic itself — is unit-tested as a pure
 * function in tests/unit/lib/brand.test.tsx. This file is about wiring: that a
 * value in the seam reaches rendered output.
 */

import { describe, it, expect, vi } from 'vitest';

const { FORK } = vi.hoisted(() => ({
  FORK: { name: 'Acme', legalName: 'All Too Human Ltd' },
}));

vi.mock('@/lib/app/brand', () => ({
  appBrandName: FORK.name,
  appBrandLegalName: FORK.legalName,
  appBrandDescription: null,
}));

// The footers render a Cookie Preferences control, which needs consent context.
// Unrelated to brand; stubbed so these cases can render the real components.
vi.mock('@/lib/consent', () => ({ useConsent: () => ({ openPreferences: vi.fn() }) }));

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { render as renderEmail } from '@react-email/render';
import { BRAND, resolveBrand } from '@/lib/brand';
import { appBrandName, appBrandLegalName, appBrandDescription } from '@/lib/app/brand';
import { BrandMark } from '@/components/brand/brand-mark';
import { PublicFooter } from '@/components/layouts/public-footer';
import { ProtectedFooter } from '@/components/layouts/protected-footer';
import { KNOWLEDGE_TAB_TITLES, KNOWLEDGE_TAB_VALUES } from '@/lib/constants/knowledge';
import { SETTINGS_TAB_TITLES, SETTINGS_TAB_VALUES } from '@/lib/constants/settings';
import WelcomeEmail from '@/emails/welcome';

describe('BRAND resolves from the seam', () => {
  it('is exactly resolveBrand applied to the seam', () => {
    expect(BRAND.name).toBe(FORK.name);
    expect(BRAND).toEqual(
      resolveBrand({
        name: appBrandName,
        legalName: appBrandLegalName,
        description: appBrandDescription,
      })
    );
  });

  it('derives description from the seam name when it is unset', () => {
    expect(BRAND.description).toBe(FORK.name);
  });
});

describe('header brand', () => {
  it('renders the fork brand', () => {
    const { container } = render(React.createElement(BrandMark));
    expect(container.textContent).toBe(FORK.name);
  });
});

describe.each([
  ['PublicFooter', PublicFooter, /^©/],
  ['ProtectedFooter', ProtectedFooter, /©/],
] as const)('%s copyright', (_name, Footer, matcher) => {
  it('attributes to the legal entity, not the product (#363)', () => {
    render(React.createElement(Footer as React.ComponentType));
    const copyright = screen.getByText(matcher);
    expect(copyright).toHaveTextContent(FORK.legalName);
    expect(copyright).not.toHaveTextContent(FORK.name);
  });
});

describe.each([
  ['KNOWLEDGE_TAB_TITLES', KNOWLEDGE_TAB_TITLES, KNOWLEDGE_TAB_VALUES],
  ['SETTINGS_TAB_TITLES', SETTINGS_TAB_TITLES, SETTINGS_TAB_VALUES],
] as const)('%s', (_name, titles, values) => {
  // Written straight to `document.title`, so they override the layout's
  // `%s - ${BRAND.name}` template — a hardcoded name here shows a fork
  // "Sunrise" in the browser tab on every one of those pages (#432).
  it('carries the fork brand and no hardcoded "Sunrise"', () => {
    for (const tab of values) {
      const title = titles[tab as keyof typeof titles];
      expect(title).toContain(FORK.name);
      expect(title).not.toContain('Sunrise');
    }
  });
});

describe('transactional email', () => {
  // The surface a fork never sees before a real user does.
  it('renders the fork brand in the welcome email', async () => {
    const html = await renderEmail(
      React.createElement(WelcomeEmail, {
        userName: 'Test User',
        userEmail: 'test@example.com',
        baseUrl: 'https://example.com',
      })
    );
    expect(html).toContain(`Welcome to ${FORK.name}!`);
    expect(html).not.toContain('Welcome to Sunrise!');
  });
});
