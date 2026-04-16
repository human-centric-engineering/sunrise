import type { Metadata } from 'next';
import Link from 'next/link';

import { LearningTabs } from '@/components/admin/orchestration/learn/learning-tabs';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
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

export default async function LearnPage() {
  const patterns = await getPatterns();

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
      </header>

      <LearningTabs patterns={patterns} />
    </div>
  );
}
