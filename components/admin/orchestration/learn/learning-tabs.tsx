'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Trophy } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { API } from '@/lib/api/endpoints';
import { useUrlTabs } from '@/lib/hooks/use-url-tabs';
import { extractWorkflowDefinition } from '@/lib/orchestration/utils/extract-workflow-definition';
import type { PatternSummary } from '@/types/orchestration';

import { ChatInterface } from '@/components/admin/orchestration/chat/chat-interface';
import { EmbeddingStatusBanner } from '@/components/admin/orchestration/knowledge/embedding-status-banner';
import { PatternCardGrid } from '@/components/admin/orchestration/learn/pattern-card-grid';

/**
 * Compact agent record passed through from the server page so each
 * embedded `<ChatInterface>` can decide whether to render the mic
 * affordance. The page fetches `id` + `enableVoiceInput` for the
 * advisor and quiz-master agents; missing/null means "voice off" and
 * the chat falls back to text-only (e.g. agent row not seeded yet).
 */
export interface LearningTabsAgent {
  id: string;
  enableVoiceInput: boolean;
}

interface LearningTabsProps {
  patterns: PatternSummary[];
  contextType?: string;
  contextId?: string;
  /** Pattern Advisor agent record — used to gate the mic on the advisor tab. */
  advisorAgent?: LearningTabsAgent | null;
  /** Quiz Master agent record — used to gate the mic on the quiz tab. */
  quizAgent?: LearningTabsAgent | null;
}

const ALLOWED_TABS = ['patterns', 'advisor', 'quiz'] as const;
type LearningTab = (typeof ALLOWED_TABS)[number];

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
  // Matches "Score: 3/5", "Score: 3 out of 5", etc. Requires "score:" prefix
  // to avoid false positives on arbitrary fractions like "3/5 of the patterns".
  const match = /\bscore:\s*(\d+)\s*(?:out of|\/)\s*(\d+)/i.exec(text);
  if (!match?.[1] || !match?.[2]) return null;
  const correct = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  if (total <= 0 || correct > total) return null;
  return { correct, total };
}

interface EmbeddingStatus {
  total: number;
  embedded: number;
  pending: number;
  hasActiveProvider: boolean;
}

export function LearningTabs({
  patterns,
  contextType,
  contextId,
  advisorAgent,
  quizAgent,
}: LearningTabsProps) {
  const router = useRouter();
  const { activeTab, setActiveTab } = useUrlTabs<LearningTab>({
    defaultTab: 'patterns',
    allowedTabs: ALLOWED_TABS,
  });
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

    // Load the most recent persisted quiz score
    fetch(API.ADMIN.ORCHESTRATION.QUIZ_SCORES)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { data?: { correct: number; total: number }[] } | null) => {
        const latest = body?.data?.[0];
        if (latest) setQuizScore({ correct: latest.correct, total: latest.total });
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
      // Persist to database (fire-and-forget)
      fetch(API.ADMIN.ORCHESTRATION.QUIZ_SCORES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(score),
      }).catch(() => {});
    }
  }, []);

  const handleCreateWorkflow = useCallback(() => {
    if (!workflowRecommendation) return;
    router.push(
      `/admin/orchestration/workflows/new?definition=${encodeURIComponent(workflowRecommendation)}`
    );
  }, [router, workflowRecommendation]);

  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as LearningTab)}>
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
            agentId={advisorAgent?.id}
            voiceInputEnabled={advisorAgent?.enableVoiceInput ?? false}
            embedded
            contextType={contextType}
            contextId={contextId}
            starterPrompts={ADVISOR_PROMPTS}
            onStreamComplete={handleStreamComplete}
            // Admin learning surface — show inline tool-call diagnostics
            // so the advisor's knowledge-base lookups and capability use
            // are visible to the operator.
            showInlineTrace
            // Survive tab switches and reloads — operators routinely
            // pivot between Patterns/Advisor/Quiz mid-conversation.
            // 24 h TTL is enforced inside ChatInterface.
            persistenceKey="learn:advisor"
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
              <FieldHelp title="Quiz score">
                Your latest quiz score, parsed from the quiz-master agent&apos;s responses. Take a
                quiz to update it. Scores are saved across sessions.
              </FieldHelp>
            </div>
          )}

          <ChatInterface
            agentSlug="quiz-master"
            agentId={quizAgent?.id}
            voiceInputEnabled={quizAgent?.enableVoiceInput ?? false}
            embedded
            starterPrompts={QUIZ_PROMPTS}
            onStreamComplete={handleQuizStreamComplete}
            showInlineTrace
            persistenceKey="learn:quiz"
            className="h-[600px]"
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}
