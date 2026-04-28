'use client';

/**
 * Guard step editor — safety rules, mode toggle, and fail action.
 */

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

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

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
        <Select
          value={config.mode ?? 'llm'}
          onValueChange={(value) => onChange({ mode: value as 'llm' | 'regex' })}
        >
          <SelectTrigger id="guard-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="llm">LLM</SelectItem>
            <SelectItem value="regex">Regex</SelectItem>
          </SelectContent>
        </Select>
      </div>

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
    </div>
  );
}
