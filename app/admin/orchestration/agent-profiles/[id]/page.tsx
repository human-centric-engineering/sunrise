import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  AgentProfileForm,
  type AgentProfileRow,
} from '@/components/admin/orchestration/agent-profile-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';

export const metadata: Metadata = {
  title: 'Edit agent profile · AI Orchestration',
  description: 'Update the persona, brand voice, and guardrails shared by attached agents.',
};

async function getProfile(id: string): Promise<AgentProfileRow | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.agentProfileById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<AgentProfileRow>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('edit agent profile page: fetch failed', err, { id });
    return null;
  }
}

export default async function EditAgentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await getProfile(id);
  if (!profile) notFound();

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/agent-profiles" className="hover:underline">
          Agent Profiles
        </Link>
        {' / '}
        <span>{profile.name}</span>
      </nav>

      <SharedSettingsReadOnlyNotice />

      <AgentProfileForm mode="edit" profile={profile} />
    </div>
  );
}
