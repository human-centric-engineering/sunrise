'use client';

/**
 * Audit Models Dialog
 *
 * Lets admins select a subset of provider models and trigger the
 * Provider Model Audit workflow. This is both a genuinely useful
 * feature (keeps the model registry accurate) and a framework
 * reference implementation that exercises 11 of 15 orchestration
 * step types end-to-end.
 *
 * On submit, creates a workflow execution via the standard API and
 * redirects to the execution detail page where the existing SSE
 * streaming panel, approval queue, and trace viewer handle the rest.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { TIER_ROLE_META, type TierRole } from '@/types/orchestration';
import type { ModelRow } from '@/components/admin/orchestration/provider-models-matrix';

interface AuditModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: ModelRow[];
}

const AUDIT_WORKFLOW_SLUG = 'tpl-provider-model-audit';

export function AuditModelsDialog({
  open,
  onOpenChange,
  models,
}: AuditModelsDialogProps): React.ReactElement {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set(models.map((m) => m.id)));
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providers = useMemo(() => [...new Set(models.map((m) => m.providerSlug))].sort(), [models]);

  const filtered = useMemo(() => {
    if (providerFilter === 'all') return models;
    return models.filter((m) => m.providerSlug === providerFilter);
  }, [models, providerFilter]);

  const toggleModel = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    const filteredIds = filtered.map((m) => m.id);
    const allSelected = filteredIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of filteredIds) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }, [filtered, selected]);

  const handleSubmit = useCallback(async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);

    try {
      // Find the audit workflow by slug
      const workflows = await apiClient.get<{ id: string; slug: string }[]>(
        API.ADMIN.ORCHESTRATION.WORKFLOWS,
        { params: { slug: AUDIT_WORKFLOW_SLUG, limit: 1 } }
      );

      const workflow = Array.isArray(workflows)
        ? workflows.find((w) => w.slug === AUDIT_WORKFLOW_SLUG)
        : null;

      if (!workflow) {
        setError(
          'Audit workflow template not found. Run db:seed to create it, or create a workflow from the "Provider Model Audit" template.'
        );
        setSubmitting(false);
        return;
      }

      // Build input data with selected model details
      const selectedModels = models.filter((m) => selected.has(m.id));
      const inputData = {
        modelIds: selectedModels.map((m) => m.id),
        models: selectedModels.map((m) => ({
          id: m.id,
          name: m.name,
          modelId: m.modelId,
          providerSlug: m.providerSlug,
          capabilities: m.capabilities,
          tierRole: m.tierRole,
          reasoningDepth: m.reasoningDepth,
          latency: m.latency,
          costEfficiency: m.costEfficiency,
          contextLength: m.contextLength,
          toolUse: m.toolUse,
          bestRole: m.bestRole,
          dimensions: m.dimensions,
          schemaCompatible: m.schemaCompatible,
        })),
      };

      // Execute the workflow
      const execution = await apiClient.post<{ id: string }>(
        API.ADMIN.ORCHESTRATION.workflowExecute(workflow.id),
        { body: { inputData } }
      );

      onOpenChange(false);
      router.push(`/admin/orchestration/executions/${execution.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start audit');
      setSubmitting(false);
    }
  }, [selected, models, onOpenChange, router]);

  const allFilteredSelected = filtered.every((m) => selected.has(m.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            Review Models
            <FieldHelp title="Framework Reference Implementation">
              This dialog triggers the Provider Model Audit workflow — a 10-step DAG that exercises
              11 of 15 orchestration step types. It tests prompt chaining, routing, parallelisation,
              reflection, tool use, guardrails, evaluation, human-in-the-loop approval, RAG
              retrieval, and notifications. Selected model IDs become the workflow&apos;s{' '}
              <code>inputData</code>, testing the engine&apos;s input parameter passing and template
              interpolation.
            </FieldHelp>
          </DialogTitle>
          <DialogDescription>
            Select the models to audit. The AI will evaluate each model&apos;s classification and
            propose changes for your review.
          </DialogDescription>
        </DialogHeader>

        {/* Filter */}
        <div className="flex items-center gap-3">
          <Select value={providerFilter} onValueChange={setProviderFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All providers</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p} value={p} className="capitalize">
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="ghost" size="sm" onClick={toggleAll}>
            {allFilteredSelected ? 'Deselect all' : 'Select all'}
          </Button>

          <span className="text-muted-foreground ml-auto text-sm">
            {selected.size} of {models.length} selected
          </span>
        </div>

        {/* Model list */}
        <div className="max-h-[300px] overflow-y-auto rounded-md border">
          <div className="divide-y">
            {filtered.map((model) => (
              <div
                key={model.id}
                role="button"
                tabIndex={0}
                className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2"
                onClick={() => toggleModel(model.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleModel(model.id);
                  }
                }}
              >
                <Checkbox
                  checked={selected.has(model.id)}
                  onCheckedChange={() => toggleModel(model.id)}
                  aria-label={`Select ${model.name} for audit`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{model.name}</span>
                    <Badge variant="secondary" className="shrink-0 text-[10px]">
                      {TIER_ROLE_META[model.tierRole as TierRole]?.label ?? model.tierRole}
                    </Badge>
                    {model.capabilities.includes('embedding') && (
                      <Badge
                        variant="outline"
                        className="shrink-0 bg-amber-100 text-[10px] text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                      >
                        Embedding
                      </Badge>
                    )}
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {model.providerSlug} / {model.modelId}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting || selected.size === 0}>
            {submitting
              ? 'Starting audit...'
              : `Audit ${selected.size} model${selected.size !== 1 ? 's' : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
