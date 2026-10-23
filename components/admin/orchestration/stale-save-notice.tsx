'use client';

/**
 * Shown when a save is refused because the record changed since the page
 * loaded it (412 `STALE_RECORD`, §122 t-899): another admin saved it, or a
 * person on it had their data erased.
 *
 * Nothing was written, and the admin's edits are still in the form. Reloading
 * would discard them, so the notice says so and leaves the reload to them
 * rather than doing it.
 *
 * @see lib/api/record-version.ts
 */

import { AlertTriangle, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export interface StaleSaveNoticeProps {
  /** What changed, as the start of a sentence: "The escalation list". */
  what: string;
  /** Called instead of reloading the page, for a list that can reload its own data. */
  onReload?: () => void;
}

export function StaleSaveNotice({ what, onReload }: StaleSaveNoticeProps) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 sm:flex-row sm:items-start dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1 space-y-1">
        <p className="font-medium">{what} changed since you opened it. Nothing was saved.</p>
        <p>
          Someone else saved it, or a person on it had their data erased. Your changes are still
          here: note anything you want to keep, then reload to see the current version and make them
          again.
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => (onReload ? onReload() : window.location.reload())}
      >
        <RotateCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Reload
      </Button>
    </div>
  );
}
