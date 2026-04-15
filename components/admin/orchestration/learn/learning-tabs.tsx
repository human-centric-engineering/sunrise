'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Trophy } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { API } from '@/lib/api/endpoints';
import type { PatternSummary } from '@/types/orchestration';

import { ChatInterface } from '@/components/admin/orchestration/chat/chat-interface';
import { EmbeddingStatusBanner } from '@/components/admin/orchestration/knowledge/embedding-status-banner';
import { PatternCardGrid } from './pattern-card-grid';

interface LearningTabsProps {
  patterns: PatternSummary[];
}

const ADVISOR_PROMPTS = [
  'What pattern should I use for content moderation?',
  'Compare chain vs parallel patterns',
  'Design a customer support workflow',
  'Explain human-in-the-loop tradeoffs',
];

const QUIZ_PROMPTS = [
  "Start a quiz — I'm a beginner",
  "Start a quiz — I'm intermediate",
  'Test me on Pattern 14 (RAG)',
  'Quiz me on workflow composition',
];

/** Parse a running quiz score from assistant text (best-effort). */
function parseQuizScore(text: string): { correct: number; total: number } | null {
  // Matches "Score: 3/5", "3 out of 5", "3/5", etc.
  const match = /(?:score:\s*)?(\d+)\s*(?:out of|\/)\s*(\d+)/i.exec(text);
  if (!match?.[1] || !match?.[2]) return null;
  const correct = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  if (total <= 0 || correct > total) return null;
  return { correct, total };
}

/** Extract a workflow-definition code block from assistant text. */
function extractWorkflowDefinition(text: string): string | null {
  const match = /```workflow-definition\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) return null;

  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'steps' in parsed &&
      Array.isArray((parsed as Record<string, unknown>).steps)
    ) {
      return match[1];
    }
  } catch {
    // Invalid JSON — ignore
  }
  return null;
}

interface EmbeddingStatus {
  total: number;
  embedded: number;
  pending: number;
  hasActiveProvider: boolean;
}

export function LearningTabs({ patterns }: LearningTabsProps) {
  const router = useRouter();
  const [workflowRecommendation, setWorkflowRecommendation] = useState<string | null>(null);
  const [quizScore, setQuizScore] = useState<{ correct: number; total: number } | null>(null);
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);

  useEffect(() => {
    fetch(API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBEDDING_STATUS)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: EmbeddingStatus } | null) => {
        if (body?.data) setEmbeddingStatus(body.data);
      })
      .catch(() => {});
  }, []);

  const handleStreamComplete = useCallback((fullText: string) => {
    const definition = extractWorkflowDefinition(fullText);
    if (definition) {
      setWorkflowRecommendation(definition);
    }
  }, []);

  const handleQuizStreamComplete = useCallback((fullText: string) => {
    const score = parseQuizScore(fullText);
    if (score) {
      setQuizScore(score);
    }
  }, []);

  const handleCreateWorkflow = useCallback(() => {
    if (!workflowRecommendation) return;
    router.push(
      `/admin/orchestration/workflows/new?definition=${encodeURIComponent(workflowRecommendation)}`
    );
  }, [router, workflowRecommendation]);

  return (
    <Tabs defaultValue="patterns">
      <TabsList>
        <TabsTrigger value="patterns">Patterns</TabsTrigger>
        <TabsTrigger value="advisor">Advisor</TabsTrigger>
        <TabsTrigger value="quiz">Quiz</TabsTrigger>
      </TabsList>

      <TabsContent value="patterns" className="mt-4">
        <PatternCardGrid patterns={patterns} />
      </TabsContent>

      <TabsContent value="advisor" className="mt-4">
        <div className="flex flex-col gap-3">
          {embeddingStatus && embeddingStatus.total > 0 && embeddingStatus.pending > 0 && (
            <EmbeddingStatusBanner
              total={embeddingStatus.total}
              embedded={embeddingStatus.embedded}
              hasActiveProvider={embeddingStatus.hasActiveProvider}
            />
          )}
          <ChatInterface
            agentSlug="pattern-advisor"
            embedded
            starterPrompts={ADVISOR_PROMPTS}
            onStreamComplete={handleStreamComplete}
            className="h-[600px]"
          />

          {workflowRecommendation && (
            <div className="bg-muted/30 flex items-center justify-between rounded-md border p-3">
              <span className="text-sm">The advisor recommended a workflow definition.</span>
              <Button size="sm" onClick={handleCreateWorkflow}>
                <Sparkles className="mr-1 h-4 w-4" aria-hidden="true" />
                Create this workflow
              </Button>
            </div>
          )}
        </div>
      </TabsContent>

      <TabsContent value="quiz" className="mt-4">
        <div className="flex flex-col gap-3">
          {embeddingStatus && embeddingStatus.total > 0 && embeddingStatus.pending > 0 && (
            <EmbeddingStatusBanner
              total={embeddingStatus.total}
              embedded={embeddingStatus.embedded}
              hasActiveProvider={embeddingStatus.hasActiveProvider}
            />
          )}
          {quizScore && (
            <div className="flex items-center gap-2">
              <Trophy className="text-muted-foreground h-4 w-4" aria-hidden="true" />
              <Badge variant="secondary" data-testid="quiz-score">
                {quizScore.correct}/{quizScore.total}
              </Badge>
            </div>
          )}

          <ChatInterface
            agentSlug="quiz-master"
            embedded
            starterPrompts={QUIZ_PROMPTS}
            onStreamComplete={handleQuizStreamComplete}
            className="h-[600px]"
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}
