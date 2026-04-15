import type { Metadata } from 'next';
import Link from 'next/link';

import { CapabilityForm } from '@/components/admin/orchestration/capability-form';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

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
export default async function NewCapabilityPage() {
  let availableCategories: string[];
  try {
    const allCaps = await prisma.aiCapability.findMany({ select: { category: true } });
    availableCategories = Array.from(
      new Set(allCaps.map((c) => c.category).filter(Boolean))
    ).sort();
  } catch (err) {
    logger.error('new capability page: categories fetch failed', err);
    availableCategories = [];
  }

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
