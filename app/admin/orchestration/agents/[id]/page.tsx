import type { Metadata } from 'next';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { cache } from 'react';

import {
  AgentForm,
  type AgentProfileSummary,
  type AgentWithGrants,
} from '@/components/admin/orchestration/agent-form';
import {
  EvaluationTrendChart,
  type EvaluationTrendPoint,
} from '@/components/admin/orchestration/evaluation-trend-chart';
import {
  QuarantinedCapabilitiesBanner,
  type QuarantinedCapabilityForAgent,
} from '@/components/admin/orchestration/agents/quarantined-capabilities-banner';
import { UnapprovedProvidersBanner } from '@/components/admin/orchestration/agents/unapproved-providers-banner';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData, type LoadResult } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import {
  getAgentModels,
  getEffectiveAgentDefaults,
  getProviders,
} from '@/lib/orchestration/prefetch-helpers';

/**
 * Shared by `generateMetadata` and the page, so a view fetches the agent once
 * and a failure is logged once. A 404 is a missing agent; any other failure
 * throws to the error boundary (#518).
 */
const getAgent = cache((id: string) =>
  requireServerData<AgentWithGrants>(API.ADMIN.ORCHESTRATION.agentById(id), { notFound: true })
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  // A failure is the page's to render: the title falls back here. Next's own
  // control-flow errors (not-found, dynamic bailout) are still let through.
  const agent = await getAgent(id).then(
    (result) => result.data,
    (err: unknown) => {
      unstable_rethrow(err);
      return null;
    }
  );
  return {
    title: agent ? `Edit ${agent.name} · AI Orchestration` : 'Edit agent · AI Orchestration',
    description: 'Edit an existing AI agent.',
  };
}

/**
 * Admin — Edit agent page (Phase 4 Session 4.2).
 *
 * Server component shell. Fetches the agent, provider list, and the
 * curated provider matrix (chat + reasoning capabilities only) in
 * parallel. Restricted to models the operator has explicitly added —
 * matches the discipline already used in the settings "Default Models"
 * picker. An agent whose saved model is no longer in the matrix still
 * surfaces it in the dropdown as a legacy option so the operator
 * doesn't silently lose the selection on edit (handled in
 * `agent-form.tsx`). A 404 on the agent → `notFound()`; any other
 * failure throws to the admin error boundary (#518). Provider/model
 * fetch failures are tolerated — the form renders with text-input
 * fallbacks and a warning banner. A failed profile list, quarantine
 * list or evaluation trend shows `<LoadFailedNotice>` in that panel's
 * place: an empty quarantine banner would read as "none quarantined".
 */

/**
 * A panel's list from a load, or `null` when the load failed or its reply has
 * no list where one belongs. The second case is logged here, since the loader
 * saw a success.
 */
function listOrNull<D, I>(
  result: LoadResult<D>,
  pick: (data: D) => I[] | undefined,
  path: string
): I[] | null {
  if (!result.ok) return null;
  const list = pick(result.data);
  if (Array.isArray(list)) return list;
  logger.error('Agent page: panel reply has no list', undefined, { path });
  return null;
}

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ data: agent }, providers, models, trend, profiles, quarantinedCapabilities] =
    await Promise.all([
      getAgent(id),
      getProviders(),
      getAgentModels(),
      loadServerData<{ points: EvaluationTrendPoint[] }>(
        API.ADMIN.ORCHESTRATION.agentEvaluationTrend(id)
      ),
      loadServerData<AgentProfileSummary[]>(
        `${API.ADMIN.ORCHESTRATION.AGENT_PROFILES}?page=1&limit=100`
      ),
      // The route applies read-time auto-expiry via the shared
      // `resolveQuarantineState`, so the rule lives in exactly one place.
      loadServerData<{ items: QuarantinedCapabilityForAgent[] }>(
        API.ADMIN.ORCHESTRATION.agentQuarantinedCapabilities(id)
      ),
    ]);

  // A reply without its list counts as a failed load: the notice says the
  // error was logged, so it is.
  const quarantineItems = listOrNull(
    quarantinedCapabilities,
    (data) => data.items,
    API.ADMIN.ORCHESTRATION.agentQuarantinedCapabilities(id)
  );
  const trendPoints = listOrNull(
    trend,
    (data) => data.points,
    API.ADMIN.ORCHESTRATION.agentEvaluationTrend(id)
  );

  const effectiveDefaults = await getEffectiveAgentDefaults({
    provider: agent.provider,
    model: agent.model,
  });

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
        <span>{agent.name}</span>
      </nav>

      <UnapprovedProvidersBanner
        provider={agent.provider}
        unapproved={agent._unapprovedProviders ?? []}
      />

      {quarantineItems ? (
        <QuarantinedCapabilitiesBanner items={quarantineItems} />
      ) : (
        <LoadFailedNotice what="quarantined capabilities" />
      )}

      {trendPoints ? (
        <EvaluationTrendChart points={trendPoints} />
      ) : (
        <LoadFailedNotice what="the evaluation trend" />
      )}

      {!profiles.ok && <LoadFailedNotice what="agent profiles" />}

      <AgentForm
        mode="edit"
        agent={agent}
        providers={providers}
        models={models}
        effectiveDefaults={effectiveDefaults}
        profiles={profiles.ok ? profiles.data : []}
      />
    </div>
  );
}
