import type { Metadata } from 'next';
import Link from 'next/link';

import {
  CapabilityForm,
  type UsedByAgentSummary,
} from '@/components/admin/orchestration/capability-form';
import { CapabilityQuarantineCard } from '@/components/admin/orchestration/capability-quarantine-card';
import { CapabilityStatsPanel } from '@/components/admin/orchestration/capability-stats-panel';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import { resolveQuarantineState } from '@/lib/orchestration/capabilities/dispatcher';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import type { AiCapability } from '@/types/prisma';

interface QuarantineAttribution {
  /** ISO 8601 timestamp of the most recent quarantine write. */
  at: string;
  /** Actor name; falls back to email; null when the user row is gone. */
  actorName: string | null;
}

/**
 * Fetch quarantine audit attribution via the admin API. The endpoint
 * short-circuits to `{ attribution: null }` when the capability is
 * active, so the page doesn't need its own guard.
 *
 * Returns null on any failure (logged by `loadServerData`) — the card
 * omits its "quarantined by … at …" line rather than blocking the page.
 */
async function getQuarantineAttribution(
  capabilityId: string
): Promise<QuarantineAttribution | null> {
  const result = await loadServerData<{ attribution: QuarantineAttribution | null }>(
    API.ADMIN.ORCHESTRATION.capabilityQuarantineAttribution(capabilityId)
  );
  return result.ok ? result.data.attribution : null;
}

export const metadata: Metadata = {
  title: 'Edit capability · AI Orchestration',
  description: 'Edit an existing capability.',
};

/**
 * Admin — Edit capability page (Phase 4 Session 4.3).
 *
 * Fetches the capability, its agent-usage list, and the sibling
 * category list in parallel. A 404 on the capability → `notFound()`;
 * any other failure throws to the admin error boundary (#518). Only the
 * capability decides not-found: the other loads never throw. A failed
 * agent-usage list is passed on as `null`, so the form's "Used by" card
 * shows `<LoadFailedNotice>` and the quarantine card names no number of
 * affected agents, rather than stating zero as fact. A failed category
 * list shows `<LoadFailedNotice>` and leaves the dropdown with only
 * "+ New category…".
 */
async function getCapability(id: string): Promise<AiCapability> {
  const { data } = await requireServerData<AiCapability>(
    API.ADMIN.ORCHESTRATION.capabilityById(id),
    { notFound: true }
  );
  return data;
}

/**
 * The caller's org's agents using it, by name, and other orgs' as a count
 * (`meta.otherOrgAgentCount`, §107 t-752). `null` when it can't be loaded
 * (logged by `loadServerData`). The route 404s for a missing capability
 * too; that case is left to the capability fetch's `notFound()`.
 */
async function getUsedBy(
  id: string
): Promise<{ agents: UsedByAgentSummary[]; otherOrgAgentCount: number } | null> {
  const result = await loadServerData<UsedByAgentSummary[]>(
    API.ADMIN.ORCHESTRATION.capabilityAgents(id)
  );
  if (!result.ok) return null;
  const { data, meta } = result;
  const other =
    typeof meta === 'object' && meta !== null && 'otherOrgAgentCount' in meta
      ? meta.otherOrgAgentCount
      : 0;
  return {
    agents: data,
    otherOrgAgentCount: typeof other === 'number' && other > 0 ? other : 0,
  };
}

async function getAvailableCategories(): Promise<string[] | null> {
  const result = await loadServerData<AiCapability[]>(
    `${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=100`
  );
  if (!result.ok) return null;
  return Array.from(new Set(result.data.map((c) => c.category).filter(Boolean))).sort();
}

export default async function EditCapabilityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [capability, usedBy, availableCategories] = await Promise.all([
    getCapability(id),
    getUsedBy(id),
    getAvailableCategories(),
  ]);

  // Audit attribution endpoint short-circuits to null when active, so
  // we just fetch unconditionally.
  const quarantineAttribution = await getQuarantineAttribution(id);

  // Drive the page on the *effective* state — a past `quarantineUntil`
  // is treated as active by the dispatcher and every other read path,
  // so the page must agree or the UI lies about runtime behaviour.
  // `resolveQuarantineState` accepts the raw `string` column and applies
  // the same unknown-value-fail-open guard the dispatcher uses, so no
  // `as` cast on the API response is needed.
  const quarantineUntilDate = capability.quarantineUntil
    ? new Date(capability.quarantineUntil)
    : null;
  const effectiveQuarantineState = resolveQuarantineState({
    quarantineState: capability.quarantineState ?? 'active',
    quarantineUntil: quarantineUntilDate,
  });
  const isQuarantined = effectiveQuarantineState !== 'active';

  const quarantineCard = (
    <CapabilityQuarantineCard
      capabilityId={id}
      capabilityName={capability.name}
      state={{
        quarantineState: effectiveQuarantineState,
        quarantineReason: capability.quarantineReason ?? null,
        quarantineUntil: quarantineUntilDate ? quarantineUntilDate.toISOString() : null,
      }}
      attribution={quarantineAttribution}
      affectedAgents={
        usedBy ? usedBy.agents.map((a) => ({ id: a.id, name: a.name, slug: a.slug })) : null
      }
      otherOrgAffectedCount={usedBy?.otherOrgAgentCount ?? 0}
    />
  );

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/capabilities" className="hover:underline">
          Capabilities
        </Link>
        {' / '}
        <span>{capability.name}</span>
      </nav>

      <CapabilityStatsPanel capabilityId={id} />

      {isQuarantined && quarantineCard}

      <SharedSettingsReadOnlyNotice />

      {availableCategories === null && <LoadFailedNotice what="existing capability categories" />}

      <CapabilityForm
        mode="edit"
        capability={capability}
        usedBy={usedBy ? usedBy.agents : null}
        otherOrgUsedByCount={usedBy?.otherOrgAgentCount ?? 0}
        availableCategories={availableCategories ?? []}
      />

      {!isQuarantined && quarantineCard}
    </div>
  );
}
