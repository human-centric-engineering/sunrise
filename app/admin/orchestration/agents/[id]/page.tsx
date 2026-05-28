import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AgentForm, type AgentProfileSummary } from '@/components/admin/orchestration/agent-form';
import {
  EvaluationTrendChart,
  type EvaluationTrendPoint,
} from '@/components/admin/orchestration/evaluation-trend-chart';
import {
  QuarantinedCapabilitiesBanner,
  type QuarantinedCapabilityForAgent,
} from '@/components/admin/orchestration/agents/quarantined-capabilities-banner';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import {
  getAgentModels,
  getEffectiveAgentDefaults,
  getProviders,
} from '@/lib/orchestration/prefetch-helpers';
import type { AiAgent } from '@/types/prisma';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const agent = await getAgent(id);
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
 * `agent-form.tsx`). Missing agent → `notFound()`. Provider/model
 * fetch failures are tolerated — the form renders with text-input
 * fallbacks.
 */

async function getAgent(id: string): Promise<AiAgent | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.agentById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<AiAgent>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('edit agent page: agent fetch failed', err, { id });
    return null;
  }
}

async function getAgentProfiles(): Promise<AgentProfileSummary[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENT_PROFILES}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AgentProfileSummary[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('edit agent page: profiles fetch failed', err);
    return [];
  }
}

/**
 * Quarantined capabilities the agent is currently bound to. Calls the
 * admin API; the route applies read-time auto-expiry via the shared
 * `resolveQuarantineState` so the rule lives in exactly one place.
 *
 * Returns [] on any failure — the banner is informational and must not
 * block the page render.
 */
async function getQuarantinedCapabilitiesForAgent(
  agentId: string
): Promise<QuarantinedCapabilityForAgent[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.agentQuarantinedCapabilities(agentId));
    if (!res.ok) return [];
    const body = await parseApiResponse<{ items: QuarantinedCapabilityForAgent[] }>(res);
    // Defensive: existing page-level mocks (e.g. the EditAgentPage tests)
    // return a generic body shape that doesn't include `items`. The
    // banner expects an array, so always normalise.
    if (!body.success || !Array.isArray(body.data?.items)) return [];
    return body.data.items;
  } catch (err) {
    logger.error('edit agent page: quarantined-capabilities fetch failed', err, { agentId });
    return [];
  }
}

async function getEvaluationTrend(id: string): Promise<EvaluationTrendPoint[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.agentEvaluationTrend(id));
    if (!res.ok) return [];
    const body = await parseApiResponse<{ points: EvaluationTrendPoint[] }>(res);
    if (!body.success) return [];
    return Array.isArray(body.data?.points) ? body.data.points : [];
  } catch (err) {
    logger.error('edit agent page: evaluation trend fetch failed', err, { id });
    return [];
  }
}

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [agent, providers, models, trend, profiles, quarantinedCapabilities] = await Promise.all([
    getAgent(id),
    getProviders(),
    getAgentModels(),
    getEvaluationTrend(id),
    getAgentProfiles(),
    getQuarantinedCapabilitiesForAgent(id),
  ]);

  if (!agent) notFound();

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

      <QuarantinedCapabilitiesBanner items={quarantinedCapabilities} />

      <EvaluationTrendChart points={trend} />

      <AgentForm
        mode="edit"
        agent={agent}
        providers={providers}
        models={models}
        effectiveDefaults={effectiveDefaults}
        profiles={profiles}
      />
    </div>
  );
}
