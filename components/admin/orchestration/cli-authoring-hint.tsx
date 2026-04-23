'use client';

import { useState } from 'react';
import { Terminal, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';

/**
 * CliAuthoringHint
 *
 * Dismissible informational banner shown on create/edit forms for agents,
 * workflows, and capabilities. Communicates that the recommended authoring
 * path is programmatic (via an AI coding agent such as Claude Code) and
 * that the admin UI is primarily for visualising and managing orchestration.
 *
 * When dismissed, the banner stays hidden for 28 days (stored in
 * localStorage). All resource types share a single dismissal — dismissing
 * on the agent form also hides it on workflows and capabilities.
 */

const STORAGE_KEY = 'sunrise.cli-authoring-hint.dismissed-at';
const DISMISS_DURATION_MS = 28 * 24 * 60 * 60 * 1000; // 28 days

export interface CliAuthoringHintProps {
  /** The resource type being created/edited, e.g. "agents", "workflows". */
  resource: string;
}

export function CliAuthoringHint({ resource }: CliAuthoringHintProps) {
  const [dismissedAt, setDismissedAt] = useLocalStorage<number | null>(STORAGE_KEY, null);

  // Capture "now" once on mount — useState initializer only runs once and
  // avoids the react-hooks/purity error that Date.now() in render triggers.
  const [mountTime] = useState(() => Date.now());
  const isHidden = dismissedAt !== null && mountTime - dismissedAt < DISMISS_DURATION_MS;

  if (isHidden) return null;

  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-900/10">
      <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="text-amber-900 dark:text-amber-100">
          While you can create and edit {resource} here, it is recommended that your engineering
          team authors them programmatically using an AI coding agent such as{' '}
          <span className="font-medium">Claude Code</span> via the CLI.
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          This UI is primarily for visualising, understanding, and managing your agentic
          orchestration.
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-[-2px] h-6 w-6 shrink-0 p-0 text-amber-600 hover:bg-amber-100 hover:text-amber-800 dark:text-amber-400 dark:hover:bg-amber-900/50 dark:hover:text-amber-200"
        onClick={() => setDismissedAt(Date.now())}
      >
        <X className="h-3.5 w-3.5" />
        <span className="sr-only">Dismiss</span>
      </Button>
    </div>
  );
}
