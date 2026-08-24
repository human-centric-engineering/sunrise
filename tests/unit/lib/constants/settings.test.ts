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

import { describe, it, expect } from 'vitest';

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

  // The brand case moved to tab-titles-brand.test.ts — it needs a hoisted mock,
  // which cannot work in a file that statically imports the module under test.
});
