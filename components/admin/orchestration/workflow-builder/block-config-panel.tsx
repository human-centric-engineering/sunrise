'use client';

/**
 * BlockConfigPanel — right-hand side panel of the workflow builder.
 *
 * Replaces the Session 5.1a `ConfigPanel` shell. Structure (top → bottom):
 *
 *   1. Type badge + Delete button
 *   2. Editable step name
 *   3. Read-only step id with copy button
 *   4. **Per-step-type editor** — switched on `node.data.type`, picks the
 *      matching component from `./block-editors`
 *
 * The editor section is where Session 5.1b adds its weight. Every edit
 * calls `onConfigChange(nodeId, partial)` and the builder shell merges the
 * partial into the node's `data.config`. There is deliberately no editor
 * state — the canvas remains the single source of truth.
 */

import { useState } from 'react';
import { Check, Copy, Trash2 } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
import {
  ChainEditor,
  EvaluateEditor,
  ExternalCallEditor,
  GuardEditor,
  HumanApprovalEditor,
  LlmCallEditor,
  ParallelEditor,
  PlanEditor,
  RagRetrieveEditor,
  ReflectEditor,
  RouteEditor,
  ToolCallEditor,
  type CapabilityOption,
} from './block-editors';

export interface BlockConfigPanelProps {
  node: PatternNode;
  onLabelChange: (nodeId: string, label: string) => void;
  onConfigChange: (nodeId: string, partial: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
  capabilities: readonly CapabilityOption[];
}

export function BlockConfigPanel({
  node,
  onLabelChange,
  onConfigChange,
  onDelete,
  capabilities,
}: BlockConfigPanelProps) {
  const [copied, setCopied] = useState(false);
  const meta = getStepMetadata(node.data.type);
  const colours = STEP_CATEGORY_COLOURS[meta?.category ?? 'input'];
  const Icon = meta?.icon;

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(node.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silently ignore.
    }
  };

  // One shared callback that just forwards into the builder shell's
  // `handleConfigChange`. Every editor gets the same function so switching
  // blocks doesn't re-create listeners.
  const handleChange = (partial: Record<string, unknown>): void => {
    onConfigChange(node.id, partial);
  };

  return (
    <aside
      data-testid="config-panel"
      className="bg-background flex h-full w-[360px] shrink-0 flex-col overflow-y-auto border-l p-4"
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

      {/* Type-specific editor */}
      <div className="mt-2 border-t pt-4">
        <h3 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">
          Configuration
        </h3>
        <BlockEditor node={node} onChange={handleChange} capabilities={capabilities} />
      </div>

      {/* Error handling overrides */}
      <div className="mt-2 border-t pt-4">
        <h3 className="text-muted-foreground mb-3 text-xs font-semibold tracking-wide uppercase">
          Error handling
        </h3>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="error-strategy" className="flex items-center">
              Strategy{' '}
              <FieldHelp title="Error strategy">
                Choose how this step handles failures. &ldquo;Inherit&rdquo; uses the workflow-level
                default. Override per step to retry, fall back to another step, skip, or fail
                immediately.
              </FieldHelp>
            </Label>
            <Select
              value={(node.data.config.errorStrategy as string) ?? '__inherit__'}
              onValueChange={(v) =>
                handleChange({
                  errorStrategy: v === '__inherit__' ? undefined : v,
                  // Clear conditional fields when switching strategy
                  ...(v !== 'retry' ? { retryCount: undefined } : {}),
                  ...(v !== 'fallback' ? { fallbackStepId: undefined } : {}),
                })
              }
            >
              <SelectTrigger id="error-strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__inherit__">Inherit from workflow</SelectItem>
                <SelectItem value="retry">Retry</SelectItem>
                <SelectItem value="fallback">Fallback</SelectItem>
                <SelectItem value="skip">Skip</SelectItem>
                <SelectItem value="fail">Fail</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(node.data.config.errorStrategy as string) === 'retry' && (
            <div className="space-y-1.5">
              <Label htmlFor="retry-count" className="flex items-center">
                Retry count{' '}
                <FieldHelp title="Retry count">
                  Number of times to retry the step before giving up. Each retry re-executes the
                  step from scratch.
                </FieldHelp>
              </Label>
              <Input
                id="retry-count"
                type="number"
                min={0}
                max={10}
                value={(node.data.config.retryCount as number) ?? 2}
                onChange={(e) =>
                  handleChange({ retryCount: Math.min(10, Math.max(0, Number(e.target.value))) })
                }
              />
            </div>
          )}

          {(node.data.config.errorStrategy as string) === 'fallback' && (
            <div className="space-y-1.5">
              <Label htmlFor="fallback-step" className="flex items-center">
                Fallback step ID{' '}
                <FieldHelp title="Fallback step">
                  The ID of the step to execute if this step fails. Must be a valid step in the
                  workflow.
                </FieldHelp>
              </Label>
              <Input
                id="fallback-step"
                value={(node.data.config.fallbackStepId as string) ?? ''}
                onChange={(e) => handleChange({ fallbackStepId: e.target.value || undefined })}
                placeholder="e.g. step_summarise_fallback"
              />
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * Pick the right editor for the node's step type. Unknown types render a
 * fallback hint instead of throwing — new types added to the registry at
 * runtime shouldn't crash the panel.
 */
function BlockEditor({
  node,
  onChange,
  capabilities,
}: {
  node: PatternNode;
  onChange: (partial: Record<string, unknown>) => void;
  capabilities: readonly CapabilityOption[];
}) {
  const config = node.data.config;

  switch (node.data.type) {
    case 'llm_call':
      return <LlmCallEditor config={config as never} onChange={onChange as never} />;
    case 'chain':
      return <ChainEditor config={config as never} onChange={onChange as never} />;
    case 'route':
      return <RouteEditor config={config as never} onChange={onChange as never} />;
    case 'parallel':
      return <ParallelEditor config={config as never} onChange={onChange as never} />;
    case 'reflect':
      return <ReflectEditor config={config as never} onChange={onChange as never} />;
    case 'tool_call':
      return (
        <ToolCallEditor
          config={config as never}
          onChange={onChange as never}
          capabilities={capabilities}
        />
      );
    case 'plan':
      return <PlanEditor config={config as never} onChange={onChange as never} />;
    case 'human_approval':
      return <HumanApprovalEditor config={config as never} onChange={onChange as never} />;
    case 'rag_retrieve':
      return <RagRetrieveEditor config={config as never} onChange={onChange as never} />;
    case 'guard':
      return <GuardEditor config={config as never} onChange={onChange as never} />;
    case 'evaluate':
      return <EvaluateEditor config={config as never} onChange={onChange as never} />;
    case 'external_call':
      return <ExternalCallEditor config={config as never} onChange={onChange as never} />;
    default:
      return (
        <p className="text-muted-foreground text-xs italic">
          No editor registered for step type <code>{node.data.type}</code>.
        </p>
      );
  }
}
