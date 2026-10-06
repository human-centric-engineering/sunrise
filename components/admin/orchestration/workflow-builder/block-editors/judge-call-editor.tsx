'use client';

/**
 * Judge Call step editor — drive an evaluation judge agent inline.
 *
 * Mirrors the run-create form's judge picker shape: every kind='judge'
 * agent appears in the dropdown so a workflow author can pick the same
 * rubric admin batch-eval runs use. The question / answer / expected
 * fields accept template syntax (`{{previous.output}}`,
 * `{{stepId.output}}`) so the prompt is glued together at run time.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface JudgeCallConfig extends Record<string, unknown> {
  judgeAgentSlug: string;
  question: string;
  answer: string;
  expectedOutput?: string;
  subjectBrandVoice?: string;
  threshold?: number;
}

export function JudgeCallEditor({ config, onChange }: EditorProps<JudgeCallConfig>) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="judge-call-agent-slug" className="flex items-center text-xs">
          Judge agent slug{' '}
          <FieldHelp title="Judge agent">
            The slug of an AiAgent with kind=&quot;judge&quot;. Pick from the seeded judges
            (eval-judge-correctness, eval-judge-relevance, etc.) or a custom judge you&apos;ve
            created. The judge&apos;s system instructions are the rubric.
          </FieldHelp>
        </Label>
        <Input
          id="judge-call-agent-slug"
          value={config.judgeAgentSlug ?? ''}
          onChange={(e) => onChange({ judgeAgentSlug: e.target.value })}
          placeholder="eval-judge-correctness"
          className="font-mono text-xs"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="judge-call-question" className="flex items-center text-xs">
          Question{' '}
          <FieldHelp title="Question">
            What the subject was asked. Supports template syntax — typically
            <code>{'{{input}}'}</code> to pull the workflow&apos;s input.
          </FieldHelp>
        </Label>
        <Textarea
          id="judge-call-question"
          value={config.question ?? ''}
          onChange={(e) => onChange({ question: e.target.value })}
          rows={2}
          placeholder="{{input}}"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="judge-call-answer" className="flex items-center text-xs">
          Answer{' '}
          <FieldHelp title="Answer">
            The output the judge will score. Typically <code>{'{{previous.output}}'}</code> or
            <code>{'{{<step-id>.output}}'}</code>.
          </FieldHelp>
        </Label>
        <Textarea
          id="judge-call-answer"
          value={config.answer ?? ''}
          onChange={(e) => onChange({ answer: e.target.value })}
          rows={2}
          placeholder="{{previous.output}}"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="judge-call-expected" className="flex items-center text-xs">
          Expected output{' '}
          <FieldHelp title="Expected output">
            Optional reference answer. The correctness judge falls back to a null score when this is
            empty.
          </FieldHelp>
        </Label>
        <Textarea
          id="judge-call-expected"
          value={config.expectedOutput ?? ''}
          onChange={(e) =>
            onChange({ expectedOutput: e.target.value === '' ? undefined : e.target.value })
          }
          rows={2}
          placeholder="(optional)"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="judge-call-threshold" className="flex items-center text-xs">
          Pass threshold{' '}
          <FieldHelp title="Pass threshold">
            Optional. The step&apos;s output carries <code>passed: true</code> when{' '}
            <code>score &gt;= threshold</code>. Use it from a downstream <code>route</code> step:
            condition <code>passed</code> publishes; <code>!passed</code> escalates. If the judge
            returns no score, or one outside 0–1, the step fails and its error strategy decides; it
            never passes unjudged. That covers a judge that could not score (its provider failed or
            is not allowed for this org) and one whose criterion does not apply, such as a
            faithfulness judge on an answer with no citations, or a correctness judge with no
            expected output. Leave empty to always pass.
          </FieldHelp>
        </Label>
        <Input
          id="judge-call-threshold"
          type="number"
          step="0.05"
          min={0}
          max={1}
          value={config.threshold ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            onChange({ threshold: val === '' ? undefined : parseFloat(val) });
          }}
          placeholder="0.7"
        />
      </div>
    </div>
  );
}
