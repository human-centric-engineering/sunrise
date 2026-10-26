'use client';

/**
 * Model parameters past temperature / max tokens / reasoning effort: stop
 * sequences, top P, verbosity, parallel tool calls and service tier.
 *
 * One component for the agent form's Model tab and the `llm_call` step
 * editor, so the help text (which says which models take each one) is
 * written once. Controlled: the caller owns the values and receives each
 * change as a patch. Null means "not set", and the provider default applies.
 */

import { useState } from 'react';

import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  MAX_STOP_SEQUENCES,
  SERVICE_TIERS,
  VERBOSITIES,
  type ServiceTier,
  type Verbosity,
} from '@/lib/orchestration/llm/types';

export interface ModelParamsValue {
  stopSequences: string[];
  topP: number | null;
  verbosity: Verbosity | null;
  parallelToolCalls: boolean | null;
  serviceTier: ServiceTier | null;
}

export type ModelParamField = keyof ModelParamsValue;

export interface ModelParamsFieldsProps {
  /** Prefix for the input ids, so two instances on a page don't collide. */
  idPrefix: string;
  value: ModelParamsValue;
  onChange: (patch: Partial<ModelParamsValue>) => void;
  /** Read-only fields (a platform agent's code-owned ones). */
  isLocked?: (field: ModelParamField) => boolean;
}

/** Radix Select forbids an empty value, so "not set" has a sentinel. */
const UNSET = 'unset';

/** The stop-sequence box's lines that are sequences: blank and whitespace-only lines dropped. */
function stopLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

/** Split the stop-sequence box into its sequences: one per line, at most four. */
export function parseStopSequences(text: string): string[] {
  return stopLines(text).slice(0, MAX_STOP_SEQUENCES);
}

const VERBOSITY_LABELS: Record<Verbosity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const SERVICE_TIER_LABELS: Record<ServiceTier, string> = {
  auto: 'Auto',
  default: 'Default',
  flex: 'Flex (slower, half price)',
  priority: 'Priority (faster, about double)',
};

export function ModelParamsFields({
  idPrefix,
  value,
  onChange,
  isLocked = () => false,
}: ModelParamsFieldsProps) {
  // The box keeps what was typed, blank lines included, so pressing Enter
  // to start the next sequence isn't undone; the caller gets the parsed list.
  // When the list changes from outside (a form reset, a version restore) the
  // box takes the new list instead. "From outside" is judged against the last
  // list this box saw or sent, not against a re-parse of the text, so a
  // stored list the parser would change (a blank entry from raw SQL) is shown
  // once rather than reset on every render.
  const incoming = value.stopSequences.join('\n');
  const [stopText, setStopText] = useState(incoming);
  const [synced, setSynced] = useState(incoming);
  if (incoming !== synced) {
    setSynced(incoming);
    setStopText(incoming);
  }
  const extraStops = stopLines(stopText).length - MAX_STOP_SEQUENCES;

  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-stop-sequences`}>
          Stop sequences{' '}
          <FieldHelp title="Stop sequences">
            <p>
              Text that ends the reply as soon as the model writes it. Put one sequence on each
              line, up to {MAX_STOP_SEQUENCES}. The stop text itself is not included in the reply.
            </p>
            <p className="mt-2">
              Sent to Claude models and to OpenAI-compatible models. OpenAI reasoning models
              (o-series, GPT-5) don&rsquo;t accept it, so it is left out for them. Leave empty for
              none.
            </p>
          </FieldHelp>
        </Label>
        <Textarea
          id={`${idPrefix}-stop-sequences`}
          rows={2}
          value={stopText}
          placeholder="One per line"
          disabled={isLocked('stopSequences')}
          onChange={(e) => {
            const parsed = parseStopSequences(e.target.value);
            setStopText(e.target.value);
            setSynced(parsed.join('\n'));
            onChange({ stopSequences: parsed });
          }}
        />
        {extraStops > 0 && (
          <p className="text-destructive text-xs">
            Only the first {MAX_STOP_SEQUENCES} lines are used. The last {extraStops} will be
            ignored.
          </p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-top-p`}>
          Top P{' '}
          <FieldHelp title="Top P (nucleus sampling)">
            <p>
              Limits each word choice to the most likely options that together make up this share of
              the probability, from 0 to 1. Lower values make replies more predictable. Change this
              or temperature, not both.
            </p>
            <p className="mt-2">
              Only older Claude models (Opus and Sonnet up to 4.6, Haiku 4.5) and non-reasoning
              OpenAI-compatible models accept it. On those Claude models it is sent instead of the
              temperature. Every other model leaves it out. Leave empty for the default.
            </p>
          </FieldHelp>
        </Label>
        <Input
          id={`${idPrefix}-top-p`}
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={value.topP ?? ''}
          placeholder="Model default"
          disabled={isLocked('topP')}
          onChange={(e) =>
            onChange({ topP: e.target.value === '' ? null : Number(e.target.value) })
          }
        />
        {/* Said here as well as by the agent form's validation: a step config
            is only validated when the step runs. */}
        {value.topP !== null && (value.topP < 0 || value.topP > 1) && (
          <p className="text-destructive text-xs">Top P must be between 0 and 1.</p>
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-verbosity`}>
          Verbosity{' '}
          <FieldHelp title="Reply length (GPT-5)">
            How long GPT-5 models make their replies: low for short answers, high for thorough ones.
            Only the GPT-5 family accepts it, and every other model leaves it out.
          </FieldHelp>
        </Label>
        <Select
          value={value.verbosity ?? UNSET}
          disabled={isLocked('verbosity')}
          onValueChange={(v) => onChange({ verbosity: v === UNSET ? null : (v as Verbosity) })}
        >
          <SelectTrigger id={`${idPrefix}-verbosity`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>Model default</SelectItem>
            {VERBOSITIES.map((v) => (
              <SelectItem key={v} value={v}>
                {VERBOSITY_LABELS[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-parallel-tool-calls`}>
          Parallel tool calls{' '}
          <FieldHelp title="Several tool calls at once">
            Whether the model may ask for several tools in one turn. Choose <em>One at a time</em>{' '}
            when tools depend on each other&rsquo;s results or must run in order. Applies to Claude
            and OpenAI models, and only when the agent has tools.
          </FieldHelp>
        </Label>
        <Select
          value={value.parallelToolCalls === null ? UNSET : String(value.parallelToolCalls)}
          disabled={isLocked('parallelToolCalls')}
          onValueChange={(v) => onChange({ parallelToolCalls: v === UNSET ? null : v === 'true' })}
        >
          <SelectTrigger id={`${idPrefix}-parallel-tool-calls`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>Model default (allowed)</SelectItem>
            <SelectItem value="true">Allowed</SelectItem>
            <SelectItem value="false">One at a time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-service-tier`}>
          Service tier{' '}
          <FieldHelp title="OpenAI processing tier">
            <p>
              Which OpenAI processing tier serves the request. Flex is slower and half price, and
              suits background work. Priority is faster and costs about twice as much. Cost tracking
              prices the tier OpenAI reports it used.
            </p>
            <p className="mt-2">
              Sent only when the provider is OpenAI itself (api.openai.com). Not every model offers
              Flex. Leave as the default unless you need one of these.
            </p>
          </FieldHelp>
        </Label>
        <Select
          value={value.serviceTier ?? UNSET}
          disabled={isLocked('serviceTier')}
          onValueChange={(v) => onChange({ serviceTier: v === UNSET ? null : (v as ServiceTier) })}
        >
          <SelectTrigger id={`${idPrefix}-service-tier`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET}>Provider default</SelectItem>
            {SERVICE_TIERS.map((tier) => (
              <SelectItem key={tier} value={tier}>
                {SERVICE_TIER_LABELS[tier]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}
