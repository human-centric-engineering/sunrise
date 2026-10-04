'use client';

/**
 * Shared settings, read-only outside the install org (§107 t-753)
 *
 * At `multi`, shared settings — providers, models, capabilities, agent
 * profiles, knowledge tags, MCP exposure, feature flags, orchestration
 * settings — change only from the install org; the server refuses the rest
 * (t-751). The admin layout reads the answer once per request
 * (`getSharedSettingsAccess`) and provides it here, so every page asks the
 * same question the same way:
 *
 *   • `useSharedSettingsReadOnly()` — hide or disable create, edit and delete;
 *   • `<SharedSettingsReadOnlyNotice />` — say why, with a way to switch.
 *
 * Outside a provider the answer is "editable", which is what every component
 * did before this existed: at `single`, in the install org, and in a test
 * that renders a component alone.
 */

import { createContext, useContext, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { cn } from '@/lib/utils';

interface SharedSettingsAccessValue {
  readOnly: boolean;
  canSwitch: boolean;
}

const SharedSettingsAccessContext = createContext<SharedSettingsAccessValue>({
  readOnly: false,
  canSwitch: false,
});

export function SharedSettingsAccessProvider({
  readOnly,
  canSwitch,
  children,
}: SharedSettingsAccessValue & { children: React.ReactNode }) {
  return (
    <SharedSettingsAccessContext.Provider value={{ readOnly, canSwitch }}>
      {children}
    </SharedSettingsAccessContext.Provider>
  );
}

/** Shared settings can be read but not changed from the org this page acts for. */
export function useSharedSettingsReadOnly(): boolean {
  return useContext(SharedSettingsAccessContext).readOnly;
}

/**
 * The read-only hint for a shared-settings page. Renders nothing where the
 * settings can be changed.
 */
export function SharedSettingsReadOnlyNotice({ className }: { className?: string }) {
  const { readOnly, canSwitch } = useContext(SharedSettingsAccessContext);
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!readOnly) return null;

  async function switchToInstallOrg() {
    setSwitching(true);
    setError(null);
    try {
      await apiClient.post(API.ORGS.SWITCH, { body: { orgId: INSTALL_ORG_ID } });
      router.refresh();
    } catch (err) {
      setError(
        err instanceof APIClientError ? err.message : 'Could not switch organisation. Try again.'
      );
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="shared-settings-read-only"
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/30',
        className
      )}
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">Read-only in this organisation</p>
        <p className="text-muted-foreground">
          These settings are shared by every organisation, so they can only be changed from the
          install organisation.
          {canSwitch
            ? ''
            : ' This address decides the organisation, so open the admin from the install organisation’s address to change them.'}
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
      {canSwitch && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void switchToInstallOrg()}
          disabled={switching}
        >
          {switching ? 'Switching…' : 'Switch to the install organisation'}
        </Button>
      )}
    </div>
  );
}
