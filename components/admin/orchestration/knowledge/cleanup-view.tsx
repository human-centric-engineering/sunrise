'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  History,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { z } from 'zod';

import { ChatInterface } from '@/components/admin/orchestration/chat/chat-interface';
import { PendingChangeModal } from '@/components/admin/orchestration/knowledge/pending-change-modal';
import { RevisionDrawer } from '@/components/admin/orchestration/knowledge/revision-drawer';
import { RevisionHistory } from '@/components/admin/orchestration/knowledge/revision-history';
import { SectionList } from '@/components/admin/orchestration/knowledge/section-list';
import {
  DiffModeToggle,
  TextDiffViewer,
  type DiffMode,
} from '@/components/admin/orchestration/knowledge/text-diff-viewer';
import { SaveError } from '@/components/forms/form-error';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSession } from '@/lib/auth/client';
import { apiClient, apiErrorFromResponse } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { detectSections } from '@/lib/orchestration/knowledge/section-detection';
import { useCleanupEditLock } from '@/lib/hooks/use-cleanup-edit-lock';

interface CleanupViewProps {
  documentId: string;
  documentName: string;
  fileName: string;
  originalContent: string;
  initialProcessedContent: string;
  sizeClass: 'small' | 'medium' | 'large' | 'too-large';
  sizeTokens: number;
  llmRewriteAllowed: boolean;
  /**
   * Context window (in tokens) of the cleanup conversation's bound model.
   * Used to warn the admin before they trigger a per-section refine that
   * would exceed the model's budget. Falls back to a 128k default when the
   * cleanup conversation hasn't been created yet.
   */
  contextWindow: number;
}

const docResponseSchema = z.object({
  document: z.object({
    id: z.string(),
    status: z.string(),
    originalContent: z.string().nullable(),
    processedContent: z.string().nullable(),
  }),
});

const SIZE_CLASS_LABEL: Record<CleanupViewProps['sizeClass'], string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  'too-large': 'Too large for whole-doc LLM rewrite',
};

const SIZE_CLASS_TONE: Record<CleanupViewProps['sizeClass'], string> = {
  small: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  medium: 'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200',
  large: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  'too-large': 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
};

export function CleanupView({
  documentId,
  documentName,
  fileName,
  originalContent,
  initialProcessedContent,
  sizeClass,
  sizeTokens,
  llmRewriteAllowed,
  contextWindow,
}: CleanupViewProps) {
  const router = useRouter();
  const session = useSession();
  const currentUserId = session.data?.user.id ?? '';
  const [processedContent, setProcessedContent] = useState(initialProcessedContent);
  const [pendingAction, setPendingAction] = useState<'commit' | 'use-original' | 'delete' | null>(
    null
  );
  const finaliseFailure = useSaveFailure({
    fallback: 'Could not finish the clean up. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const { clear: clearFinaliseFailure, report: reportFinaliseFailure } = finaliseFailure;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState('cleaned');
  const [diffMode, setDiffMode] = useState<DiffMode>('unified');
  // The preview pane sits beside the chat at half width, which is tight for a
  // side-by-side diff. Expanding spans it across both columns and drops the
  // chat below it, rather than hiding either.
  const [previewExpanded, setPreviewExpanded] = useState(false);
  // Bumped after every document refetch so the History tab's list picks up
  // revisions the agent has just written.
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  // When the agent's rewrite_with_llm or rewrite_section_with_llm capability
  // returns, the result carries a pendingChangeId. We pop the diff modal so
  // the admin can Accept or Reject before the change applies.
  const [pendingChangeId, setPendingChangeId] = useState<string | null>(null);

  const onCapabilityResult = useCallback((slug: string, result: unknown) => {
    if (slug !== 'rewrite_with_llm' && slug !== 'rewrite_section_with_llm') return;
    if (typeof result !== 'object' || result === null) return;
    const r = result as { data?: { pendingChangeId?: string } };
    if (r.data?.pendingChangeId) {
      setPendingChangeId(r.data.pendingChangeId);
    }
  }, []);

  const lock = useCleanupEditLock(documentId, currentUserId);

  // Release the lock when the page unmounts (admin navigated away mid-edit).
  // Best-effort — server-side TTL expiry covers the case where the browser
  // crashes before this fires. The effect below must stay mount/unmount-only
  // (empty deps) so its cleanup fires exactly once, on real unmount — so
  // heldByMe is tracked via a ref rather than an effect dependency, which
  // would otherwise leave the cleanup closure permanently reading the
  // initial-render value (always false).
  const heldByMeRef = useRef(lock.heldByMe);
  useEffect(() => {
    heldByMeRef.current = lock.heldByMe;
  }, [lock.heldByMe]);

  useEffect(() => {
    return () => {
      if (heldByMeRef.current) void lock.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch the doc after each chat turn so the preview pane reflects any
  // mutations the agent applied via its capabilities. The cleanup capabilities
  // write to processedContent in-place; the chat doesn't echo content back.
  const refetchDoc = useCallback(async () => {
    try {
      const body = await apiClient.get<unknown>(
        API.ADMIN.ORCHESTRATION.knowledgeDocumentById(documentId)
      );
      const parsed = docResponseSchema.safeParse(body);
      if (!parsed.success) return;
      const next =
        parsed.data.document.processedContent ?? parsed.data.document.originalContent ?? '';
      setProcessedContent(next);
      setHistoryRefreshKey((k) => k + 1);
    } catch {
      // Best-effort refresh; the chat continues to work even if this fails.
    }
  }, [documentId]);

  const charsRemoved = originalContent.length - processedContent.length;
  const reductionPct =
    originalContent.length === 0 ? 0 : Math.max(0, (charsRemoved / originalContent.length) * 100);

  const finalise = useCallback(
    async (action: 'commit' | 'use-original' | 'delete') => {
      setPendingAction(action);
      clearFinaliseFailure();
      try {
        const res = await fetch(
          `${API.ADMIN.ORCHESTRATION.knowledgeDocumentById(documentId)}/cleanup/finalise`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          }
        );
        if (!res.ok) throw await apiErrorFromResponse(res);
        router.push('/admin/orchestration/knowledge');
      } catch (err) {
        reportFinaliseFailure(err);
      } finally {
        setPendingAction(null);
      }
    },
    [documentId, router, clearFinaliseFailure, reportFinaliseFailure]
  );

  const sizeLabel = useMemo(() => SIZE_CLASS_LABEL[sizeClass], [sizeClass]);
  const sizeTone = useMemo(() => SIZE_CLASS_TONE[sizeClass], [sizeClass]);

  // Initial nudge for the agent — sent as the first user turn so the agent
  // calls estimate_size and proposes a starting plan. Only used as a starter
  // chip; the admin can type instead.
  const starterPrompts = useMemo(
    () => [
      `Take a look at this document. Suggest what to clean up.`,
      `Strip timestamps and speaker labels, then collapse whitespace.`,
      ...(llmRewriteAllowed
        ? ['Remove filler words and tighten the language.']
        : ['The document is large — use deterministic strips and then re-check size.']),
    ],
    [llmRewriteAllowed]
  );

  const sections = useMemo(() => detectSections(processedContent), [processedContent]);
  const finaliseDisabled = pendingAction !== null || lock.heldByOther;

  return (
    <div className="space-y-4">
      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Sparkles className="text-muted-foreground h-5 w-5" />
              <h1 className="truncate text-xl font-semibold" title={documentName}>
                {documentName}
              </h1>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${sizeTone}`}
                title={`~${sizeTokens.toLocaleString()} tokens`}
              >
                {sizeLabel}
              </span>
            </div>
            <p className="text-muted-foreground mt-1 truncate text-xs" title={fileName}>
              {fileName} · {processedContent.length.toLocaleString()} chars
              {charsRemoved !== 0 ? ` · ${reductionPct.toFixed(1)}% reduction` : null}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {/* Downloads the text as it stands right now — mid-session, before
                anything is chunked. The variant follows the visible tab so the
                button never disagrees with what the admin is looking at. */}
            <Button variant="ghost" size="sm" asChild>
              <a
                href={API.ADMIN.ORCHESTRATION.knowledgeDocumentDownload(
                  documentId,
                  previewTab === 'original' ? 'original' : 'cleaned'
                )}
                download
              >
                <Download className="mr-1 h-3 w-3" />
                Download {previewTab === 'original' ? 'original' : 'cleaned'}
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHistoryOpen(true)}
              disabled={pendingAction !== null}
            >
              <History className="mr-1 h-3 w-3" />
              History
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void finalise('delete')}
              disabled={finaliseDisabled}
              className="text-destructive hover:text-destructive"
            >
              {pendingAction === 'delete' ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="mr-1 h-3 w-3" />
              )}
              Discard &amp; delete
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void finalise('use-original')}
              disabled={finaliseDisabled}
            >
              {pendingAction === 'use-original' ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : null}
              Use original
            </Button>
            <Button size="sm" onClick={() => void finalise('commit')} disabled={finaliseDisabled}>
              {pendingAction === 'commit' ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-3 w-3" />
              )}
              Mark cleaned
            </Button>
          </div>
        </div>
        {/* In the sticky header, directly below the finalise buttons. */}
        {finaliseFailure.failure ? (
          <div className="mt-3">
            <SaveError failure={finaliseFailure.failure} />
          </div>
        ) : null}
        {!llmRewriteAllowed ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This document is too large for a whole-document LLM rewrite. Deterministic strips and
              per-section rewrites still work. Run deterministic cleanups first, then re-check the
              size with <code>estimate_size</code>.
            </span>
          </div>
        ) : null}
        {lock.heldByOther ? (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-200">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              This document is being edited by{' '}
              <strong>{lock.state?.heldBy ?? 'another admin'}</strong>. Editor and chat are paused
              until they finish (auto-released after {Math.round((lock.state?.ttlMs ?? 0) / 60_000)}{' '}
              minutes of inactivity).
            </span>
          </div>
        ) : null}
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`rounded-lg border ${previewExpanded ? 'lg:col-span-2' : ''}`}>
          <Tabs value={previewTab} onValueChange={setPreviewTab} className="w-full">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
              <div className="flex items-center gap-2">
                <FileText className="text-muted-foreground h-4 w-4" />
                <span className="text-sm font-medium">Document preview</span>
                {lock.heldByMe ? (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                    <Lock className="h-3 w-3" /> editing
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <TabsList>
                  <TabsTrigger value="cleaned">Cleaned</TabsTrigger>
                  <TabsTrigger value="original">Original</TabsTrigger>
                  <TabsTrigger value="diff">Diff</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                </TabsList>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPreviewExpanded((v) => !v)}
                  aria-pressed={previewExpanded}
                  title={previewExpanded ? 'Shrink to half width' : 'Expand to full width'}
                >
                  {previewExpanded ? (
                    <Minimize2 className="h-3.5 w-3.5" />
                  ) : (
                    <Maximize2 className="h-3.5 w-3.5" />
                  )}
                  <span className="sr-only">
                    {previewExpanded ? 'Shrink document preview' : 'Expand document preview'}
                  </span>
                </Button>
              </div>
            </div>
            <TabsContent value="cleaned" className="m-0">
              {lock.heldByOther ? (
                // Read-only fallback when another admin owns the lock — show
                // the doc but don't render editable sections (would surface
                // confusing 423s on every save).
                <div className="max-h-[60vh] overflow-auto">
                  <pre className="p-3 text-xs whitespace-pre-wrap">
                    {processedContent || '(empty)'}
                  </pre>
                </div>
              ) : sections.length === 0 ? (
                <div className="max-h-[60vh] overflow-auto">
                  <pre className="p-3 text-xs whitespace-pre-wrap">(empty)</pre>
                </div>
              ) : (
                <SectionList
                  documentId={documentId}
                  sections={sections}
                  contextWindow={contextWindow}
                  acquireLock={lock.acquire}
                  onSaved={() => void refetchDoc()}
                  onPendingChange={(id) => setPendingChangeId(id)}
                />
              )}
            </TabsContent>
            <TabsContent value="original" className="m-0">
              <pre className="text-muted-foreground max-h-[60vh] overflow-auto p-3 text-xs whitespace-pre-wrap">
                {originalContent || '(empty)'}
              </pre>
            </TabsContent>
            <TabsContent value="diff" className="m-0">
              <div className="space-y-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground text-xs">
                    Original on the left as it was parsed, cleaned on the right. Long unchanged runs
                    are collapsed — click one to expand it.
                  </p>
                  <DiffModeToggle mode={diffMode} onChange={setDiffMode} />
                </div>
                <TextDiffViewer
                  before={originalContent}
                  after={processedContent}
                  mode={diffMode}
                  beforeLabel="Original"
                  afterLabel="Cleaned"
                />
              </div>
            </TabsContent>
            <TabsContent value="history" className="m-0">
              <div className="p-3">
                <RevisionHistory
                  documentId={documentId}
                  currentContent={processedContent}
                  onRestored={() => void refetchDoc()}
                  refreshKey={historyRefreshKey}
                />
              </div>
            </TabsContent>
          </Tabs>
        </section>

        <section
          className={`bg-card relative flex h-[70vh] flex-col rounded-lg border ${
            previewExpanded ? 'lg:col-span-2' : ''
          }`}
        >
          {lock.heldByMe ? (
            // Pessimistic overlay — disables the chat while the admin is
            // mid-edit so a capability call can't race the in-progress save.
            <div className="bg-background/70 absolute inset-0 z-10 flex items-start justify-center backdrop-blur-sm">
              <div className="bg-background mt-12 max-w-xs rounded-md border p-3 text-center text-xs">
                <Lock className="text-muted-foreground mx-auto mb-2 h-4 w-4" />
                <p className="font-medium">Paused: document is being edited</p>
                <p className="text-muted-foreground mt-1">
                  Save or cancel the current section to re-enable the agent.
                </p>
              </div>
            </div>
          ) : null}
          <ChatInterface
            agentSlug="cleanup-agent"
            contextType="knowledge_document"
            contextId={documentId}
            persistenceKey={`kb-cleanup-${documentId}`}
            starterPrompts={starterPrompts}
            onStreamComplete={() => void refetchDoc()}
            onCapabilityResult={(slug, result) => {
              onCapabilityResult(slug, result);
              void refetchDoc();
            }}
            embedded
            className="flex-1"
          />
        </section>
      </div>

      <RevisionDrawer
        documentId={documentId}
        currentContent={processedContent}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestored={() => void refetchDoc()}
      />

      <PendingChangeModal
        documentId={documentId}
        changeId={pendingChangeId}
        onClose={() => setPendingChangeId(null)}
        onResolved={() => void refetchDoc()}
      />
    </div>
  );
}
