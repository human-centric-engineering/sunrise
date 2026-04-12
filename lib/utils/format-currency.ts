/**
 * USD formatting for cost-surfacing UI.
 *
 * Used by every component that renders a dollar amount in the
 * orchestration costs page so the decimal rules stay consistent:
 *
 *   - `null` / non-finite        → `"—"`
 *   - `0`                        → `"$0.00"`
 *   - `|x| < 1`                  → 4 decimals (`$0.0042`)
 *   - `|x| >= 1`                 → 2 decimals (`$12.34`)
 *   - `{ compact: true }`        → `$1.2k`, `$3.4M` for chart axes
 *
 * Why 4 decimals below a dollar: individual chat turns on cheap models
 * produce sub-cent costs, and rounding them to `$0.00` loses signal
 * when the admin is evaluating spend-per-turn.
 */

export interface FormatUsdOptions {
  /** Use compact notation (`$1.2k`, `$3.4M`) — best for chart axes. */
  compact?: boolean;
}

const PLACEHOLDER = '—';

export function formatUsd(
  value: number | null | undefined,
  options: FormatUsdOptions = {}
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return PLACEHOLDER;
  }

  if (options.compact) {
    return formatCompact(value);
  }

  if (value === 0) return '$0.00';

  const abs = Math.abs(value);
  if (abs < 1) {
    return formatFixed(value, 4);
  }
  return formatFixed(value, 2);
}

function formatFixed(value: number, decimals: number): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return value < 0 ? `-$${formatted}` : `$${formatted}`;
}

function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return '$0';
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${trimTrailing(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${trimTrailing(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${trimTrailing(abs / 1_000)}k`;
  if (abs >= 1) return formatFixed(value, 2);
  return formatFixed(value, 4);
}

function trimTrailing(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
