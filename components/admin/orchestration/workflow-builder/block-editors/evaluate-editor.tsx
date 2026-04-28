'use client';

/**
 * Evaluate step editor — rubric prompt, scale, and optional threshold.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface EvaluateConfig extends Record<string, unknown> {
  rubric: string;
  scaleMin?: number;
  scaleMax?: number;
  threshold?: number;
  modelOverride?: string;
  temperature?: number;
}

export function EvaluateEditor({ config, onChange }: EditorProps<EvaluateConfig>) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="evaluate-rubric" className="flex items-center text-xs">
          Rubric{' '}
          <FieldHelp title="Scoring rubric">
            The criteria the model uses to score the input. Be specific about what constitutes a
            high vs. low score.
          </FieldHelp>
        </Label>
        <Textarea
          id="evaluate-rubric"
          value={config.rubric ?? ''}
          onChange={(e) => onChange({ rubric: e.target.value })}
          placeholder="e.g. Rate the response on clarity, accuracy, and completeness…"
          rows={5}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="evaluate-scale-min" className="flex items-center text-xs">
            Scale min{' '}
            <FieldHelp title="Scale minimum">
              The lowest score the model can assign. Works with Scale max and Threshold to define
              the evaluation range.
            </FieldHelp>
          </Label>
          <Input
            id="evaluate-scale-min"
            type="number"
            value={config.scaleMin ?? 1}
            onChange={(e) => onChange({ scaleMin: parseFloat(e.target.value) || 1 })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="evaluate-scale-max" className="flex items-center text-xs">
            Scale max{' '}
            <FieldHelp title="Scale maximum">
              The highest score the model can assign. Must be greater than Scale min.
            </FieldHelp>
          </Label>
          <Input
            id="evaluate-scale-max"
            type="number"
            value={config.scaleMax ?? 5}
            onChange={(e) => onChange({ scaleMax: parseFloat(e.target.value) || 5 })}
          />
        </div>
      </div>

      {(config.scaleMin ?? 1) >= (config.scaleMax ?? 5) && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Scale min must be less than scale max.
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="evaluate-threshold" className="flex items-center text-xs">
          Threshold{' '}
          <FieldHelp title="Pass/fail threshold">
            Optional. If set, scores below this value are marked as failed. Leave empty to always
            pass.
          </FieldHelp>
        </Label>
        <Input
          id="evaluate-threshold"
          type="number"
          value={config.threshold ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            onChange({ threshold: val === '' ? undefined : parseFloat(val) });
          }}
          placeholder="e.g. 3"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="evaluate-model-override" className="flex items-center text-xs">
            Model override{' '}
            <FieldHelp title="Model override">
              Optional. Overrides the workflow&rsquo;s default model for just this evaluate step —
              useful for using a cheaper model for simple rubric checks.
            </FieldHelp>
          </Label>
          <Input
            id="evaluate-model-override"
            value={config.modelOverride ?? ''}
            onChange={(e) => onChange({ modelOverride: e.target.value })}
            placeholder="claude-haiku-4-5"
            className="font-mono text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="evaluate-temperature" className="flex items-center text-xs">
            Temperature{' '}
            <FieldHelp title="Temperature">
              Controls randomness. <code>0</code> is deterministic (recommended for consistent
              scoring), <code>1</code> is creative. Default: <code>0.7</code>.
            </FieldHelp>
          </Label>
          <Input
            id="evaluate-temperature"
            type="number"
            step="0.05"
            min={0}
            max={2}
            value={config.temperature ?? 0.7}
            onChange={(e) => onChange({ temperature: Number(e.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}
