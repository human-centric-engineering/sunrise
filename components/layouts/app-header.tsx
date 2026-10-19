/**
 * AppHeader Component
 *
 * Shared header component for public and protected layouts.
 * Provides consistent branding, navigation, and user actions.
 *
 * @example
 * // Protected layout with navigation
 * <AppHeader logoHref="/dashboard" navigation={<ProtectedNav />} />
 *
 * @example
 * // Public layout without navigation
 * <AppHeader logoHref="/" />
 */

import Link from 'next/link';
import { HeaderActions } from '@/components/layouts/header-actions';
import { BrandMark } from '@/components/brand/brand-mark';

interface AppHeaderProps {
  /** URL for logo click (default: "/") */
  logoHref?: string;
  /** Optional caller override for the brand slot; defaults to `<BrandMark/>`. */
  logoText?: string;
  /** Optional navigation component to display after logo */
  navigation?: React.ReactNode;
}

export function AppHeader({ logoHref = '/', logoText, navigation }: AppHeaderProps) {
  return (
    <header className="border-b">
      <div className="container mx-auto flex items-center justify-between gap-4 px-4 py-4">
        {/* `min-w-0` lets the brand truncate rather than push the actions off a
            small screen; the nav folds into a menu below `md` (HeaderNav). */}
        <div className="flex min-w-0 items-center gap-4 md:gap-8">
          <Link href={logoHref} className="min-w-0 truncate text-xl font-bold hover:opacity-80">
            {logoText ?? <BrandMark />}
          </Link>
          {navigation}
        </div>
        <div className="shrink-0">
          <HeaderActions />
        </div>
      </div>
    </header>
  );
}
