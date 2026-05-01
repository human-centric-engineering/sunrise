'use client';

/**
 * WorkflowResourceSummary — collapsible panel above the canvas that lists
 * all capabilities and agents referenced by the current workflow steps.
 *
 * Saves admins from clicking into each step to discover which resources
 * a workflow depends on. Clicking a row focuses the first step that uses
 * that resource.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Puzzle, Bot } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';
import type {
  AgentOption,
  CapabilityOption,
} from '@/components/admin/orchestration/workflow-builder/block-editors';

export interface WorkflowResourceSummaryProps {
  nodes: readonly PatternNode[];
  capabilities: readonly CapabilityOption[];
  agents: readonly AgentOption[];
  /** Called when the user clicks a resource row — builder focuses the node. */
  onFocusNode: (stepId: string) => void;
}

interface ResourceEntry {
  slug: string;
  name: string;
  description: string | null;
  /** Step IDs that reference this resource. */
  stepIds: string[];
  /** Step labels for tooltip. */
  stepLabels: string[];
}

function collectResources(
  nodes: readonly PatternNode[],
  capabilities: readonly CapabilityOption[],
  agents: readonly AgentOption[]
): { capabilities: ResourceEntry[]; agents: ResourceEntry[] } {
  const capMap = new Map<string, string[]>();
  const capLabels = new Map<string, string[]>();
  const agentMap = new Map<string, string[]>();
  const agentLabels = new Map<string, string[]>();

  for (const node of nodes) {
    const { type, config, label } = node.data;

    if (
      type === 'tool_call' &&
      typeof config.capabilitySlug === 'string' &&
      config.capabilitySlug
    ) {
      const slug = config.capabilitySlug;
      if (!capMap.has(slug)) {
        capMap.set(slug, []);
        capLabels.set(slug, []);
      }
      capMap.get(slug)!.push(node.id);
      capLabels.get(slug)!.push(label);
    }

    if (type === 'agent_call' && typeof config.agentSlug === 'string' && config.agentSlug) {
      const slug = config.agentSlug;
      if (!agentMap.has(slug)) {
        agentMap.set(slug, []);
        agentLabels.set(slug, []);
      }
      agentMap.get(slug)!.push(node.id);
      agentLabels.get(slug)!.push(label);
    }

    if (type === 'orchestrator' && Array.isArray(config.availableAgentSlugs)) {
      for (const slug of config.availableAgentSlugs) {
        if (typeof slug === 'string' && slug) {
          if (!agentMap.has(slug)) {
            agentMap.set(slug, []);
            agentLabels.set(slug, []);
          }
          agentMap.get(slug)!.push(node.id);
          agentLabels.get(slug)!.push(label);
        }
      }
    }
  }

  const capLookup = new Map(capabilities.map((c) => [c.slug, c]));
  const agentLookup = new Map(agents.map((a) => [a.slug, a]));

  const capEntries: ResourceEntry[] = [...capMap.entries()].map(([slug, stepIds]) => {
    const cap = capLookup.get(slug);
    return {
      slug,
      name: cap?.name ?? slug,
      description: cap?.description ?? null,
      stepIds,
      stepLabels: capLabels.get(slug) ?? [],
    };
  });

  const agentEntries: ResourceEntry[] = [...agentMap.entries()].map(([slug, stepIds]) => {
    const agent = agentLookup.get(slug);
    return {
      slug,
      name: agent?.name ?? slug,
      description: agent?.description ?? null,
      stepIds,
      stepLabels: agentLabels.get(slug) ?? [],
    };
  });

  return { capabilities: capEntries, agents: agentEntries };
}

export function WorkflowResourceSummary({
  nodes,
  capabilities,
  agents,
  onFocusNode,
}: WorkflowResourceSummaryProps) {
  const [open, setOpen] = useState(false);

  const resources = useMemo(
    () => collectResources(nodes, capabilities, agents),
    [nodes, capabilities, agents]
  );

  const totalCount = resources.capabilities.length + resources.agents.length;

  if (totalCount === 0) return null;

  return (
    <div
      data-testid="resource-summary-panel"
      className={cn('bg-background border-b border-blue-200 dark:border-blue-900')}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <span className="font-medium">Resources</span>
          {resources.capabilities.length > 0 && (
            <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
              <Puzzle className="h-3 w-3" />
              {resources.capabilities.length}{' '}
              {resources.capabilities.length === 1 ? 'capability' : 'capabilities'}
            </Badge>
          )}
          {resources.agents.length > 0 && (
            <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
              <Bot className="h-3 w-3" />
              {resources.agents.length} {resources.agents.length === 1 ? 'agent' : 'agents'}
            </Badge>
          )}
        </span>
        {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {open && (
        <div className="max-h-48 space-y-3 overflow-y-auto px-4 pb-3">
          {resources.capabilities.length > 0 && (
            <div>
              <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase">
                <Puzzle className="h-3 w-3" />
                Capabilities
              </p>
              <ul className="space-y-0.5 text-xs">
                {resources.capabilities.map((entry) => (
                  <ResourceRow key={entry.slug} entry={entry} onFocusNode={onFocusNode} />
                ))}
              </ul>
            </div>
          )}
          {resources.agents.length > 0 && (
            <div>
              <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide uppercase">
                <Bot className="h-3 w-3" />
                Agents
              </p>
              <ul className="space-y-0.5 text-xs">
                {resources.agents.map((entry) => (
                  <ResourceRow key={entry.slug} entry={entry} onFocusNode={onFocusNode} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResourceRow({
  entry,
  onFocusNode,
}: {
  entry: ResourceEntry;
  onFocusNode: (stepId: string) => void;
}) {
  const stepsLabel = entry.stepLabels.join(', ');

  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto w-full justify-start px-2 py-1.5 text-left whitespace-normal"
        onClick={() => onFocusNode(entry.stepIds[0])}
        title={`Used in: ${stepsLabel}`}
      >
        <span className="flex-1">
          <span className="font-medium">{entry.name}</span>
          <span className="text-muted-foreground ml-1.5 font-mono text-[10px]">{entry.slug}</span>
          {entry.stepIds.length > 1 && (
            <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[10px]">
              {entry.stepIds.length} steps
            </Badge>
          )}
          {entry.description && (
            <span className="text-muted-foreground ml-2 text-[10px]">— {entry.description}</span>
          )}
        </span>
      </Button>
    </li>
  );
}
