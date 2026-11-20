// @vitest-environment happy-dom

/**
 * Settings Constants Tests
 *
 * Test Coverage:
 * - settingsTabTitles gives a title for every tab value, from the catalogue
 *
 * The brand case is in tests/unit/brand-fork-surfaces.test.tsx.
 *
 * @see lib/constants/settings.ts
 */

import { describe, it, expect } from 'vitest';

import {
  SETTINGS_TAB_VALUES,
  DEFAULT_SETTINGS_TAB,
  settingsTabTitles,
} from '@/lib/constants/settings';
import { BRAND } from '@/lib/brand';
import { createTranslator } from 'next-intl';
import en from '@/lib/i18n/messages/en.json';

describe('settingsTabTitles', () => {
  const titles = settingsTabTitles(
    createTranslator({ locale: 'en', messages: en, namespace: 'account.settings' })
  );

  it("builds each title from the catalogue template and that tab's name", () => {
    expect(titles).toEqual({
      profile: `Profile - Settings - ${BRAND.name}`,
      security: `Security - Settings - ${BRAND.name}`,
      notifications: `Notifications - Settings - ${BRAND.name}`,
      account: `Account - Settings - ${BRAND.name}`,
    });
  });

  it('has a title for every tab value, including the default', () => {
    expect(Object.keys(titles).sort()).toEqual([...SETTINGS_TAB_VALUES].sort());
    expect(titles[DEFAULT_SETTINGS_TAB]).toContain('Settings');
  });
});
