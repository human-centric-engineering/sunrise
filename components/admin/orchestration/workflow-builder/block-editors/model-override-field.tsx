'use client';

/**
 * The model-override picker every LLM step editor shares (§136 t-1068).
 *
 * A step's `modelOverride` is a model pin (`lib/orchestration/llm/model-pin.ts`):
 * `provider::model`, so a step pinned to Azure's `gpt-4o` runs on Azure and
 * not on whichever provider the model registry gives `gpt-4o`. The picker
 * offers the catalogue's active chat models, one option per provider's model,
 * and writes the pair. It used to be a free-text input for a bare model id.
 *
 * The options come from {@link ModelOptionsProvider}, which the builder fills
 * from one catalogue read, so an editor needs no prop of its own for them.
 * A value the options do not hold is kept and shown as itself rather than
 * dropped: a pin saved by id alone before t-1068 (it runs on the registry's
 * provider for the id until someone picks a model), or a pin the options do
 * not hold — its provider not set up, the model gone from the catalogue, or
 * the catalogue not yet loaded.
 */

import * as React from 'react';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { formatModelPin, parseModelPin } from '@/lib/orchestration/llm/model-pin';

/** One provider's model, as the picker offers it. */
export interface ModelOption {
  providerSlug: string;
  modelId: string;
  name: string;
}

/** A row of `GET /provider-models`, as far as the picker reads it. */
export interface CatalogueModelRow {
  providerSlug: string;
  modelId: string;
  name: string;
  /** Whether the row's provider is set up and active. */
  configuredActive?: boolean;
}

/**
 * The picker's options from catalogue rows: only those whose provider is set
 * up and active, as the default-models form offers, since a step pinned to a
 * provider that is not would fail validation.
 */
export function toModelOptions(rows: readonly CatalogueModelRow[]): ModelOption[] {
  return rows
    .filter((r) => r.configuredActive === true)
    .map((r) => ({ providerSlug: r.providerSlug, modelId: r.modelId, name: r.name }));
}

const ModelOptionsContext = React.createContext<readonly ModelOption[]>([]);

/** Supplies the models every {@link ModelOverrideField} below it offers. */
export function ModelOptionsProvider({
  models,
  children,
}: {
  models: readonly ModelOption[];
  children: React.ReactNode;
}) {
  return <ModelOptionsContext.Provider value={models}>{children}</ModelOptionsContext.Provider>;
}

/** The Select's value for "no override": Radix refuses an empty-string item. */
const NO_OVERRIDE = '__default';

export interface ModelOverrideFieldProps {
  /** The input's id, for the label. */
  id: string;
  /** The step's stored `modelOverride`. */
  value: string | undefined;
  /** Called with the new pin, or `undefined` for no override. */
  onChange: (value: string | undefined) => void;
  /** What the step uses without an override, shown on the "no override" option. */
  defaultLabel?: string;
  /** The ⓘ text; a generic one when omitted. */
  help?: React.ReactNode;
}

export function ModelOverrideField({
  id,
  value,
  onChange,
  defaultLabel = 'The default chat model',
  help,
}: ModelOverrideFieldProps) {
  const models = React.useContext(ModelOptionsContext);
  const options = React.useMemo(
    () =>
      models.map((m) => ({
        value: formatModelPin(m.providerSlug, m.modelId),
        label: `${m.name} (${m.providerSlug})`,
      })),
    [models]
  );
  const current = value ?? '';
  const pin = parseModelPin(current);
  const unlisted =
    pin !== null && !options.some((o) => o.value === current)
      ? {
          value: current,
          label:
            pin.providerSlug === null
              ? `${current} (by model id, no provider)`
              : `${pin.modelId} (${pin.providerSlug}, not offered here)`,
        }
      : null;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex items-center text-xs">
        Model override{' '}
        <FieldHelp title="Model override">
          {help ?? (
            <>
              Optional. Runs just this step on another model — useful for mixing cheap and expensive
              models across a pipeline. Each option is one provider&rsquo;s model, so the step runs
              on exactly that provider.
            </>
          )}
        </FieldHelp>
      </Label>
      <Select
        value={current === '' ? NO_OVERRIDE : current}
        onValueChange={(next) => onChange(next === NO_OVERRIDE ? undefined : next)}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-[60vh]">
          <SelectItem value={NO_OVERRIDE}>{defaultLabel}</SelectItem>
          {unlisted && <SelectItem value={unlisted.value}>{unlisted.label}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
