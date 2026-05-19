'use client';

/**
 * Guard step editor — safety rules, mode toggle, and fail action.
 */

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
import { FieldHelp } from '@/components/ui/field-help';
import {
  ReasoningEffortSelect,
  fromReasoningEffortFormValue,
  toReasoningEffortFormValue,
} from '@/components/admin/orchestration/reasoning-effort-select';

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface GuardConfig extends Record<string, unknown> {
  rules: string;
  mode: 'llm' | 'regex' | 'schema';
  failAction: 'block' | 'flag';
  modelOverride?: string;
  temperature?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | null;
  /**
   * Required when `mode === 'schema'`. Slug into the schema registry
   * (`lib/orchestration/schemas/registry.ts`). The executor surfaces
   * `schema_not_found` if the named schema isn't registered.
   */
  schemaName?: string;
  /**
   * Optional in schema mode. When set, the executor validates
   * `ctx.stepOutputs[inputStepId]`. When absent, validates the
   * workflow input (`ctx.inputData`).
   */
  inputStepId?: string;
  /** When > 0, the fail edge becomes a bounded retry back-edge. */
  maxRetries?: number;
}

export function GuardEditor({ config, onChange }: EditorProps<GuardConfig>) {
  const mode = config.mode ?? 'llm';
  return (
    <div className="space-y-4">
      {/* `rules` is only meaningful in LLM and regex modes. Hiding it
          in schema mode avoids the "why is there a Rules textbox if
          I'm using a schema?" confusion and keeps the panel scannable. */}
      {mode !== 'schema' && (
        <div className="space-y-1.5">
          <Label htmlFor="guard-rules" className="flex items-center text-xs">
            Rules{' '}
            <FieldHelp title="Guard rules">
              In LLM mode: natural-language safety rules the model checks against. In regex mode: a
              regular expression pattern to test against the input.
            </FieldHelp>
          </Label>
          <Textarea
            id="guard-rules"
            value={config.rules ?? ''}
            onChange={(e) => onChange({ rules: e.target.value })}
            placeholder="e.g. Reject any input containing personal identifiable information…"
            rows={5}
          />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="guard-mode" className="flex items-center text-xs">
          Mode{' '}
          <FieldHelp title="Validation mode">
            <strong>LLM</strong> — the model evaluates rules against input (flexible, costs tokens,
            judgment-based; not reliable for closed-set / enum checks).
            <br />
            <strong>Regex</strong> — pattern match against input (fast, zero cost, structural).
            <br />
            <strong>Schema</strong> — validate an upstream step&rsquo;s output against a registered
            Zod schema (deterministic, zero LLM cost). Use this for shape / enum / required-field
            checks where LLM mode hallucinates. Authors register schemas in code via{' '}
            <code>registerSchema</code>.
          </FieldHelp>
        </Label>
        <Select
          value={mode}
          onValueChange={(value) => onChange({ mode: value as 'llm' | 'regex' | 'schema' })}
        >
          <SelectTrigger id="guard-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="llm">LLM</SelectItem>
            <SelectItem value="regex">Regex</SelectItem>
            <SelectItem value="schema">Schema</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === 'schema' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="guard-schema-name" className="flex items-center text-xs">
              Schema name{' '}
              <FieldHelp title="Registered schema name">
                The schema slug from <code>lib/orchestration/schemas/registry.ts</code>. The
                executor looks the schema up at run time; if it&rsquo;s not registered the step
                fails with <code>schema_not_found</code>. Authors register schemas in feature
                modules (<code>lib/orchestration/&lt;feature&gt;/schemas.ts</code>) imported on app
                start.
              </FieldHelp>
            </Label>
            <Input
              id="guard-schema-name"
              value={config.schemaName ?? ''}
              onChange={(e) => onChange({ schemaName: e.target.value })}
              placeholder="e.g. audit-proposals"
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="guard-input-step-id" className="flex items-center text-xs">
              Input step ID (optional){' '}
              <FieldHelp title="Input step">
                Step ID whose <code>output</code> is validated. Leave blank to validate the
                workflow&rsquo;s input data instead. The validator surfaces{' '}
                <code>input_step_not_found</code> if the named step has not completed before this
                guard runs.
              </FieldHelp>
            </Label>
            <Input
              id="guard-input-step-id"
              value={config.inputStepId ?? ''}
              onChange={(e) => onChange({ inputStepId: e.target.value })}
              placeholder="e.g. analyse_chat"
              className="font-mono text-xs"
            />
          </div>
        </>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="guard-fail-action" className="flex items-center text-xs">
          Fail action{' '}
          <FieldHelp title="Fail action">
            <strong>Block</strong> — route to the fail output edge. <strong>Flag</strong> — annotate
            the failure but continue to the pass edge.
          </FieldHelp>
        </Label>
        <Select
          value={config.failAction ?? 'block'}
          onValueChange={(value) => onChange({ failAction: value as 'block' | 'flag' })}
        >
          <SelectTrigger id="guard-fail-action">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="block">Block</SelectItem>
            <SelectItem value="flag">Flag</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {(config.failAction ?? 'block') === 'block' && (
        <div className="space-y-1.5">
          <Label htmlFor="guard-max-retries" className="flex items-center text-xs">
            Retry on failure{' '}
            <FieldHelp title="Bounded retry">
              When the guard fails, send execution back to an earlier step for another attempt. The
              fail edge must be wired to the retry target on the canvas. Set to <code>0</code> to
              disable (guard blocks on failure). Max <code>10</code>.
            </FieldHelp>
          </Label>
          <Input
            id="guard-max-retries"
            type="number"
            min={0}
            max={10}
            step={1}
            value={config.maxRetries ?? 0}
            onChange={(e) =>
              onChange({ maxRetries: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })
            }
          />
          {(config.maxRetries ?? 0) > 0 && (
            <p className="text-muted-foreground text-[11px]">
              Wire the guard&apos;s <strong>Fail</strong> output to the step you want to retry. The
              edge will allow up to {config.maxRetries} retry attempt
              {(config.maxRetries ?? 0) > 1 ? 's' : ''}.
            </p>
          )}
        </div>
      )}

      {mode === 'llm' && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="guard-model-override" className="flex items-center text-xs">
              Model override{' '}
              <FieldHelp title="Model override">
                Optional. Overrides the workflow&rsquo;s default model for just this guard step —
                useful for using a cheaper model for simple rule checks.
              </FieldHelp>
            </Label>
            <Input
              id="guard-model-override"
              value={config.modelOverride ?? ''}
              onChange={(e) => onChange({ modelOverride: e.target.value })}
              placeholder="claude-haiku-4-5"
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="guard-temperature" className="flex items-center text-xs">
              Temperature{' '}
              <FieldHelp title="Temperature">
                Controls randomness. <code>0</code> is deterministic (recommended for safety rules),{' '}
                <code>1</code> is creative. Default: <code>0.1</code>.
              </FieldHelp>
            </Label>
            <Input
              id="guard-temperature"
              type="number"
              step="0.05"
              min={0}
              max={2}
              value={config.temperature ?? 0.1}
              onChange={(e) => onChange({ temperature: Number(e.target.value) })}
            />
          </div>

          <ReasoningEffortSelect
            id="guard-reasoning-effort"
            value={toReasoningEffortFormValue(config.reasoningEffort)}
            onChange={(v) => onChange({ reasoningEffort: fromReasoningEffortFormValue(v) })}
          />
        </>
      )}
    </div>
  );
}
