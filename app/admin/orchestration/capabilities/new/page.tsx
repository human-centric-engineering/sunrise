import type { Metadata } from 'next';
import Link from 'next/link';

import { CapabilityForm } from '@/components/admin/orchestration/capability-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
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
 * are already in use. Fetch failure falls back to an empty category
 * list; the form still works (admins can enter a new category).
 */
async function getAvailableCategories(): Promise<string[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AiCapability[]>(res);
    if (!body.success) return [];
    return Array.from(new Set(body.data.map((c) => c.category).filter(Boolean))).sort();
  } catch (err) {
    logger.error('new capability page: categories fetch failed', err);
    return [];
  }
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

      <CapabilityForm mode="create" availableCategories={availableCategories} />
    </div>
  );
}
