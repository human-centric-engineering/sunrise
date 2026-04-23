'use client';

/**
 * ImportAgentsDialog (Phase 4 Session 4.2)
 *
 * Upload a previously-exported agent bundle and POST it to
 * `/agents/import`. The user picks a `.json` file and a conflict mode
 * (`skip` — keep existing, default; or `overwrite` — replace existing by
 * slug). The file is parsed client-side so we fail fast on invalid JSON
 * before hitting the server.
 *
 * On success we render the `{ imported, skipped, warnings }` summary
 * inline, then call `onImported` so the parent can refetch its list.
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface ImportAgentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}

type ConflictMode = 'skip' | 'overwrite';

interface ImportResult {
  imported: number;
  overwritten: number;
  skipped: number;
  warnings?: string[];
}

export function ImportAgentsDialog({ open, onOpenChange, onImported }: ImportAgentsDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [conflictMode, setConflictMode] = useState<ConflictMode>('skip');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setFile(null);
      setConflictMode('skip');
      setError(null);
      setResult(null);
    }
  }, [open]);

  async function handleSubmit() {
    if (!file) {
      setError('Pick a JSON bundle first.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      let bundle: unknown;
      try {
        bundle = JSON.parse(text);
      } catch {
        setError('That file is not valid JSON.');
        return;
      }

      const res = await apiClient.post<ImportResult>(API.ADMIN.ORCHESTRATION.AGENTS_IMPORT, {
        body: { bundle, conflictMode },
      });

      setResult(res);
      onImported?.();
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Import failed. Check the bundle shape and try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Import agents{' '}
            <FieldHelp
              title="How import / export works"
              contentClassName="w-96 max-h-80 overflow-y-auto"
            >
              <p>
                A <strong>bundle</strong> is a JSON file that contains one or more agent
                configurations — their name, system instructions, model, temperature, budget, and
                which capabilities are attached. It&apos;s a portable snapshot you can move between
                Sunrise instances (e.g. staging → production) or share with colleagues.
              </p>
              <p className="text-foreground mt-2 font-medium">How to create a bundle</p>
              <p>
                On the agents list, tick the checkboxes next to the agents you want, then click
                <strong> Export selected</strong>. Your browser downloads a <code>.json</code> file.
              </p>
              <p className="text-foreground mt-2 font-medium">How to import a bundle</p>
              <p>
                Open this dialog, pick the <code>.json</code> file, choose a conflict mode, and
                click Import. Agents are matched by <strong>slug</strong> — if a slug already exists
                you can skip it (keep yours) or overwrite it (replace with the bundle copy).
                Capabilities referenced in the bundle that don&apos;t exist here are skipped with a
                warning.
              </p>
              <p className="text-foreground mt-2 font-medium">Example bundle</p>
              <pre className="bg-muted mt-1 overflow-x-auto rounded p-2 text-xs whitespace-pre">
                {`{
  "version": "1",
  "exportedAt": "2026-04-14T...",
  "agents": [
    {
      "name": "Support Triage",
      "slug": "support-triage",
      "description": "Routes tickets...",
      "systemInstructions": "You are...",
      "model": "claude-sonnet-4-6",
      "provider": "anthropic",
      "temperature": 0.7,
      "maxTokens": 4096,
      "monthlyBudgetUsd": 25,
      "isActive": true,
      "capabilities": [
        {
          "slug": "search-knowledge-base",
          "isEnabled": true
        }
      ]
    }
  ]
}`}
              </pre>
            </FieldHelp>
          </DialogTitle>
          <DialogDescription>
            Upload a JSON bundle exported from this or another Sunrise instance. Existing agents
            (matched by slug) are kept by default — choose <em>Overwrite</em> only if you want the
            bundle to replace them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="import-agents-file">
              Bundle file{' '}
              <FieldHelp title="What file do I pick?">
                Choose the <code>.json</code> file you downloaded when you clicked &ldquo;Export
                selected&rdquo; on an agents list (this instance or another Sunrise install). The
                file contains agent configurations — no secrets, API keys, or conversation data are
                included.
              </FieldHelp>
            </Label>
            <Input
              id="import-agents-file"
              type="file"
              accept="application/json,.json"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={submitting}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              When an agent already exists{' '}
              <FieldHelp title="Conflict handling">
                Agents are matched by <strong>slug</strong> (their URL-safe identifier). If a slug
                from the bundle already exists in this instance, you decide what happens.
                &ldquo;Skip&rdquo; is safest — it leaves your current agent untouched.
                &ldquo;Overwrite&rdquo; replaces the existing agent&apos;s entire configuration with
                the bundle copy.
              </FieldHelp>
            </legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="conflict-mode"
                value="skip"
                checked={conflictMode === 'skip'}
                onChange={() => setConflictMode('skip')}
                disabled={submitting}
              />
              Skip — keep the existing agent (recommended)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="conflict-mode"
                value="overwrite"
                checked={conflictMode === 'overwrite'}
                onChange={() => setConflictMode('overwrite')}
                disabled={submitting}
              />
              Overwrite — replace the existing agent with the bundle copy
            </label>
          </fieldset>

          {error && <p className="text-destructive text-sm">{error}</p>}

          {result && (
            <div className="border-border rounded-md border p-3 text-sm">
              <p>
                <strong>Imported:</strong> {result.imported}
                <span className="text-muted-foreground"> · </span>
                <strong>Overwritten:</strong> {result.overwritten}
                <span className="text-muted-foreground"> · </span>
                <strong>Skipped:</strong> {result.skipped}
              </p>
              {result.warnings && result.warnings.length > 0 && (
                <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button onClick={() => void handleSubmit()} disabled={submitting || !file}>
              {submitting ? 'Importing…' : 'Import'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
