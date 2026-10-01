/**
 * UnapprovedProvidersBanner
 *
 * Top-of-page banner on the agent edit view for an agent stranded by its
 * org's provider policy (§120 t-745): it names a provider the org is no
 * longer approved for, so the runtime refuses every call to it. Without the
 * banner the agent looks healthy until a conversation fails. Hidden when the
 * agent names none — the absence of a banner is the "all clear" signal.
 *
 * Server component: no client state, just rendering.
 */

import { AlertTriangle } from 'lucide-react';

export interface UnapprovedProvidersBannerProps {
  /** The agent's primary provider slug (`''` when it inherits one). */
  provider: string;
  /** The slugs it names that the org is not approved for. */
  unapproved: string[];
}

const quoted = (slugs: string[]): string => slugs.map((slug) => `“${slug}”`).join(', ');

export function UnapprovedProvidersBanner({
  provider,
  unapproved,
}: UnapprovedProvidersBannerProps): React.ReactElement | null {
  if (unapproved.length === 0) return null;

  const primaryRefused = provider.length > 0 && unapproved.includes(provider);
  const fallbacks = unapproved.filter((slug) => slug !== provider);

  return (
    <div
      className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-900/60 dark:bg-amber-950/30"
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            {primaryRefused
              ? 'This agent cannot respond — this organisation is not approved to use its provider'
              : 'Some of this agent’s fallback providers are not approved for this organisation'}
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {primaryRefused && (
              <li>
                Primary provider {quoted([provider])}: every call to it is refused, so every
                conversation with this agent fails.
              </li>
            )}
            {fallbacks.length > 0 && (
              <li>
                Fallback {fallbacks.length === 1 ? 'provider' : 'providers'} {quoted(fallbacks)}:
                failover to {fallbacks.length === 1 ? 'it' : 'them'} is refused.
              </li>
            )}
          </ul>
          <p className="text-muted-foreground text-xs">
            A platform admin grants providers on the organisation&apos;s page (Management →
            Organisations), or choose an approved provider on the Model tab below.
          </p>
        </div>
      </div>
    </div>
  );
}
