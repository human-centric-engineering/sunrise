import type { Metadata } from 'next';
import Link from 'next/link';

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
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import {
  getAgentModels,
  getEffectiveAgentDefaults,
  getProviders,
} from '@/lib/orchestration/prefetch-helpers';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const result = await loadServerData<AgentWithGrants>(API.ADMIN.ORCHESTRATION.agentById(id));
  const agent = result.ok ? result.data : null;
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

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ data: agent }, providers, models, trend, profiles, quarantinedCapabilities] =
    await Promise.all([
      requireServerData<AgentWithGrants>(API.ADMIN.ORCHESTRATION.agentById(id), {
        notFound: true,
      }),
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

      {quarantinedCapabilities.ok && Array.isArray(quarantinedCapabilities.data.items) ? (
        <QuarantinedCapabilitiesBanner items={quarantinedCapabilities.data.items} />
      ) : (
        <LoadFailedNotice what="quarantined capabilities" />
      )}

      {trend.ok && Array.isArray(trend.data.points) ? (
        <EvaluationTrendChart points={trend.data.points} />
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
