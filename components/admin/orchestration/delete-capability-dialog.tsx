'use client';

/**
 * DeleteCapabilityDialog (Phase 4 Session 4.3)
 *
 * Inline AlertDialog for soft-deleting a capability. Accepts a list of
 * agents currently using the capability so admins can see which agents
 * will lose this tool before they confirm.
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { agentCount, OtherOrgUsage } from '@/components/admin/orchestration/other-org-usage';

export interface DeleteCapabilityTarget {
  id: string;
  name: string;
}

export interface UsedByAgent {
  id: string;
  name: string;
  slug: string;
}

export interface DeleteCapabilityDialogProps {
  target: DeleteCapabilityTarget | null;
  usedBy: UsedByAgent[];
  /** Agents in other orgs using it: counted, never named (§107 t-752). */
  otherOrgAgentCount?: number;
  error: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteCapabilityDialog({
  target,
  usedBy,
  otherOrgAgentCount = 0,
  error,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteCapabilityDialogProps) {
  return (
    <AlertDialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete capability</AlertDialogTitle>
          <AlertDialogDescription>
            This soft-deletes <strong>{target?.name}</strong> — it will stop being offered to agents
            on new chats, but its execution history is preserved. You can reactivate it by flipping
            its status back on.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {usedBy.length + otherOrgAgentCount > 0 && (
          <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <p className="font-medium">
              {agentCount(usedBy.length + otherOrgAgentCount)} currently using this capability
              {usedBy.length > 0 ? ':' : '.'}
            </p>
            {usedBy.length > 0 && (
              <ul className="text-muted-foreground mt-1 list-inside list-disc">
                {usedBy.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    {a.name} <span className="font-mono text-xs">({a.slug})</span>
                  </li>
                ))}
                {usedBy.length > 8 && <li>…and {usedBy.length - 8} more</li>}
              </ul>
            )}
            <OtherOrgUsage
              count={otherOrgAgentCount}
              afterList={usedBy.length > 0}
              className="mt-1"
            />
          </div>
        )}

        {error && <p className="text-destructive text-sm">{error}</p>}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-red-600 hover:bg-red-700"
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
