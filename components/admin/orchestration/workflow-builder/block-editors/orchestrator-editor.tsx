'use client';

/**
 * Orchestrator step editor — configure autonomous multi-agent orchestration.
 *
 * The orchestrator step uses an AI planner to dynamically select agents,
 * delegate tasks, and synthesize results across multiple rounds. This
 * editor provides controls for the planner prompt, agent selection,
 * round limits, and budget constraints.
 *
 * The `agents` list is fetched by the builder shell and passed down,
 * following the same pattern as `capabilities` for the Tool Call editor.
 */

import { Checkbox } from '@/components/ui/checkbox';
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

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';
import type { AgentOption } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface OrchestratorConfig extends Record<string, unknown> {
  plannerPrompt: string;
  availableAgentSlugs: string[];
  selectionMode?: 'auto' | 'all';
  maxRounds?: number;
  maxDelegationsPerRound?: number;
  modelOverride?: string;
  temperature?: number;
  timeoutMs?: number;
  budgetLimitUsd?: number;
}

export function OrchestratorEditor({
  config,
  onChange,
  agents = [],
}: EditorProps<OrchestratorConfig> & { agents?: readonly AgentOption[] }) {
  const selectedSlugs = new Set(config.availableAgentSlugs ?? []);

  const toggleAgent = (slug: string, checked: boolean) => {
    const next = checked
      ? [...(config.availableAgentSlugs ?? []), slug]
      : (config.availableAgentSlugs ?? []).filter((s) => s !== slug);
    onChange({ availableAgentSlugs: next });
  };

  return (
    <div className="space-y-4">
      {/* Planner Prompt */}
      <div className="space-y-1.5">
        <Label htmlFor="orchestrator-prompt" className="flex items-center text-xs">
          Planner prompt{' '}
          <FieldHelp title="Planner prompt">
            System instructions for the AI planner that coordinates agents. Describe the overall
            goal, any constraints on how agents should collaborate, and what a good final answer
            looks like.
          </FieldHelp>
        </Label>
        <Textarea
          id="orchestrator-prompt"
          value={config.plannerPrompt ?? ''}
          onChange={(e) => onChange({ plannerPrompt: e.target.value })}
          placeholder="You are a research coordinator. Delegate specific research tasks to specialist agents and synthesize their findings into a comprehensive report…"
          rows={8}
        />
      </div>

      {/* Available Agents */}
      <div className="space-y-1.5">
        <Label className="flex items-center text-xs">
          Available agents{' '}
          <FieldHelp title="Available agents">
            Select which agents the planner can delegate to. The planner sees each agent&apos;s
            name, description, and capabilities when deciding who to invoke.
          </FieldHelp>
        </Label>

        {agents.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs italic">
            No active agents available. Create agents in the Agents admin first.
          </p>
        ) : (
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
            {agents.map((agent) => (
              <label key={agent.slug} className="flex items-start gap-2 text-xs">
                <Checkbox
                  checked={selectedSlugs.has(agent.slug)}
                  onCheckedChange={(checked) => toggleAgent(agent.slug, checked === true)}
                  aria-label={`Select agent ${agent.name}`}
                />
                <div className="min-w-0">
                  <span className="font-medium">{agent.name}</span>
                  {agent.description && (
                    <p className="text-muted-foreground truncate">{agent.description}</p>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}

        {selectedSlugs.size > 0 && (
          <p className="text-muted-foreground text-xs">
            {selectedSlugs.size} agent{selectedSlugs.size === 1 ? '' : 's'} selected
          </p>
        )}
      </div>

      {/* Selection Mode */}
      <div className="space-y-1.5">
        <Label htmlFor="orchestrator-mode" className="flex items-center text-xs">
          Selection mode{' '}
          <FieldHelp title="Selection mode">
            <strong>Auto:</strong> the AI planner decides which agents to invoke each round based on
            the task and intermediate results. <strong>All:</strong> every listed agent receives the
            task (fan-out), bypassing planner selection.
          </FieldHelp>
        </Label>
        <Select
          value={config.selectionMode ?? 'auto'}
          onValueChange={(v) => onChange({ selectionMode: v as 'auto' | 'all' })}
        >
          <SelectTrigger id="orchestrator-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto (AI planner decides)</SelectItem>
            <SelectItem value="all">All (fan out to every agent)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Max Rounds */}
      <div className="space-y-1.5">
        <Label htmlFor="orchestrator-rounds" className="flex items-center text-xs">
          Max rounds{' '}
          <FieldHelp title="Max rounds">
            Maximum plan→delegate→replan cycles. More rounds allow deeper exploration but increase
            cost and latency. Default: <code>3</code>.
          </FieldHelp>
        </Label>
        <Input
          id="orchestrator-rounds"
          type="number"
          min={1}
          max={10}
          value={config.maxRounds ?? 3}
          onChange={(e) =>
            onChange({ maxRounds: Math.min(10, Math.max(1, Number(e.target.value))) })
          }
        />
      </div>

      {/* Max Delegations per Round */}
      <div className="space-y-1.5">
        <Label htmlFor="orchestrator-delegations" className="flex items-center text-xs">
          Max delegations per round{' '}
          <FieldHelp title="Max delegations per round">
            Maximum agent calls per round. Limits how many agents can run in parallel within a
            single planning cycle. Default: <code>5</code>.
          </FieldHelp>
        </Label>
        <Input
          id="orchestrator-delegations"
          type="number"
          min={1}
          max={20}
          value={config.maxDelegationsPerRound ?? 5}
          onChange={(e) =>
            onChange({
              maxDelegationsPerRound: Math.min(20, Math.max(1, Number(e.target.value))),
            })
          }
        />
      </div>

      {/* Timeout */}
      <div className="space-y-1.5">
        <Label htmlFor="orchestrator-timeout" className="flex items-center text-xs">
          Timeout (seconds){' '}
          <FieldHelp title="Timeout">
            Hard time limit for the entire orchestration step. The planner and all delegations must
            complete within this window. Default: <code>120</code> seconds.
          </FieldHelp>
        </Label>
        <Input
          id="orchestrator-timeout"
          type="number"
          min={5}
          max={600}
          value={Math.round((config.timeoutMs ?? 120000) / 1000)}
          onChange={(e) => {
            const seconds = Math.min(600, Math.max(5, Number(e.target.value)));
            onChange({ timeoutMs: seconds * 1000 });
          }}
        />
      </div>

      {/* Budget Limit */}
      <div className="space-y-1.5">
        <Label htmlFor="orchestrator-budget" className="flex items-center text-xs">
          Budget limit (USD){' '}
          <FieldHelp title="Budget limit">
            Maximum spend for this orchestration step. Includes both planner reasoning and all agent
            delegation costs. Leave empty to use the workflow-level budget.
          </FieldHelp>
        </Label>
        <Input
          id="orchestrator-budget"
          type="number"
          min={0}
          step={0.01}
          value={config.budgetLimitUsd ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            onChange({ budgetLimitUsd: val === '' ? undefined : Number(val) });
          }}
          placeholder="No limit"
        />
      </div>

      {/* Model Override */}
      <div className="space-y-1.5">
        <Label htmlFor="orchestrator-model" className="flex items-center text-xs">
          Model override{' '}
          <FieldHelp title="Model override">
            Override the default model for the planner LLM. Leave empty to use the system default.
            The planner model only affects the planning/reasoning calls, not the delegated agent
            calls.
          </FieldHelp>
        </Label>
        <Input
          id="orchestrator-model"
          value={config.modelOverride ?? ''}
          onChange={(e) => onChange({ modelOverride: e.target.value || undefined })}
          placeholder="e.g. gpt-4o, claude-sonnet-4-20250514"
        />
      </div>

      {/* Temperature */}
      <div className="space-y-1.5">
        <Label htmlFor="orchestrator-temperature" className="flex items-center text-xs">
          Temperature{' '}
          <FieldHelp title="Temperature">
            Controls randomness in the planner&apos;s reasoning. Lower values make agent selection
            more deterministic; higher values increase creativity. Default: <code>0.3</code>.
          </FieldHelp>
        </Label>
        <Input
          id="orchestrator-temperature"
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={config.temperature ?? 0.3}
          onChange={(e) =>
            onChange({ temperature: Math.min(2, Math.max(0, Number(e.target.value))) })
          }
        />
      </div>
    </div>
  );
}
