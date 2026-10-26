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
import { narrowReasoningEffort } from '@/lib/orchestration/llm/model-heuristics';
import { REASONING_EFFORTS, type ReasoningEffort } from '@/lib/orchestration/llm/types';

/** Resolved form value — `'auto'` is the sentinel for null. */
export type ReasoningEffortFormValue = 'auto' | ReasoningEffort;

/** Every form value, `'auto'` first — for a caller's Zod schema. */
export const REASONING_EFFORT_FORM_VALUES = ['auto', ...REASONING_EFFORTS] as const;

/** Convert a database column value (string | null) to the form value. */
export function toReasoningEffortFormValue(
  raw: string | null | undefined
): ReasoningEffortFormValue {
  return narrowReasoningEffort(raw) ?? 'auto';
}

/** Convert the form value back to the database column value. */
export function fromReasoningEffortFormValue(
  value: ReasoningEffortFormValue
): ReasoningEffort | null {
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
        chosen level. Extra high and Max are sent as <code>high</code>, because not every OpenAI
        model accepts them.
      </li>
      <li>
        <strong>Claude Opus 4.7+, Sonnet 5+, Haiku 5+, Fable</strong> — sends the chosen level as
        the model&rsquo;s effort setting. Minimal is sent as low.
      </li>
      <li>
        <strong>Older Claude models (Opus 4–4.6, Sonnet 4.5–4.6, Haiku 4.5)</strong> — turns on
        extended thinking with a token budget for the level (low ≈ 1k, medium ≈ 4k, high ≈ 16k,
        extra high ≈ 32k, max ≈ 64k tokens), kept below the agent&rsquo;s max output tokens.
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
          <SelectItem value="xhigh">Extra high</SelectItem>
          <SelectItem value="max">Max</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
