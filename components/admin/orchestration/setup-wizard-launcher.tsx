'use client';

/**
 * Setup Wizard launcher (Phase 4 Session 4.1)
 *
 * Client island. Renders the "Setup Guide" button in the dashboard
 * header and lazily mounts the SetupWizard component inside a Dialog
 * when the user clicks it. Lazy-mount keeps the wizard's state +
 * useLocalStorage effect out of the initial SSR payload — the launcher
 * itself is near-zero cost.
 */

import { Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

export function SetupWizardLauncher() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="mr-2 h-4 w-4" aria-hidden="true" />
        Setup Guide
      </Button>
      {open && <SetupWizard open={open} onOpenChange={setOpen} />}
    </>
  );
}
