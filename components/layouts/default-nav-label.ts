/**
 * The catalogue key for each link in the platform's default navs (§138 t-1073).
 *
 * The default lists (`DEFAULT_PUBLIC_NAV`, `DEFAULT_FOOTER_*`,
 * `DEFAULT_PROTECTED_NAV`) carry English labels, and a fork's override
 * replaces them with its own. So a nav translates a label only while it is
 * rendering the platform's list: a fork's labels are the fork's text and
 * render as given.
 */

const DEFAULT_NAV_LABEL_KEYS = {
  '/': 'home',
  '/about': 'about',
  '/contact': 'contact',
  '/privacy': 'privacyPolicy',
  '/terms': 'termsOfService',
  '/dashboard': 'dashboard',
  '/profile': 'profile',
  '/settings': 'settings',
  '/admin': 'admin',
} as const;

const LABEL_KEY_BY_HREF: ReadonlyMap<string, DefaultNavLabelKey> = new Map(
  Object.entries(DEFAULT_NAV_LABEL_KEYS)
);

export type DefaultNavLabelKey =
  (typeof DEFAULT_NAV_LABEL_KEYS)[keyof typeof DEFAULT_NAV_LABEL_KEYS];

/** The `layout.nav` key for a default link's `href`, or `null` for any other link. */
export function defaultNavLabelKey(href: string): DefaultNavLabelKey | null {
  return LABEL_KEY_BY_HREF.get(href) ?? null;
}
