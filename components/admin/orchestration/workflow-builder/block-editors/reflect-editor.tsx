'use client';

/**
 * Reflect step editor — critique prompt + max iterations.
 *
 * The "reflect" pattern is a draft → critique → revise loop: the agent
 * produces a draft, critiques it against `critiquePrompt`, then revises.
 * `maxIterations` bounds the loop so a stuck critic doesn't spin forever.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface ReflectConfig extends Record<string, unknown> {
  critiquePrompt: string;
  maxIterations?: number;
  modelOverride?: string;
  temperature?: number;
}

export function ReflectEditor({ config, onChange }: EditorProps<ReflectConfig>) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="reflect-critique" className="flex items-center text-xs">
          Critique prompt{' '}
          <FieldHelp title="Critique prompt">
            Instructions the agent follows to critique its own draft. A good critique prompt names
            specific failure modes (&ldquo;check for factual errors&rdquo;, &ldquo;flag ambiguous
            pronouns&rdquo;) rather than asking for generic improvement.
          </FieldHelp>
        </Label>
        <Textarea
          id="reflect-critique"
          value={config.critiquePrompt ?? ''}
          onChange={(e) => onChange({ critiquePrompt: e.target.value })}
          placeholder="Check the draft for factual errors, unsupported claims, and…"
          rows={5}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="reflect-max-iter" className="flex items-center text-xs">
          Max iterations{' '}
          <FieldHelp title="Max iterations">
            The agent will revise up to this many times before accepting the output. Default:
            <code>3</code>. Higher values improve quality but cost more tokens.
          </FieldHelp>
        </Label>
        <Input
          id="reflect-max-iter"
          type="number"
          min={1}
          max={10}
          value={config.maxIterations ?? 3}
          onChange={(e) => onChange({ maxIterations: Number(e.target.value) })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="reflect-model-override" className="flex items-center text-xs">
          Model override{' '}
          <FieldHelp title="Model override">
            Optional. Overrides the workflow&rsquo;s default model for the critique and revision LLM
            calls.
          </FieldHelp>
        </Label>
        <Input
          id="reflect-model-override"
          value={config.modelOverride ?? ''}
          onChange={(e) => onChange({ modelOverride: e.target.value || undefined })}
          placeholder="claude-haiku-4-5"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="reflect-temperature" className="flex items-center text-xs">
          Temperature{' '}
          <FieldHelp title="Temperature">
            Controls randomness. Default: <code>0.3</code> (conservative for critique).
          </FieldHelp>
        </Label>
        <Input
          id="reflect-temperature"
          type="number"
          step="0.05"
          min={0}
          max={2}
          value={config.temperature ?? 0.3}
          onChange={(e) => onChange({ temperature: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
