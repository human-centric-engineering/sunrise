import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { AgentProfileRow } from '@/components/admin/orchestration/agent-profile-form';

type ProfileListRow = AgentProfileRow & { agentCount: number; updatedAt: string };

export const metadata: Metadata = {
  title: 'Agent Profiles · AI Orchestration',
  description: 'Reusable persona, brand voice, and guardrails that agents inherit.',
};

async function getProfiles(): Promise<ProfileListRow[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENT_PROFILES}?page=1&limit=50`);
    if (!res.ok) return [];
    const body = await parseApiResponse<ProfileListRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('agent-profiles page: list fetch failed', err);
    return [];
  }
}

export default async function AgentProfilesListPage() {
  const profiles = await getProfiles();

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground -mb-5 text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <span>Agent Profiles</span>
      </nav>
      <header className="bg-background sticky top-0 z-30 -mx-6 flex items-start justify-between gap-4 border-b px-6 pt-3 pb-3">
        <div>
          <h1 className="text-2xl font-semibold">
            Agent Profiles{' '}
            <FieldHelp title="What is an agent profile?" contentClassName="w-96">
              <p>
                A profile is a reusable bundle of <strong>persona</strong>,{' '}
                <strong>brand voice</strong>, and <strong>guardrails</strong>. Multiple agents can
                attach to the same profile and inherit those defaults — change the profile once, the
                agents pick it up.
              </p>
              <p className="mt-2">
                Each agent can override or append per-field, so role-specific tweaks stay local
                while shared identity stays central.
              </p>
            </FieldHelp>
          </h1>
          <p className="text-muted-foreground text-sm">
            Shared persona / voice / guardrails that agents inherit and override.
          </p>
        </div>
        <Button asChild>
          <Link href="/admin/orchestration/agent-profiles/new">
            <Plus className="mr-2 h-4 w-4" />
            New profile
          </Link>
        </Button>
      </header>

      {profiles.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-8 text-center text-sm">
          <Users className="mx-auto mb-2 h-8 w-8 opacity-40" />
          <p>No profiles yet.</p>
          <p className="mt-1 text-xs">
            Create a profile to share persona / brand voice / guardrails across several agents.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-left text-xs uppercase">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Slug</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 text-right font-medium">Agents</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <tr key={p.id} className="hover:bg-muted/30 border-t">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/orchestration/agent-profiles/${p.id}`}
                      className="font-medium hover:underline"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="text-muted-foreground px-4 py-3 font-mono text-xs">{p.slug}</td>
                  <td className="text-muted-foreground px-4 py-3 text-xs">
                    {p.description ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{p.agentCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
