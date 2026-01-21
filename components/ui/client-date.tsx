'use client';

/**
 * ClientDate Component
 *
 * Renders dates using the browser's locale while suppressing hydration warnings.
 *
 * Why this exists:
 * - Server renders dates with its locale (often en-US)
 * - Client renders with user's browser locale (could be en-GB, de-DE, etc.)
 * - This mismatch causes React hydration warnings
 * - Using `suppressHydrationWarning` tells React this is intentional
 *
 * The user sees their preferred date format, and React doesn't complain.
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
  const d = typeof date === 'string' ? new Date(date) : date;

  const formatted = showTime ? d.toLocaleString() : d.toLocaleDateString();

  return (
    <span className={className} suppressHydrationWarning>
      {formatted}
    </span>
  );
}
