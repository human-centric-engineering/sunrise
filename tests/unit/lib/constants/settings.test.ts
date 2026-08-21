// @vitest-environment happy-dom

/**
 * Settings Constants Tests
 *
 * Test Coverage:
 * - SETTINGS_TAB_TITLES has a title for every tab value
 * - Titles carry the brand seam rather than a hardcoded "Sunrise" (#432)
 *
 * @see lib/constants/settings.ts
 */

import { describe, it, expect, vi } from 'vitest';

import {
  SETTINGS_TAB_VALUES,
  SETTINGS_TAB_TITLES,
  DEFAULT_SETTINGS_TAB,
} from '@/lib/constants/settings';

describe('SETTINGS_TAB_TITLES', () => {
  it('has a non-empty title for every tab value', () => {
    for (const tab of SETTINGS_TAB_VALUES) {
      expect(SETTINGS_TAB_TITLES[tab].length).toBeGreaterThan(0);
    }
  });

  it('all titles contain "Settings"', () => {
    for (const tab of SETTINGS_TAB_VALUES) {
      expect(SETTINGS_TAB_TITLES[tab]).toContain('Settings');
    }
  });

  it('defaults to a tab that has a title', () => {
    expect(SETTINGS_TAB_TITLES[DEFAULT_SETTINGS_TAB]).toBeDefined();
  });

  // #432: these are written straight to document.title, overriding the layout's
  // `%s - ${BRAND.name}` template, so a hardcoded name shows the fork "Sunrise"
  it('carries the fork brand name, not a hardcoded "Sunrise"', async () => {
    const original = process.env.NEXT_PUBLIC_APP_NAME;
    process.env.NEXT_PUBLIC_APP_NAME = 'Acme';
    vi.resetModules();

    const { SETTINGS_TAB_TITLES: forked, SETTINGS_TAB_VALUES: values } =
      await import('@/lib/constants/settings');

    for (const tab of values) {
      expect(forked[tab]).toContain('Acme');
      expect(forked[tab]).not.toContain('Sunrise');
    }

    process.env.NEXT_PUBLIC_APP_NAME = original;
    vi.resetModules();
  });
});
