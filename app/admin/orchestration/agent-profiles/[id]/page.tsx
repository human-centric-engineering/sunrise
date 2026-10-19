import type { Metadata } from 'next';
import Link from 'next/link';

import {
  AgentProfileForm,
  type AgentProfileRow,
} from '@/components/admin/orchestration/agent-profile-form';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';

export const metadata: Metadata = {
  title: 'Edit agent profile · AI Orchestration',
  description: 'Update the persona, brand voice, and guardrails shared by attached agents.',
};

export default async function EditAgentProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // A 404 is a missing profile; any other failure reaches the error boundary.
  const { data: profile } = await requireServerData<AgentProfileRow>(
    API.ADMIN.ORCHESTRATION.agentProfileById(id),
    { notFound: true }
  );

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
