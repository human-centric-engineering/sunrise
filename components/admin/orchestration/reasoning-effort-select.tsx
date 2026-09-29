'use client';

/**
 * Reusable Reasoning-Effort Select.
 *
 * Single source of truth for the dropdown that exposes
 * `LlmOptions.reasoningEffort` to the admin user — used by the agent
 * form (`agent.reasoningEffort` column) and by every workflow step
 * block-editor whose Zod schema accepts a `reasoningEffort` field.
 *
 * Form convention: `'auto'` is the sentinel for "let the provider apply
 * its default" — Radix `<SelectItem />` forbids an empty-string value,
 * so we can't use `''` even though the database column persists as
 * `null`. The caller's `onChange` is invoked with `'auto'` for the
 * sentinel; the caller is responsible for translating to `null` before
 * persisting.
 *
 * Why one component (not inlined per panel):
 *
 *   - The FieldHelp body is long. Inlining it eight times would
 *     guarantee drift the first time we tweak the copy.
 *   - The per-provider mapping in the help text is a contract reference
 *     — having one canonical place to read it makes future changes
 *     cheap (touch one file, all panels learn).
 *   - Tests get one component to cover, not eight near-duplicates.
 */

import type * as React from 'react';

import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Resolved form value — `'auto'` is the sentinel for null. */
export type ReasoningEffortFormValue = 'auto' | 'minimal' | 'low' | 'medium' | 'high';

/** Convert a database column value (string | null) to the form value. */
export function toReasoningEffortFormValue(
  raw: string | null | undefined
): ReasoningEffortFormValue {
  if (raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return 'auto';
}

/** Convert the form value back to the database column value. */
export function fromReasoningEffortFormValue(
  value: ReasoningEffortFormValue
): 'minimal' | 'low' | 'medium' | 'high' | null {
  return value === 'auto' ? null : value;
}

export interface ReasoningEffortSelectProps {
  /** Stable id used to wire the `<Label htmlFor>` to the `<SelectTrigger>`. */
  id: string;
  /** Resolved form value. Pass `toReasoningEffortFormValue(raw)` if you have a raw column. */
  value: ReasoningEffortFormValue;
  /** Fired with the new form value when the user picks an option. */
  onChange: (value: ReasoningEffortFormValue) => void;
  /**
   * Optional label override. Defaults to `Reasoning effort`. Pass a node
   * (rather than a string) when the caller wants to append context, e.g.
   * `Reasoning effort (planner only)` on the orchestrator panel.
   */
  label?: React.ReactNode;
  /**
   * Surface for the help popover. Defaults to the long-form body that
   * explains the per-provider mapping. Pass a node to override on
   * step-specific surfaces where shorter copy reads better (e.g. the
   * `agent_call` override case).
   */
  help?: React.ReactNode;
  /** Read-only: the value is shown but cannot be changed (the help still opens). */
  disabled?: boolean;
}

const DEFAULT_HELP: React.ReactNode = (
  <>
    <p>
      Controls how much internal reasoning the model does before producing visible output. Honoured
      only by reasoning-capable models:
    </p>
    <ul className="mt-2 list-disc space-y-1 pl-4">
      <li>
        <strong>OpenAI o-series / gpt-5</strong> — sends <code>reasoning_effort</code> with the
        chosen bucket.
      </li>
      <li>
        <strong>Anthropic Claude 4 Opus / Sonnet 4.5+</strong> — enables extended thinking with a
        token budget derived from the bucket (low ≈ 1k, medium ≈ 4k, high ≈ 16k tokens).
      </li>
      <li>
        <strong>All other models</strong> — the field is dropped silently. No 400.
      </li>
    </ul>
    <p className="mt-2">
      Higher effort = more tokens billed per turn. <code>Auto</code> means &ldquo;use the provider
      default&rdquo; — typically <code>medium</code> on reasoning models.
    </p>
  </>
);

export function ReasoningEffortSelect({
  id,
  value,
  onChange,
  label = 'Reasoning effort',
  help = DEFAULT_HELP,
  disabled = false,
}: ReasoningEffortSelectProps) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>
        {label} <FieldHelp title="How much the model thinks before answering">{help}</FieldHelp>
      </Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as ReasoningEffortFormValue)}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto (provider default)</SelectItem>
          <SelectItem value="minimal">Minimal</SelectItem>
          <SelectItem value="low">Low</SelectItem>
          <SelectItem value="medium">Medium</SelectItem>
          <SelectItem value="high">High</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
