'use client';

/**
 * Support session banner (§121 t-824)
 *
 * Shown across the admin console for the whole of a support session: which
 * org the platform admin is acting in, at what level, and how long the grant
 * has left, with a way out. Once the grant has ended, the next request is
 * refused, and the layout shows this banner in its `ended` state with the
 * same way out, so the admin is told why the console stopped working.
 *
 * Ending the session switches back to the install org through the ordinary
 * switch route. That route does not enter the current org, so it works from
 * an org the guard now refuses. A full page load follows, because the admin
 * layout re-checks who is viewing only on a full load.
 */

import { useEffect, useState } from 'react';
import { LifeBuoy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { SUPPORT_GRANT_LEVEL_LABELS } from '@/components/admin/support-access/support-level-help';
import type { SupportSessionView } from '@/lib/auth/admin-page-viewer';

/** How often the time left is redrawn. Minutes are the smallest unit shown. */
const TICK_MS = 30_000;

/** "3h 20m left", "12m left", "less than a minute left". */
export function formatTimeLeft(msLeft: number): string {
  const minutes = Math.floor(msLeft / 60_000);
  if (minutes < 1) return 'less than a minute left';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m left`;
  return rest === 0 ? `${hours}h left` : `${hours}h ${rest}m left`;
}

export function SupportBanner({ view }: { view: SupportSessionView }) {
  // Read the clock only after mount: the server and the browser would read it
  // at different moments, and the time left would differ between the HTML and
  // hydration. Until then the time left is simply not shown.
  const [now, setNow] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expiresAt = view.state === 'active' ? Date.parse(view.expiresAt) : null;
  const expired =
    view.state === 'ended' || (expiresAt !== null && now !== null && expiresAt <= now);

  useEffect(() => {
    if (view.state !== 'active') return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(interval);
  }, [view.state]);

  async function endSession() {
    setEnding(true);
    setError(null);
    try {
      await apiClient.post(API.ORGS.SWITCH, { body: { orgId: INSTALL_ORG_ID } });
      window.location.assign('/admin');
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not end the support session');
      setEnding(false);
    }
  }

  return (
    <div
      role="status"
      className={
        expired
          ? 'flex flex-wrap items-center gap-3 border-b border-red-300 bg-red-50 px-6 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100'
          : 'flex flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-50 px-6 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100'
      }
    >
      <LifeBuoy className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="flex-1">
        {expired ? (
          <>
            Your support session in <strong>{view.orgName}</strong> has ended. Its grant expired or
            was revoked, or the organisation is no longer available, so this console can no longer
            act in it.
          </>
        ) : (
          <>
            Support session in <strong>{view.orgName}</strong>
            {view.state === 'active' && (
              <>
                {' · '}
                {SUPPORT_GRANT_LEVEL_LABELS[view.level]} access
                {expiresAt !== null && now !== null && (
                  <>
                    {' · '}
                    {formatTimeLeft(expiresAt - now)}
                  </>
                )}
              </>
            )}
          </>
        )}
      </p>
      {error && <p className="text-xs">{error}</p>}
      {view.state === 'active' && view.viaResolver ? (
        // This address picks the org, so switching cannot leave it.
        <p className="text-xs">Leave this organisation’s address to end the session.</p>
      ) : (
        <Button size="sm" variant="outline" onClick={() => void endSession()} disabled={ending}>
          {ending ? 'Ending…' : 'End support session'}
        </Button>
      )}
    </div>
  );
}
