import type { Metadata } from 'next';
import Link from 'next/link';

import { AgentProfileForm } from '@/components/admin/orchestration/agent-profile-form';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';

export const metadata: Metadata = {
  title: 'New agent profile · AI Orchestration',
  description: 'Define reusable persona, brand voice, and guardrails for one or more agents.',
};

export default function NewAgentProfilePage() {
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
        <span>New</span>
      </nav>

      <SharedSettingsReadOnlyNotice />

      <AgentProfileForm mode="create" />
    </div>
  );
}
