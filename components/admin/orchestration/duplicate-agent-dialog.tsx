'use client';

/**
 * DuplicateAgentDialog (Phase 4 Session 4.2)
 *
 * Client-side duplicate flow — there is no `/duplicate` endpoint. When the
 * user confirms, we:
 *
 *   1. GET `/agents/:sourceId` to pick up the full source shape (in case the
 *      row in the table is stale).
 *   2. Build a `createAgentSchema`-shaped payload from the source, dropping
 *      `id` / timestamps / history and overwriting `name` and `slug` with
 *      the user's inputs.
 *   3. POST `/agents` and navigate to the new agent's edit page.
 *
 * Failures render inline; raw API error text is only shown when it came from
 * our own APIClientError envelope.
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
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface DuplicateAgentDialogProps {
  /** Source agent to clone. `null` closes the dialog. */
  source: AiAgent | null;
  onOpenChange: (open: boolean) => void;
}

export function DuplicateAgentDialog({ source, onOpenChange }: DuplicateAgentDialogProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset inputs each time a new source is selected.
  useEffect(() => {
    if (source) {
      setName(`${source.name} (copy)`);
      setSlug(`${source.slug}-copy`);
      setError(null);
    }
  }, [source]);

  async function handleSubmit() {
    if (!source) return;
    if (!name.trim() || !slug.trim()) {
      setError('Name and slug are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Re-fetch source to avoid copying stale row data.
      const fresh = await apiClient.get<AiAgent>(API.ADMIN.ORCHESTRATION.agentById(source.id));

      const payload = {
        name: name.trim(),
        slug: slug.trim(),
        description: fresh.description,
        systemInstructions: fresh.systemInstructions,
        model: fresh.model,
        provider: fresh.provider,
        temperature: fresh.temperature,
        maxTokens: fresh.maxTokens,
        monthlyBudgetUsd: fresh.monthlyBudgetUsd ?? undefined,
        isActive: false,
      };

      const created = await apiClient.post<AiAgent>(API.ADMIN.ORCHESTRATION.AGENTS, {
        body: payload,
      });

      onOpenChange(false);
      router.push(`/admin/orchestration/agents/${created.id}`);
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not duplicate agent. Try again in a moment.'
      );
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
            Creates a new agent with the same model, instructions, and settings. The copy starts
            inactive so you can review it before turning it on.
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
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

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
