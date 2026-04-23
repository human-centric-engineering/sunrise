'use client';

/**
 * Plan step editor — objective + bound on generated sub-steps.
 *
 * The Plan pattern asks the agent to decompose a high-level objective
 * into a list of concrete sub-steps before executing them. `maxSubSteps`
 * keeps the plan bounded so a runaway planner can't generate 200 tasks.
 */

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { FieldHelp } from '@/components/ui/field-help';

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface PlanConfig extends Record<string, unknown> {
  objective: string;
  maxSubSteps?: number;
}

export function PlanEditor({ config, onChange }: EditorProps<PlanConfig>) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="plan-objective" className="flex items-center text-xs">
          Objective{' '}
          <FieldHelp title="Plan objective">
            A concise description of the goal the agent should plan toward. The agent will generate
            its own list of sub-steps before executing them.
          </FieldHelp>
        </Label>
        <Textarea
          id="plan-objective"
          value={config.objective ?? ''}
          onChange={(e) => onChange({ objective: e.target.value })}
          placeholder="Migrate the customer database from MySQL to Postgres…"
          rows={5}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="plan-max-substeps" className="flex items-center text-xs">
          Max sub-steps{' '}
          <FieldHelp title="Max sub-steps">
            The hard cap on how many sub-steps the planner is allowed to produce. Default:{' '}
            <code>5</code>. Raising this above ~10 tends to produce over-decomposed plans.
          </FieldHelp>
        </Label>
        <Input
          id="plan-max-substeps"
          type="number"
          min={1}
          max={25}
          value={config.maxSubSteps ?? 5}
          onChange={(e) => onChange({ maxSubSteps: Number(e.target.value) })}
        />
      </div>
    </div>
  );
}
