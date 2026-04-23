'use client';

/**
 * AgentComparisonView — side-by-side comparison of two agents.
 *
 * Displays configuration, performance metrics, and evaluation results
 * in a two-column layout with color-coded "better" values.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react';

import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface AgentStats {
  id: string;
  name: string;
  slug: string;
  model: string;
  provider: string;
  isActive: boolean;
  createdAt: string;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  llmCallCount: number;
  conversationCount: number;
  capabilityCount: number;
  evaluations: {
    total: number;
    completed: number;
  };
}

interface ComparisonData {
  agents: [AgentStats, AgentStats];
}

interface AgentComparisonViewProps {
  agentIdA: string;
  agentIdB: string;
}

type Direction = 'lower' | 'higher';

function ComparisonRow({
  label,
  valueA,
  valueB,
  better,
  format,
}: {
  label: string;
  valueA: number | string | null;
  valueB: number | string | null;
  better?: Direction;
  format?: (v: number | string | null) => string;
}) {
  const fmt = format ?? ((v) => (v === null ? '—' : String(v)));
  const numA = typeof valueA === 'number' ? valueA : null;
  const numB = typeof valueB === 'number' ? valueB : null;

  let highlightA = false;
  let highlightB = false;
  if (better && numA !== null && numB !== null && numA !== numB) {
    if (better === 'lower') {
      highlightA = numA < numB;
      highlightB = numB < numA;
    } else {
      highlightA = numA > numB;
      highlightB = numB > numA;
    }
  }

  return (
    <div className="grid grid-cols-[1fr_1fr_1fr] items-center gap-4 border-b px-4 py-2.5 last:border-b-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span
        className={cn('text-sm font-medium', highlightA && 'text-green-600 dark:text-green-400')}
      >
        {fmt(valueA)}
      </span>
      <span
        className={cn('text-sm font-medium', highlightB && 'text-green-600 dark:text-green-400')}
      >
        {fmt(valueB)}
      </span>
    </div>
  );
}

export function AgentComparisonView({ agentIdA, agentIdB }: AgentComparisonViewProps) {
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
      setLoading(true);
      setError(null);
      try {
        const result = await apiClient.get<ComparisonData>(API.ADMIN.ORCHESTRATION.AGENTS_COMPARE, {
          params: { agentIds: `${agentIdA},${agentIdB}` },
        });
        setData(result);
      } catch (err) {
        setError(err instanceof APIClientError ? err.message : 'Failed to load comparison data');
      } finally {
        setLoading(false);
      }
    }
    void fetch();
  }, [agentIdA, agentIdB]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center gap-2 py-16">
        <AlertCircle className="h-4 w-4 text-red-500" />
        <span className="text-muted-foreground text-sm">{error ?? 'No data'}</span>
      </div>
    );
  }

  const [a, b] = data.agents;
  const fmtCost = (v: number | string | null) => (typeof v === 'number' ? `$${v.toFixed(4)}` : '—');
  const fmtNum = (v: number | string | null) => (typeof v === 'number' ? v.toLocaleString() : '—');
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/admin/orchestration/agents">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to agents
          </Link>
        </Button>
      </div>

      {/* Header with agent names */}
      <div className="grid grid-cols-[1fr_1fr_1fr] gap-4 px-4">
        <div />
        <div>
          <h3 className="font-semibold">{a.name}</h3>
          <p className="text-muted-foreground font-mono text-xs">{a.slug}</p>
          <Badge variant={a.isActive ? 'default' : 'secondary'} className="mt-1">
            {a.isActive ? 'Active' : 'Inactive'}
          </Badge>
        </div>
        <div>
          <h3 className="font-semibold">{b.name}</h3>
          <p className="text-muted-foreground font-mono text-xs">{b.slug}</p>
          <Badge variant={b.isActive ? 'default' : 'secondary'} className="mt-1">
            {b.isActive ? 'Active' : 'Inactive'}
          </Badge>
        </div>
      </div>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ComparisonRow label="Model" valueA={a.model} valueB={b.model} />
          <ComparisonRow label="Provider" valueA={a.provider} valueB={b.provider} />
          <ComparisonRow
            label="Capabilities"
            valueA={a.capabilityCount}
            valueB={b.capabilityCount}
            better="higher"
            format={fmtNum}
          />
        </CardContent>
      </Card>

      {/* Performance */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Performance</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ComparisonRow
            label="Total Cost"
            valueA={a.totalCostUsd}
            valueB={b.totalCostUsd}
            better="lower"
            format={fmtCost}
          />
          <ComparisonRow
            label="LLM Calls"
            valueA={a.llmCallCount}
            valueB={b.llmCallCount}
            better="lower"
            format={fmtNum}
          />
          <ComparisonRow
            label="Input Tokens"
            valueA={a.totalInputTokens}
            valueB={b.totalInputTokens}
            better="lower"
            format={fmtNum}
          />
          <ComparisonRow
            label="Output Tokens"
            valueA={a.totalOutputTokens}
            valueB={b.totalOutputTokens}
            better="lower"
            format={fmtNum}
          />
          <ComparisonRow
            label="Conversations"
            valueA={a.conversationCount}
            valueB={b.conversationCount}
            better="higher"
            format={fmtNum}
          />
        </CardContent>
      </Card>

      {/* Evaluations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evaluation Results</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ComparisonRow
            label="Total Evaluations"
            valueA={a.evaluations.total}
            valueB={b.evaluations.total}
            format={fmtNum}
          />
          <ComparisonRow
            label="Completed"
            valueA={a.evaluations.completed}
            valueB={b.evaluations.completed}
            better="higher"
            format={fmtNum}
          />
        </CardContent>
      </Card>
    </div>
  );
}
