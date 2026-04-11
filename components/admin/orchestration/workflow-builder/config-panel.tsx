'use client';

/**
 * ConfigPanel — right-hand side panel of the workflow builder.
 *
 * Shows the selected node's type, editable name, read-only step id,
 * and a read-only JSON view of its current config. Per-step-type
 * configuration editors land in Session 5.1b — this panel is
 * intentionally scoped to "see what you clicked + rename + delete" for
 * Session 5.1a.
 *
 * The panel collapses to nothing when no node is selected; the parent
 * builder shell hides the column in that case.
 */

import { useState } from 'react';
import { Check, Copy, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  STEP_CATEGORY_COLOURS,
  STEP_CATEGORY_LABELS,
  getStepMetadata,
} from '@/lib/orchestration/engine/step-registry';
import { cn } from '@/lib/utils';

import type { PatternNode } from './workflow-mappers';

export interface ConfigPanelProps {
  node: PatternNode;
  onLabelChange: (nodeId: string, label: string) => void;
  onDelete: (nodeId: string) => void;
}

export function ConfigPanel({ node, onLabelChange, onDelete }: ConfigPanelProps) {
  const [copied, setCopied] = useState(false);
  const meta = getStepMetadata(node.data.type);
  const colours = STEP_CATEGORY_COLOURS[meta?.category ?? 'input'];
  const Icon = meta?.icon;

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(node.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silently ignore.
    }
  };

  return (
    <aside
      data-testid="config-panel"
      className="bg-background flex h-full w-[320px] shrink-0 flex-col overflow-y-auto border-l p-4"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Step details</h2>
        <Button
          variant="ghost"
          size="sm"
          className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30"
          onClick={() => onDelete(node.id)}
        >
          <Trash2 className="mr-1 h-4 w-4" />
          Delete
        </Button>
      </div>

      {/* Type badge */}
      <div
        className={cn(
          'mb-4 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs',
          colours.bg,
          colours.border,
          colours.text
        )}
      >
        {Icon && <Icon className="h-3.5 w-3.5" />}
        <span className="font-medium">{meta?.label ?? node.data.type}</span>
        <span className="text-muted-foreground ml-auto">
          {STEP_CATEGORY_LABELS[meta?.category ?? 'input']}
        </span>
      </div>

      {/* Editable name */}
      <div className="mb-4 space-y-1.5">
        <Label htmlFor="step-name" className="flex items-center">
          Name{' '}
          <FieldHelp title="Step name">
            The human-readable label shown on the canvas. Change this to describe what the step does
            in plain language. The step <code>id</code> is separate and never changes.
          </FieldHelp>
        </Label>
        <Input
          id="step-name"
          value={node.data.label}
          onChange={(e) => onLabelChange(node.id, e.target.value)}
          placeholder="e.g. Summarise transcript"
        />
      </div>

      {/* Read-only step id */}
      <div className="mb-4 space-y-1.5">
        <Label className="text-muted-foreground text-xs">Step ID</Label>
        <div className="flex items-center gap-2">
          <code className="bg-muted flex-1 rounded px-2 py-1.5 font-mono text-xs break-all">
            {node.id}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copyId()}
            aria-label="Copy step id"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>

      {/* Read-only config JSON */}
      <div className="mb-4 space-y-1.5">
        <Label className="flex items-center text-xs">
          Configuration{' '}
          <FieldHelp title="Step configuration">
            Per-step-type configuration editors (prompt, routes, capability slug, etc.) land in
            Session 5.1b. For now this panel shows the raw JSON that the backend validator reads.
          </FieldHelp>
        </Label>
        <pre
          data-testid="config-panel-json"
          className="bg-muted max-h-72 overflow-auto rounded px-2 py-1.5 font-mono text-[11px] leading-relaxed"
        >
          {JSON.stringify(node.data.config, null, 2)}
        </pre>
      </div>
    </aside>
  );
}
