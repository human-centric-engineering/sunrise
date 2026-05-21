'use client';

/**
 * WorkflowResourceSummary — collapsible panel above the canvas that lists
 * all capabilities and agents referenced by the current workflow steps,
 * plus a live cost-vs-cap banner at the top.
 *
 * Saves admins from clicking into each step to discover which resources
 * a workflow depends on. Clicking a row focuses the first step that uses
 * that resource.
 *
 * The cost banner shows the planning-grade mid estimate, the effective
 * per-execution cap (workflow override > org default), and a colour
 * band: neutral when comfortably under, amber when in striking distance,
 * red when projected to exceed. The banner is best-effort guidance —
 * the runtime cost-cap layer is what actually aborts a run.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Puzzle, Bot, DollarSign, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';
import type {
  AgentOption,
  CapabilityOption,
} from '@/components/admin/orchestration/workflow-builder/block-editors';
import type { WorkflowCostEstimateWithCap } from '@/components/admin/orchestration/workflow-builder/use-workflow-cost-estimate';

export interface WorkflowResourceSummaryProps {
  nodes: readonly PatternNode[];
  capabilities: readonly CapabilityOption[];
  agents: readonly AgentOption[];
  /** Called when the user clicks a resource row — builder focuses the node. */
  onFocusNode: (stepId: string) => void;
  /** Live cost estimate (null when not yet fetched or workflow isn't saved). */
  costEstimate?: WorkflowCostEstimateWithCap | null;
  costLoading?: boolean;
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

  // Defensive: the prop types promise arrays, but if upstream hands us a
  // malformed shape (e.g. a swallowed API error that returned an object
  // instead of a list) the panel must not crash the whole builder. Fall
  // back to empty — labels just won't resolve to friendly names.
  const safeCapabilities: readonly CapabilityOption[] = Array.isArray(capabilities)
    ? capabilities
    : [];
  const safeAgents: readonly AgentOption[] = Array.isArray(agents) ? agents : [];
  const capLookup = new Map(safeCapabilities.map((c) => [c.slug, c]));
  const agentLookup = new Map(safeAgents.map((a) => [a.slug, a]));

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
  costEstimate,
  costLoading,
}: WorkflowResourceSummaryProps) {
  const [open, setOpen] = useState(false);

  const resources = useMemo(
    () => collectResources(nodes, capabilities, agents),
    [nodes, capabilities, agents]
  );

  const totalCount = resources.capabilities.length + resources.agents.length;

  // The panel renders if there's anything to show — resources OR a
  // pending/computed cost estimate. Brand-new empty workflows still
  // get a clean canvas with no banner clutter.
  const hasResources = totalCount > 0;
  const hasCost = Boolean(costEstimate) || Boolean(costLoading);
  if (!hasResources && !hasCost) return null;

  return (
    <div
      data-testid="resource-summary-panel"
      className={cn('bg-background border-b border-blue-200 dark:border-blue-900')}
    >
      {(costEstimate || costLoading) && (
        <CostBanner estimate={costEstimate ?? null} loading={Boolean(costLoading)} />
      )}
      {hasResources && (
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
      )}

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

/**
 * Tunables for the cost banner colour bands. Expressed as the projected
 * mid estimate's share of the effective per-execution cap.
 */
const COST_BAND_WARN = 0.5; // ≥50% of the cap → amber
const COST_BAND_OVER = 1.0; // ≥100% of the cap → red

function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

function CostBanner({
  estimate,
  loading,
}: {
  estimate: WorkflowCostEstimateWithCap | null;
  loading: boolean;
}) {
  if (loading && !estimate) {
    return (
      <div
        data-testid="cost-banner"
        data-cost-band="loading"
        className="text-muted-foreground flex items-center gap-2 border-b border-blue-200 px-4 py-2 text-xs dark:border-blue-900"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Estimating cost…</span>
      </div>
    );
  }
  if (!estimate) return null;

  const cap = estimate.effectiveCapUsd;
  const share = cap && cap > 0 ? estimate.midUsd / cap : 0;
  const band: 'ok' | 'warn' | 'over' =
    cap === null || cap === 0
      ? 'ok'
      : share >= COST_BAND_OVER
        ? 'over'
        : share >= COST_BAND_WARN
          ? 'warn'
          : 'ok';

  const bandStyles: Record<'ok' | 'warn' | 'over', string> = {
    ok: 'border-blue-200 bg-background text-muted-foreground dark:border-blue-900',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    over: 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
  };

  const headline = (() => {
    if (band === 'over') {
      return cap !== null
        ? `Projected ${formatUsd(estimate.midUsd)} — exceeds the ${formatUsd(cap)} per-execution cap`
        : `Projected ${formatUsd(estimate.midUsd)} per run`;
    }
    if (band === 'warn' && cap !== null) {
      return `Projected ${formatUsd(estimate.midUsd)} — ${Math.round(share * 100)}% of the ${formatUsd(cap)} cap`;
    }
    if (cap !== null) {
      return `Projected ${formatUsd(estimate.midUsd)} per run · cap ${formatUsd(cap)}`;
    }
    return `Projected ${formatUsd(estimate.midUsd)} per run · no cap configured`;
  })();

  return (
    <div
      data-testid="cost-banner"
      data-cost-band={band}
      className={cn(
        'flex items-center justify-between gap-3 border-b px-4 py-2 text-xs',
        bandStyles[band]
      )}
      title={estimate.notes}
    >
      <span className="flex items-center gap-2">
        <DollarSign className="h-3.5 w-3.5" />
        <span className="font-medium">{headline}</span>
      </span>
      <span className="flex items-center gap-2">
        <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase">
          {estimate.basedOn}
        </Badge>
        <span className="text-[10px] opacity-80">
          range {formatUsd(estimate.lowUsd)}–{formatUsd(estimate.highUsd)}
        </span>
      </span>
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
