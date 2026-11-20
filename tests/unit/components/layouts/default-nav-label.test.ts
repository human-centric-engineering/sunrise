/**
 * defaultNavLabelKey: only the platform's own default links get a catalogue
 * key; any other link (a fork's) renders its own label (§138 t-1073).
 */

import { describe, expect, it } from 'vitest';
import en from '@/lib/i18n/messages/en.json';
import { defaultNavLabelKey } from '@/components/layouts/default-nav-label';

describe('defaultNavLabelKey', () => {
  it.each([
    ['/', 'home'],
    ['/about', 'about'],
    ['/privacy', 'privacyPolicy'],
    ['/settings', 'settings'],
    ['/admin', 'admin'],
  ])('maps the default link %s to layout.nav.%s', (href, key) => {
    expect(defaultNavLabelKey(href)).toBe(key);
  });

  it('gives every key it can return a string in the catalogue', () => {
    const hrefs = [
      '/',
      '/about',
      '/contact',
      '/privacy',
      '/terms',
      '/dashboard',
      '/profile',
      '/settings',
      '/admin',
    ];
    for (const href of hrefs) {
      const key = defaultNavLabelKey(href);
      expect(key).not.toBeNull();
      expect(en.layout.nav).toHaveProperty(key as string);
    }
  });

  it('gives no key for a link the platform does not ship', () => {
    expect(defaultNavLabelKey('/pricing')).toBeNull();
    expect(defaultNavLabelKey('/about/team')).toBeNull();
  });
});
