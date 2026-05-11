import type { Metadata } from 'next';
import Link from 'next/link';

import {
  LearningTabs,
  type LearningTabsAgent,
} from '@/components/admin/orchestration/learn/learning-tabs';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { PATTERN_ATTRIBUTION_LINE } from '@/lib/orchestration/knowledge/attribution';
import type { PatternSummary } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Learning · AI Orchestration',
  description: 'Explore agentic design patterns and test your knowledge.',
};

async function getPatterns(): Promise<PatternSummary[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_PATTERNS);
    if (!res.ok) return [];
    const body = await parseApiResponse<PatternSummary[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('learn page: pattern fetch failed', err);
    return [];
  }
}

/**
 * Locate a built-in agent by slug from the `/agents` list endpoint and
 * project it to the small `{ id, enableVoiceInput }` shape the chat
 * tabs need to render the mic affordance.
 *
 * We use the `q` substring search rather than a slug-exact route
 * because the agents list endpoint already exists and we'd rather not
 * add a new route for a one-off lookup. The `?q=<slug>` shape can
 * return multiple matches (substring), so we filter for the exact
 * slug match in the caller before reading metadata. Returns `null`
 * when the agent row hasn't been seeded yet or the lookup failed —
 * callers fall back to text-only chat.
 */
async function getAgentBySlug(slug: string): Promise<LearningTabsAgent | null> {
  try {
    const url = `${API.ADMIN.ORCHESTRATION.AGENTS}?q=${encodeURIComponent(slug)}&limit=10`;
    const res = await serverFetch(url);
    if (!res.ok) return null;
    const body =
      await parseApiResponse<Array<{ id: string; slug: string; enableVoiceInput?: boolean }>>(res);
    if (!body.success) return null;
    const match = body.data.find((a) => a.slug === slug);
    if (!match) return null;
    return {
      id: match.id,
      // Defensive default — older list responses may not carry the
      // field; treat absence as voice-off rather than throwing.
      enableVoiceInput: match.enableVoiceInput ?? false,
    };
  } catch (err) {
    logger.error('learn page: agent fetch failed', { slug, err });
    return null;
  }
}

interface PageProps {
  searchParams: Promise<{ contextType?: string; contextId?: string }>;
}

export default async function LearnPage({ searchParams }: PageProps) {
  const [patterns, params, advisorAgent, quizAgent] = await Promise.all([
    getPatterns(),
    searchParams,
    // Each chat tab needs `id` + `enableVoiceInput` to decide whether
    // to surface the mic. Fetched in parallel with the patterns query
    // so we don't bottleneck render on serial lookups.
    getAgentBySlug('pattern-advisor'),
    getAgentBySlug('quiz-master'),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Learning</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Learning{' '}
          <FieldHelp
            title="What is the learning centre?"
            contentClassName="w-96 max-h-80 overflow-y-auto"
          >
            <p>
              The learning centre is a built-in reference for agentic AI design patterns — the
              architectural building blocks like prompt chaining, routing, parallelisation, and
              evaluator-optimiser loops that power production AI systems.
            </p>
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              Each pattern has a detailed explanation with flow diagrams, strengths/weaknesses, and
              real examples. The advisor chatbot can recommend which patterns suit your use case.
              The quiz checks your understanding before you build.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              Browse the pattern catalogue, ask the advisor for guidance, and take the knowledge
              check.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Explore agentic design patterns, get guidance from the advisor, and test your knowledge.
        </p>
        <p className="text-muted-foreground mt-1 text-xs">{PATTERN_ATTRIBUTION_LINE}</p>
      </header>

      <LearningTabs
        patterns={patterns}
        contextType={params.contextType}
        contextId={params.contextId}
        advisorAgent={advisorAgent}
        quizAgent={quizAgent}
      />
    </div>
  );
}
