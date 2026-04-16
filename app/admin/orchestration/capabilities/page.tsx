import type { Metadata } from 'next';
import Link from 'next/link';

import { CapabilitiesTable } from '@/components/admin/orchestration/capabilities-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { parsePaginationMeta } from '@/lib/validations/common';
import { logger } from '@/lib/logging';
import type { AiCapabilityListItem } from '@/types/orchestration';
import type { PaginationMeta } from '@/types/api';

export const metadata: Metadata = {
  title: 'Capabilities · AI Orchestration',
  description:
    'Manage the tools your agents can call — function definitions, execution, and safety.',
};

const EMPTY_META: PaginationMeta = {
  page: 1,
  limit: 25,
  total: 0,
  totalPages: 1,
};

/**
 * Admin — Capabilities list page (Phase 4 Session 4.3).
 *
 * Thin server component that pre-renders the first page of capabilities
 * via `serverFetch` and hands the result to `<CapabilitiesTable>` for
 * client-side search / filter / sort / pagination. Fetch failures never
 * throw — the table renders an empty state so the page is still usable.
 */
async function getCapabilities(): Promise<{
  capabilities: AiCapabilityListItem[];
  meta: PaginationMeta;
}> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?page=1&limit=25`);
    if (!res.ok) return { capabilities: [], meta: EMPTY_META };
    const body = await parseApiResponse<AiCapabilityListItem[]>(res);
    if (!body.success) return { capabilities: [], meta: EMPTY_META };
    return {
      capabilities: body.data,
      meta: parsePaginationMeta(body.meta) ?? EMPTY_META,
    };
  } catch (err) {
    logger.error('capabilities list page: initial fetch failed', err);
    return { capabilities: [], meta: EMPTY_META };
  }
}

export default async function CapabilitiesListPage() {
  const { capabilities, meta } = await getCapabilities();

  // Derive the category filter's option list from whatever we already
  // have in hand. Categories are free-text on the backend, so this is
  // an eventually-consistent hint, not a canonical list.
  const availableCategories = Array.from(
    new Set(capabilities.map((c) => c.category).filter(Boolean))
  ).sort();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Capabilities</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Capabilities{' '}
          <FieldHelp
            title="What are capabilities?"
            contentClassName="w-96 max-h-80 overflow-y-auto"
          >
            <p>
              On their own, AI agents can only read and write text. Capabilities are the real-world
              actions you give them — actual pieces of code that run on the server when the agent
              decides it needs to do something. For example, searching your knowledge base, calling
              an external API, sending an email, or looking up a database record.
            </p>
            <p className="text-foreground mt-2 font-medium">A concrete example</p>
            <p>
              Imagine an agent that helps with customer support. You could give it a{' '}
              <em>search_knowledge_base</em> capability that searches your help docs, and a{' '}
              <em>create_ticket</em> capability that calls your ticketing API. During a conversation
              the AI decides which capabilities to use, fills in the parameters, and the system
              executes the code and feeds the result back so the AI can continue the conversation
              with real data.
            </p>
            <p className="text-foreground mt-2 font-medium">Three execution modes</p>
            <p>
              <strong>Internal</strong> — a function built into this app (e.g. knowledge search).
              <br />
              <strong>API</strong> — calls an external HTTP endpoint and waits for the response.
              <br />
              <strong>Webhook</strong> — fires a request to a URL without waiting (fire-and-forget).
            </p>
            <p className="text-foreground mt-2 font-medium">Safety controls</p>
            <p>
              You can require human approval before a capability executes (useful for sensitive
              actions like payments or deletions) and set rate limits to prevent runaway usage.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Browse, create, and manage capabilities. Filter by category and see which agents use
              each one.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Actions your agents can perform — searching data, calling APIs, sending notifications, and
          more. Each is a piece of server-side code the AI triggers during a conversation.
        </p>
      </header>

      <CapabilitiesTable
        initialCapabilities={capabilities}
        initialMeta={meta}
        availableCategories={availableCategories}
      />
    </div>
  );
}
