/**
 * Public marketing nav — shared type + platform defaults.
 *
 * Platform-owned. Rendering (active-state, responsive, a11y, the `next/link`
 * and `usePathname` glue) lives in `components/layouts/public-nav.tsx` and
 * `public-footer.tsx` and keeps improving upstream. This module is the *data*
 * half: a portable item shape plus the default link sets.
 *
 * Forks OWN the marketing nav (remove/rename/reorder links) rather than extend
 * it, so the seam is *replacement*, not append — see `lib/app/public-nav.ts`,
 * whose non-null exports replace these defaults wholesale.
 */
import type { LucideIcon } from 'lucide-react';
import { Home, Info, Mail } from 'lucide-react';

/**
 * A single marketing nav / footer link. Boundary-clean: a string `href`/`label`
 * plus an optional `lucide-react` icon — no `next/*` types — so a fork can
 * declare these from `lib/app/public-nav.ts` (which the `lib/app/**` boundary
 * keeps framework-agnostic). The header nav renders `icon`; the footer ignores
 * it.
 */
export interface PublicNavItem {
  href: string;
  label: string;
  icon?: LucideIcon;
}

/** Default header nav. */
export const DEFAULT_PUBLIC_NAV: PublicNavItem[] = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/about', label: 'About', icon: Info },
  { href: '/contact', label: 'Contact', icon: Mail },
];

/** Default footer link cluster. */
export const DEFAULT_FOOTER_NAV: PublicNavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

/** Default footer legal cluster. The Cookie Preferences control is rendered by
 * the footer itself regardless of this list (see `public-footer.tsx`). */
export const DEFAULT_FOOTER_LEGAL: PublicNavItem[] = [
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms of Service' },
];
