'use client';

import Link from 'next/link';
import { useConsent } from '@/lib/consent';

/**
 * Public Footer Component
 *
 * Footer for public/marketing pages.
 * Includes navigation links, legal links, and copyright.
 *
 * Phase 3.5: Landing Page & Marketing
 */

const navigationLinks = [
  { href: '/', label: 'Home' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

const legalLinks = [
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/terms', label: 'Terms of Service' },
];

export function PublicFooter() {
  const currentYear = new Date().getFullYear();
  const { openPreferences } = useConsent();

  return (
    <footer className="border-t">
      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:justify-between">
          {/* Navigation Links */}
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {navigationLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-muted-foreground hover:text-foreground text-sm transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Legal Links */}
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2">
            {legalLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-muted-foreground hover:text-foreground text-sm transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <button
              onClick={openPreferences}
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Cookie Preferences
            </button>
          </nav>
        </div>

        {/* Copyright */}
        <div className="text-muted-foreground mt-6 text-center text-sm">
          &copy; {currentYear} Sunrise. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
