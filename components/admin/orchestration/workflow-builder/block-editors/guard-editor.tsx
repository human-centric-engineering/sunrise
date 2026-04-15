'use client';

/**
 * Guard step editor — safety rules, mode toggle, and fail action.
 */

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from './index';

export interface GuardConfig extends Record<string, unknown> {
  rules: string;
  mode: 'llm' | 'regex';
  failAction: 'block' | 'flag';
  modelOverride?: string;
  temperature?: number;
}

export function GuardEditor({ config, onChange }: EditorProps<GuardConfig>) {
  return (
    <div className="space-y-4">
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

      <div className="space-y-1.5">
        <Label htmlFor="guard-mode" className="flex items-center text-xs">
          Mode{' '}
          <FieldHelp title="Validation mode">
            <strong>LLM</strong> — the model evaluates rules against input (flexible, costs tokens).
            <strong>Regex</strong> — pattern match against input (fast, zero cost).
          </FieldHelp>
        </Label>
        <select
          id="guard-mode"
          value={config.mode ?? 'llm'}
          onChange={(e) => onChange({ mode: e.target.value as 'llm' | 'regex' })}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
        >
          <option value="llm">LLM</option>
          <option value="regex">Regex</option>
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="guard-fail-action" className="flex items-center text-xs">
          Fail action{' '}
          <FieldHelp title="Fail action">
            <strong>Block</strong> — route to the fail output edge. <strong>Flag</strong> — annotate
            the failure but continue to the pass edge.
          </FieldHelp>
        </Label>
        <select
          id="guard-fail-action"
          value={config.failAction ?? 'block'}
          onChange={(e) => onChange({ failAction: e.target.value as 'block' | 'flag' })}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
        >
          <option value="block">Block</option>
          <option value="flag">Flag</option>
        </select>
      </div>
    </div>
  );
}
