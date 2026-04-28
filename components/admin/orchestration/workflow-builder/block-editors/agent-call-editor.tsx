'use client';

/**
 * Agent Call step editor — configure agent invocation within a workflow.
 *
 * Allows selecting an agent by slug, setting the message template,
 * tool iteration limits, and multi-turn conversation mode.
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

import type { EditorProps } from '@/components/admin/orchestration/workflow-builder/block-editors/index';
import type { AgentOption } from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface AgentCallConfig extends Record<string, unknown> {
  agentSlug: string;
  message: string;
  maxToolIterations?: number;
  mode?: 'single-turn' | 'multi-turn';
  maxTurns?: number;
}

export function AgentCallEditor({
  config,
  onChange,
  agents = [],
}: EditorProps<AgentCallConfig> & { agents?: readonly AgentOption[] }) {
  return (
    <div className="space-y-4">
      {/* Agent Selection */}
      <div className="space-y-1.5">
        <Label htmlFor="agent-call-slug" className="flex items-center text-xs">
          Agent{' '}
          <FieldHelp title="Agent">
            Select the agent to invoke. The agent&apos;s full configuration — system prompt, model,
            temperature, capabilities, and knowledge — is loaded at execution time.
          </FieldHelp>
        </Label>
        {agents.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs italic">
            No active agents available. Create agents in the Agents admin first.
          </p>
        ) : (
          <Select value={config.agentSlug ?? ''} onValueChange={(v) => onChange({ agentSlug: v })}>
            <SelectTrigger id="agent-call-slug">
              <SelectValue placeholder="Select an agent…" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.slug} value={agent.slug}>
                  {agent.name}
                  {agent.description ? ` — ${agent.description}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Message Template */}
      <div className="space-y-1.5">
        <Label htmlFor="agent-call-message" className="flex items-center text-xs">
          Message{' '}
          <FieldHelp title="Message template">
            The user message sent to the agent. Supports <code>{'{{input}}'}</code> to inject the
            workflow input and <code>{'{{steps.<stepId>.output}}'}</code> to reference previous step
            outputs.
          </FieldHelp>
        </Label>
        <Textarea
          id="agent-call-message"
          value={config.message ?? ''}
          onChange={(e) => onChange({ message: e.target.value })}
          placeholder="{{input}}"
          rows={4}
        />
      </div>

      {/* Mode */}
      <div className="space-y-1.5">
        <Label htmlFor="agent-call-mode" className="flex items-center text-xs">
          Conversation mode{' '}
          <FieldHelp title="Conversation mode">
            <strong>Single-turn:</strong> one prompt → one response (with tool use loops).{' '}
            <strong>Multi-turn:</strong> back-and-forth conversation up to max turns.
          </FieldHelp>
        </Label>
        <Select
          value={config.mode ?? 'single-turn'}
          onValueChange={(v) => onChange({ mode: v as 'single-turn' | 'multi-turn' })}
        >
          <SelectTrigger id="agent-call-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="single-turn">Single-turn</SelectItem>
            <SelectItem value="multi-turn">Multi-turn</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Max Tool Iterations */}
      <div className="space-y-1.5">
        <Label htmlFor="agent-call-tool-iterations" className="flex items-center text-xs">
          Max tool iterations{' '}
          <FieldHelp title="Max tool iterations">
            Cap on how many tool use loops the agent can run per turn. Prevents runaway tool calls.
            Default: <code>5</code>.
          </FieldHelp>
        </Label>
        <Input
          id="agent-call-tool-iterations"
          type="number"
          min={0}
          max={20}
          value={config.maxToolIterations ?? 5}
          onChange={(e) =>
            onChange({ maxToolIterations: Math.min(20, Math.max(0, Number(e.target.value))) })
          }
        />
      </div>

      {/* Max Turns (only for multi-turn) */}
      {(config.mode ?? 'single-turn') === 'multi-turn' && (
        <div className="space-y-1.5">
          <Label htmlFor="agent-call-max-turns" className="flex items-center text-xs">
            Max turns{' '}
            <FieldHelp title="Max turns">
              Maximum conversation turns in multi-turn mode. Each turn is a prompt/response cycle.
              Default: <code>3</code>.
            </FieldHelp>
          </Label>
          <Input
            id="agent-call-max-turns"
            type="number"
            min={1}
            max={10}
            value={config.maxTurns ?? 3}
            onChange={(e) =>
              onChange({ maxTurns: Math.min(10, Math.max(1, Number(e.target.value))) })
            }
          />
        </div>
      )}
    </div>
  );
}
