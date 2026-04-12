/**
 * Orchestration stats cards (Phase 4 Session 4.1)
 *
 * Server component. Renders four summary cards for the orchestration
 * dashboard: agents, workflows, today's cost, conversations. Values may
 * be `null` — the cards render an em-dash in that case instead of
 * throwing, matching the null-safe fetch pattern in the parent page.
 */

import { Bot, DollarSign, GitBranch, MessagesSquare } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface OrchestrationStatsCardsProps {
  agentsCount: number | null;
  workflowsCount: number | null;
  todayCostUsd: number | null;
  conversationsCount: number | null;
}

interface StatCardData {
  title: string;
  value: string;
  description: string;
  icon: React.ReactNode;
}

function StatCard({ title, value, description, icon }: StatCardData) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <div className="text-muted-foreground" aria-hidden="true">
          {icon}
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <p className="text-muted-foreground text-xs">{description}</p>
      </CardContent>
    </Card>
  );
}

function formatCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString();
}

function formatUsd(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toFixed(2)}`;
}

export function OrchestrationStatsCards({
  agentsCount,
  workflowsCount,
  todayCostUsd,
  conversationsCount,
}: OrchestrationStatsCardsProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Agents"
        value={formatCount(agentsCount)}
        description="Configured AI agents"
        icon={<Bot className="h-4 w-4" />}
      />
      <StatCard
        title="Workflows"
        value={formatCount(workflowsCount)}
        description="Multi-step flows"
        icon={<GitBranch className="h-4 w-4" />}
      />
      <StatCard
        title="Today's spend"
        value={formatUsd(todayCostUsd)}
        description="LLM cost so far today (UTC)"
        icon={<DollarSign className="h-4 w-4" />}
      />
      <StatCard
        title="Conversations"
        value={formatCount(conversationsCount)}
        description="Your chat sessions"
        icon={<MessagesSquare className="h-4 w-4" />}
      />
    </div>
  );
}
