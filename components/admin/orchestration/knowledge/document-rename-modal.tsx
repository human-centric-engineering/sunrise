'use client';

/**
 * Rename a knowledge document's display name without leaving the list.
 *
 * Opened from the per-row actions menu on the Manage tab. Saving PATCHes
 * `/admin/orchestration/knowledge/documents/[id]` with the new `name` and
 * refreshes the parent server-rendered list so the table reflects it.
 *
 * Kept separate from `DocumentTagsModal` so each modal has one job — this
 * one edits the name, that one edits which agents can find the doc.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';

const MAX_NAME_LENGTH = 255;

export interface DocumentRenameModalProps {
  documentId: string | null;
  documentName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save so the parent can refresh its list. */
  onSaved?: () => void;
}

export function DocumentRenameModal({
  documentId,
  documentName,
  open,
  onOpenChange,
  onSaved,
}: DocumentRenameModalProps): React.ReactElement {
  const router = useRouter();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const failure = useSaveFailure({
    fallback: 'Could not rename the document. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const clearFailure = failure.clear;

  // Seed the input from the current name each time the modal opens.
  useEffect(() => {
    if (open) setName(documentName ?? '');
  }, [open, documentName]);

  const trimmed = name.trim();
  const dirty = trimmed.length > 0 && trimmed !== (documentName ?? '').trim();

  async function save(): Promise<void> {
    if (!documentId || !dirty) return;
    setSaving(true);
    failure.clear();
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(documentId), {
        body: { name: trimmed },
      });
      // Refresh the parent server-rendered list so the row label updates.
      router.refresh();
      onSaved?.();
      onOpenChange(false);
    } catch (err) {
      failure.report(err);
    } finally {
      setSaving(false);
    }
  }

  // Committed while the save is in flight, so its failure is shown here.
  const dialog = useCommittedDialog({
    open,
    pending: saving,
    onClose: () => onOpenChange(false),
    clear: clearFailure,
  });

  return (
    <Dialog open={open} onOpenChange={dialog.onOpenChange}>
      <DialogContent className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5" />
            Rename document
          </DialogTitle>
          <DialogDescription>
            Change the display name shown in the document list. This doesn&apos;t re-process the
            file or change its chunks.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="document-name">Name</Label>
          <Input
            id="document-name"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(e) => {
              setName(e.target.value);
              // A refusal was about the name it was given; editing answers it.
              failure.clear();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && dirty && !saving) {
                e.preventDefault();
                void save();
              }
            }}
            placeholder="Document name"
            aria-invalid={failure.failure ? true : undefined}
          />
        </div>

        <SaveError failure={failure.failure} />

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} {...dialog.cancelProps}>
            Cancel
          </Button>
          <Button
            {...dialog.actionProps({ disabled: !dirty })}
            onClick={(e) => dialog.confirm(e, save)}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
