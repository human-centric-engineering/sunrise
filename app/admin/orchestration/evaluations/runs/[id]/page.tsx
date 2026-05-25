/**
 * /admin/orchestration/evaluations/runs/:id
 *
 * Run detail view. The client component handles polling + per-case
 * drill-in; this server page is the shell + nav crumb.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { RunDetailView } from '@/components/admin/orchestration/evaluations-foundations/run-detail-view';

export const metadata: Metadata = {
  title: 'Run · AI Orchestration',
};

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin/orchestration/evaluations/runs">
            <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
            Batch runs
          </Link>
        </Button>
      </div>

      <RunDetailView runId={id} />
    </div>
  );
}
