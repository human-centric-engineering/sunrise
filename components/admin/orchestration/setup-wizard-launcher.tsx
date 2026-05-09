'use client';

/**
 * Setup Wizard launcher
 *
 * Client island. Renders the "Setup Guide" button in the dashboard
 * header and lazily mounts the SetupWizard component inside a Dialog
 * when the user clicks it. Lazy-mount keeps the wizard's state +
 * useLocalStorage effect out of the initial SSR payload — the launcher
 * itself is near-zero cost.
 *
 * `forceOpen` opens the wizard on mount and is used by the dashboard's
 * fresh-install banner so a brand-new instance lands directly on the
 * provider configuration step instead of expecting the operator to
 * find the "Setup Guide" button.
 */

import { Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

export interface SetupWizardLauncherProps {
  /**
   * If true, the wizard auto-opens on mount and ignores the persisted
   * "completed" marker in localStorage. Used by the dashboard's fresh-
   * install banner.
   *
   * The dashboard is a server component, so this prop is fixed at
   * mount time per render — `forceOpen` only triggers the initial
   * `open` state and does not re-fire on re-renders. If the operator
   * dismisses the wizard, it stays closed for the rest of that page
   * render.
   */
  forceOpen?: boolean;
}

export function SetupWizardLauncher({
  forceOpen = false,
}: SetupWizardLauncherProps): React.ReactElement {
  const [open, setOpen] = useState(forceOpen);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
        Setup Guide
      </Button>
      {open && <SetupWizard open={open} onOpenChange={setOpen} forceOpen={forceOpen} />}
    </>
  );
}
