/**
 * A page whose entitlement switch the viewer's org lacks, shown locked
 * (§135 t-1053).
 *
 * Rendered by `AdminTierGate` in the page's place when the app registered the
 * switch `whenLacking: 'lock'`: it names what is closed, says what the app
 * registered as the refusal, and links to where the org can get it. It never
 * renders the page, and the page's routes still refuse.
 */

import { Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { LockedAdminSwitch } from '@/lib/auth/admin-tier';

export function LockedAdminPage({ locked }: { locked: LockedAdminSwitch }) {
  return (
    <section
      aria-labelledby="locked-admin-page-title"
      className="mx-auto max-w-xl space-y-4 rounded-lg border p-6"
    >
      <div className="flex items-center gap-2">
        <Lock className="text-muted-foreground h-5 w-5" aria-hidden="true" />
        <h1 id="locked-admin-page-title" className="text-xl font-semibold">
          {locked.label} is not available
        </h1>
      </div>
      <p className="text-muted-foreground text-sm">{locked.message}</p>
      {locked.upgradeUrl && <UpgradeLink locked={locked} />}
    </section>
  );
}

/** The link to where the org can get a locked switch, for the page and the sidebar alike. */
export function UpgradeLink({
  locked,
  size = 'default',
}: {
  locked: LockedAdminSwitch;
  size?: 'default' | 'sm';
}) {
  if (!locked.upgradeUrl) return null;
  // A path on this site or an https address, checked when the app registered it.
  const external = !locked.upgradeUrl.startsWith('/');
  return (
    <Button asChild size={size}>
      <a href={locked.upgradeUrl} {...(external ? { rel: 'noopener noreferrer' } : {})}>
        How to get {locked.label}
      </a>
    </Button>
  );
}
