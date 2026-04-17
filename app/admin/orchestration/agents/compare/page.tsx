import type { Metadata } from 'next';
import Link from 'next/link';

import { AgentComparisonView } from '@/components/admin/orchestration/agent-comparison-view';

export const metadata: Metadata = {
  title: 'Compare Agents · AI Orchestration',
  description: 'Side-by-side performance comparison of two AI agents.',
};

/**
 * Admin — Agent comparison page.
 *
 * URL: /admin/orchestration/agents/compare?a=id1&b=id2
 *
 * If either agent ID is missing, renders an error message with
 * a link back to the agents list.
 */
export default async function CompareAgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string; b?: string }>;
}) {
  const { a, b } = await searchParams;

  if (!a || !b) {
    return (
      <div className="space-y-6">
        <nav className="text-muted-foreground text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <Link href="/admin/orchestration/agents" className="hover:underline">
            Agents
          </Link>
          {' / '}
          <span>Compare</span>
        </nav>
        <p className="text-muted-foreground">
          Select exactly two agents from the{' '}
          <Link href="/admin/orchestration/agents" className="underline">
            agents list
          </Link>{' '}
          to compare.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/agents" className="hover:underline">
          Agents
        </Link>
        {' / '}
        <span>Compare</span>
      </nav>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Compare Agents</h1>
        <p className="text-muted-foreground text-sm">Side-by-side performance comparison</p>
      </div>

      <AgentComparisonView agentIdA={a} agentIdB={b} />
    </div>
  );
}
