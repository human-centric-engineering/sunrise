'use client';

/**
 * DuplicateAgentDialog
 *
 * Deep-clones an agent via `POST /agents/:id/clone`, which copies all
 * fields and capability bindings in a single transaction. The user can
 * override the new agent's `name` and `slug`. On success, navigates
 * to the new agent's edit page.
 *
 * A failure shows above the dialog's buttons and the dialog stays open (§124);
 * raw API error text is only shown when it came from our own APIClientError
 * envelope.
 */

import type { AiAgent } from '@/types/orchestration';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

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
import { slugSchema } from '@/lib/validations/common';

export interface DuplicateAgentDialogProps {
  /** Source agent to clone. `null` closes the dialog. */
  source: AiAgent | null;
  onOpenChange: (open: boolean) => void;
}

export function DuplicateAgentDialog({ source, onOpenChange }: DuplicateAgentDialogProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const save = useSaveFailure({
    fallback: 'Could not duplicate agent. Try again in a moment.',
    fields: NO_SERVER_FIELDS,
  });
  const clearSave = save.clear;
  const [submitting, setSubmitting] = useState(false);

  // Reset inputs each time a new source is selected.
  useEffect(() => {
    if (source) {
      setName(`${source.name} (copy)`);
      setSlug(`${source.slug}-copy`.slice(0, 100));
      clearSave();
    }
  }, [source, clearSave]);

  async function handleSubmit() {
    if (!source) return;
    if (!name.trim() || !slug.trim()) {
      save.show('Name and slug are required.');
      return;
    }
    const slugResult = slugSchema.safeParse(slug.trim());
    if (!slugResult.success) {
      save.show('Slug must be lowercase alphanumeric with single hyphens (e.g. my-agent-copy).');
      return;
    }
    setSubmitting(true);
    save.clear();
    try {
      const created = await apiClient.post<AiAgent>(API.ADMIN.ORCHESTRATION.agentClone(source.id), {
        body: { name: name.trim(), slug: slug.trim() },
      });

      onOpenChange(false);
      router.push(`/admin/orchestration/agents/${created.id}`);
    } catch (err) {
      save.report(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!source} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate agent</DialogTitle>
          <DialogDescription>
            Creates a new agent with the same model, instructions, capabilities, and settings. The
            copy starts inactive so you can review it before turning it on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="duplicate-agent-name">New name</Label>
            <Input
              id="duplicate-agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="duplicate-agent-slug">New slug</Label>
            <Input
              id="duplicate-agent-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={submitting}
            />
          </div>
        </div>

        <SaveError failure={save.failure} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            disabled={submitting || !name.trim() || !slug.trim()}
          >
            {submitting ? 'Duplicating…' : 'Duplicate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
