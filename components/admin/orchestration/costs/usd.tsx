'use client';

/**
 * <Usd> — presentational wrapper around `formatUsd()`.
 *
 * Every dollar amount on the costs page goes through this so the
 * null/— handling and decimal rules stay consistent. Used as a JSX
 * element so callers can pass className/test-id without manually
 * splicing `formatUsd()` calls into every template literal.
 */

import { formatUsd, type FormatUsdOptions } from '@/lib/utils/format-currency';
import { cn } from '@/lib/utils';

export interface UsdProps extends FormatUsdOptions {
  value: number | null | undefined;
  className?: string;
  /** Render as `<span>` by default. */
  as?: 'span' | 'div';
}

export function Usd({ value, className, compact, as = 'span' }: UsdProps) {
  const Tag = as;
  return <Tag className={cn('tabular-nums', className)}>{formatUsd(value, { compact })}</Tag>;
}
