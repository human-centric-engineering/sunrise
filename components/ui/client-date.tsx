'use client';

import { useState, useEffect } from 'react';

/**
 * ClientDate Component
 *
 * Renders dates using the browser's locale, only after client-side hydration.
 *
 * Why this exists:
 * - Server renders dates with its locale (often en-US)
 * - Client renders with user's browser locale (could be en-GB, de-DE, etc.)
 * - This mismatch causes React hydration warnings and flicker
 * - By deferring to client-only rendering, users always see their locale format
 *
 * The component shows a minimal placeholder on server, then the localized
 * date after hydration. This prevents the flash of wrong locale format.
 *
 * @example
 * ```tsx
 * // Date only (e.g., "1/15/2026" or "15/01/2026")
 * <ClientDate date={user.createdAt} />
 *
 * // Date and time (e.g., "1/15/2026, 2:30 PM")
 * <ClientDate date={log.timestamp} showTime />
 *
 * // With custom className
 * <ClientDate date={item.date} className="text-muted-foreground" />
 * ```
 */

interface ClientDateProps {
  /** Date to display - accepts Date object or ISO string */
  date: Date | string;
  /** Include time in the output */
  showTime?: boolean;
  /** Additional CSS classes */
  className?: string;
}

export function ClientDate({ date, showTime = false, className }: ClientDateProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const d = typeof date === 'string' ? new Date(date) : date;

  // Before hydration, show a non-breaking space to preserve layout
  // After hydration, show the localized date
  const formatted = mounted ? (showTime ? d.toLocaleString() : d.toLocaleDateString()) : '\u00A0'; // Non-breaking space as placeholder

  return (
    <span className={className} suppressHydrationWarning>
      {formatted}
    </span>
  );
}
