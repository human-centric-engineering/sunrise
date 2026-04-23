'use client';

/**
 * LLM Call step editor — prompt template, optional model override, and
 * optional temperature. Model override is an open `<Input>` rather than a
 * select because the provider/model picker lives in `AgentForm` and the
 * workflow builder doesn't yet fetch the model catalogue. Session 5.1c
 * may upgrade this to a real dropdown if needed.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface LlmCallConfig extends Record<string, unknown> {
  prompt: string;
  modelOverride?: string;
  temperature?: number;
}

export function LlmCallEditor({ config, onChange }: EditorProps<LlmCallConfig>) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="llm-prompt" className="flex items-center text-xs">
          Prompt template{' '}
          <FieldHelp title="Prompt template">
            The text sent to the model when this step runs. Use <code>{'{{variables}}'}</code> to
            reference earlier step outputs. Required.
          </FieldHelp>
        </Label>
        <Textarea
          id="llm-prompt"
          value={config.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder="Summarise the following transcript…"
          rows={6}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="llm-model-override" className="flex items-center text-xs">
          Model override{' '}
          <FieldHelp title="Model override">
            Optional. Overrides the workflow&rsquo;s default model for just this step — useful for
            mixing cheap and expensive models across a pipeline.
          </FieldHelp>
        </Label>
        <Input
          id="llm-model-override"
          value={config.modelOverride ?? ''}
          onChange={(e) => onChange({ modelOverride: e.target.value })}
          placeholder="claude-haiku-4-5"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="llm-temperature" className="flex items-center text-xs">
          Temperature{' '}
          <FieldHelp title="Temperature">
            Controls randomness. <code>0</code> is deterministic, <code>1</code> is creative.
            Default: <code>0.7</code>.
          </FieldHelp>
        </Label>
        <Input
          id="llm-temperature"
          type="number"
          step="0.05"
          min={0}
          max={2}
          value={config.temperature ?? 0.7}
          onChange={(e) => onChange({ temperature: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
