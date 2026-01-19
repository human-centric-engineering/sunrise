import Link from 'next/link';

/**
 * Protected Footer Component
 *
 * Minimal footer for authenticated app pages.
 * Includes help link and copyright.
 *
 * Phase 3.5: Landing Page & Marketing
 */
export function ProtectedFooter() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="border-t">
      <div className="container mx-auto px-4 py-4">
        <div className="text-muted-foreground flex flex-col items-center justify-between gap-2 text-sm sm:flex-row">
          <p>&copy; {currentYear} Sunrise</p>
          <Link href="/contact" className="hover:text-foreground transition-colors">
            Help & Support
          </Link>
        </div>
      </div>
    </footer>
  );
}
