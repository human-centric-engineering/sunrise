import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  CapabilityForm,
  type UsedByAgentSummary,
} from '@/components/admin/orchestration/capability-form';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Edit capability · AI Orchestration',
  description: 'Edit an existing capability.',
};

/**
 * Admin — Edit capability page (Phase 4 Session 4.3).
 *
 * Fetches the capability, its agent-usage list, and the sibling
 * category list in parallel. Missing capability → `notFound()`. The
 * other two fetches tolerate failure — the form degrades to an empty
 * `usedBy` chip card / empty category dropdown rather than throwing.
 */
export default async function EditCapabilityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let capability, usedBy: UsedByAgentSummary[], availableCategories: string[];
  try {
    const [cap, agentLinks, allCaps] = await Promise.all([
      prisma.aiCapability.findUnique({ where: { id } }),
      prisma.aiAgentCapability.findMany({
        where: { capabilityId: id },
        include: { agent: { select: { id: true, name: true, slug: true } } },
      }),
      prisma.aiCapability.findMany({ select: { category: true } }),
    ]);
    capability = cap;
    usedBy = agentLinks.map((link) => ({
      id: link.agent.id,
      name: link.agent.name,
      slug: link.agent.slug,
    }));
    availableCategories = Array.from(
      new Set(allCaps.map((c) => c.category).filter(Boolean))
    ).sort();
  } catch (err) {
    logger.error('edit capability page: fetch failed', err, { id });
    capability = null;
    usedBy = [];
    availableCategories = [];
  }

  if (!capability) notFound();

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

      <CapabilityForm
        mode="edit"
        capability={capability}
        usedBy={usedBy}
        availableCategories={availableCategories}
      />
    </div>
  );
}
