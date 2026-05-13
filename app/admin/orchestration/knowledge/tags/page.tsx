import type { Metadata } from 'next';
import Link from 'next/link';

import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { PaginationMeta } from '@/types/api';
import { KnowledgeTagsTable } from '@/components/admin/orchestration/knowledge/knowledge-tags-table';
import type { KnowledgeTagListItem } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Knowledge tags · AI Orchestration',
  description:
    'Manage the tag taxonomy used to scope which knowledge documents each agent can search.',
};

const EMPTY_META: PaginationMeta = { page: 1, limit: 50, total: 0, totalPages: 1 };

async function getTags(): Promise<{ tags: KnowledgeTagListItem[]; meta: PaginationMeta }> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?page=1&limit=50`);
    if (!res.ok) return { tags: [], meta: EMPTY_META };
    const body = await parseApiResponse<KnowledgeTagListItem[]>(res);
    if (!body.success) return { tags: [], meta: EMPTY_META };
    return { tags: body.data, meta: parsePaginationMeta(body.meta) ?? EMPTY_META };
  } catch (err) {
    logger.error('knowledge tags page: initial fetch failed', err);
    return { tags: [], meta: EMPTY_META };
  }
}

export default async function KnowledgeTagsPage(): Promise<React.ReactElement> {
  const { tags, meta } = await getTags();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <Link href="/admin/orchestration/knowledge" className="hover:underline">
            Knowledge
          </Link>
          {' / '}
          <span>Tags</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Knowledge tags{' '}
          <FieldHelp
            title="What are knowledge tags?"
            contentClassName="w-96 max-h-80 overflow-y-auto"
          >
            <p>
              Tags are a managed taxonomy applied to knowledge-base documents. They let you scope an
              agent&apos;s knowledge access to a deliberate subset of the library instead of giving
              every agent access to everything.
            </p>
            <p className="text-foreground mt-2 font-medium">How they work</p>
            <p>
              A tag has a slug (stable, cross-environment key) and a human-readable name. Apply tags
              to documents during upload, then grant agents access to one or more tags. When an
              agent runs in <strong>restricted</strong> mode, the resolver expands its granted tags
              into the underlying documents and applies that as a filter on knowledge search.
            </p>
            <p className="text-foreground mt-2 font-medium">System-seeded docs</p>
            <p>
              Documents with <em>scope = system</em> are always visible to every agent regardless of
              tag grants — they&apos;re shared platform reference material and gating them per agent
              is confusing.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Define the taxonomy used to scope what each agent can search.
        </p>
      </header>

      <KnowledgeTagsTable initialTags={tags} initialMeta={meta} />
    </div>
  );
}
