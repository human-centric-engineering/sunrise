import type { Metadata } from 'next';
import Link from 'next/link';

import { CapabilityForm } from '@/components/admin/orchestration/capability-form';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import type { AiCapability } from '@/types/prisma';

export const metadata: Metadata = {
  title: 'New capability · AI Orchestration',
  description: 'Create a new capability — a tool your agents can call.',
};

/**
 * Admin — New capability page (Phase 4 Session 4.3).
 *
 * Thin server shell. Fetches the existing capability list once so the
 * Basic-tab category `<Select>` can populate from whatever categories
 * are already in use. The form works without them (admins can enter a
 * new category), so a failed load shows `<LoadFailedNotice>` above the
 * form and leaves the dropdown with only "+ New category…" (#518).
 */
async function getAvailableCategories(): Promise<string[] | null> {
  const result = await loadServerData<AiCapability[]>(
    `${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=100`
  );
  if (!result.ok) return null;
  return Array.from(new Set(result.data.map((c) => c.category).filter(Boolean))).sort();
}

export default async function NewCapabilityPage() {
  const availableCategories = await getAvailableCategories();

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
        <span>New</span>
      </nav>

      <SharedSettingsReadOnlyNotice />

      {availableCategories === null && <LoadFailedNotice what="existing capability categories" />}

      <CapabilityForm mode="create" availableCategories={availableCategories ?? []} />
    </div>
  );
}
