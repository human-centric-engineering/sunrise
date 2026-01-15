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
import { HeaderActions } from './header-actions';

interface AppHeaderProps {
  /** URL for logo click (default: "/") */
  logoHref?: string;
  /** Logo text (default: "Sunrise") */
  logoText?: string;
  /** Optional navigation component to display after logo */
  navigation?: React.ReactNode;
}

export function AppHeader({ logoHref = '/', logoText = 'Sunrise', navigation }: AppHeaderProps) {
  return (
    <header className="border-b">
      <div className="container mx-auto flex items-center justify-between px-4 py-4">
        <div className="flex items-center gap-8">
          <Link href={logoHref} className="text-xl font-bold hover:opacity-80">
            {logoText}
          </Link>
          {navigation}
        </div>
        <HeaderActions />
      </div>
    </header>
  );
}
