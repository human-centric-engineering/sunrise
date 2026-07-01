'use client';

/**
 * RunDetailView — client component that polls the run + per-case
 * endpoints every 3s while status is queued/running.
 *
 * Three panels:
 *  - Progress card (live updating)
 *  - Summary card (mean / median / p95 / passRate per metric, after completion)
 *  - Per-case results table with drill-in modal
 */

import * as React from 'react';
import Link from 'next/link';
import { Loader2, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { API } from '@/lib/api/endpoints';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RunDetail {
  id: string;
  name: string;
  description: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  subjectKind: 'agent' | 'workflow';
  agent: { id: string; name: string; slug: string } | null;
  workflow: { id: string; name: string; slug: string } | null;
  dataset: { id: string; name: string; caseCount: number; contentHash: string } | null;
  metricConfigs: Array<{ slug: string; config: Record<string, unknown> }>;
  judgeProvider: string | null;
  judgeModel: string | null;
  progress: { casesTotal: number; casesDone: number; casesFailed: number };
  summary: RunSummary | null;
  totalCostUsd: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface RunSummary {
  metricSlugs: string[];
  stats: Record<
    string,
    {
      mean: number | null;
      median: number | null;
      p95: number | null;
      passRate: number | null;
      scoredCount: number;
    }
  >;
  judgeProvider?: string;
  judgeModel?: string;
  completedAt?: string;
  totalJudgeTokens?: { input: number; output: number };
  note?: string;
}

interface CaseResult {
  id: string;
  casePosition: number;
  subjectOutput: string;
  subjectMetadata: Record<string, unknown> | null;
  metricScores: Record<
    string,
    {
      score: number | null;
      passed?: boolean;
      reasoning?: string;
      /** G-Eval chain-of-thought trace from the judge. */
      evaluationSteps?: string[];
      costUsd?: number;
    }
  >;
  latencyMs: number;
  costUsd: number;
  errorCode: string | null;
  errorMessage: string | null;
  datasetCase: {
    input: unknown;
    expectedOutput: string | null;
    metadata: Record<string, unknown> | null;
  };
}

const STATUS_STYLES: Record<RunDetail['status'], string> = {
  queued: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  cancelled: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
};

const ACTIVE_STATUSES = new Set(['queued', 'running']);

// ─── Component ───────────────────────────────────────────────────────────────

export function RunDetailView({ runId }: { runId: string }): React.ReactElement {
  const [run, setRun] = React.useState<RunDetail | null>(null);
  const [cases, setCases] = React.useState<CaseResult[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<CaseResult | null>(null);
  const [cancelling, setCancelling] = React.useState(false);

  // Poll loop — 3s while active, single fetch when terminal.
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      try {
        const detailRes = await fetch(API.ADMIN.ORCHESTRATION.evalRunById(runId), {
          cache: 'no-store',
        });
        const detailPayload = (await detailRes.json()) as
          { success: true; data: RunDetail } | { success: false; error: { message: string } };
        if (!detailRes.ok || !detailPayload.success) {
          setLoadError(
            !detailPayload.success ? detailPayload.error.message : `HTTP ${detailRes.status}`
          );
          return;
        }
        if (cancelled) return;
        setRun(detailPayload.data);

        // Case results — only fetch when there's something to show
        const casesRes = await fetch(`${API.ADMIN.ORCHESTRATION.evalRunCases(runId)}?limit=200`, {
          cache: 'no-store',
        });
        if (casesRes.ok) {
          const casesPayload = (await casesRes.json()) as
            | { success: true; data: { items: CaseResult[]; nextCursor: number | null } }
            | { success: false };
          if (casesPayload.success && !cancelled) {
            setCases(casesPayload.data.items);
          }
        }

        // Schedule next poll if still active
        if (!cancelled && ACTIVE_STATUSES.has(detailPayload.data.status)) {
          timer = setTimeout(() => void tick(), 3000);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  async function handleCancel(): Promise<void> {
    setCancelling(true);
    try {
      await fetch(API.ADMIN.ORCHESTRATION.evalRunCancel(runId), { method: 'POST' });
    } finally {
      setCancelling(false);
    }
  }

  if (loadError) {
    return (
      <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm">
        Failed to load run: {loadError}
      </div>
    );
  }
  if (!run) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading…
      </div>
    );
  }

  const progressPct = run.progress.casesTotal
    ? Math.floor((run.progress.casesDone / run.progress.casesTotal) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
            {run.name}
            <Badge className={`${STATUS_STYLES[run.status]} text-xs`}>{run.status}</Badge>
          </h1>
          {run.description ? (
            <p className="text-muted-foreground mt-1 text-sm">{run.description}</p>
          ) : null}
        </div>
        {ACTIVE_STATUSES.has(run.status) ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCancel()}
            disabled={cancelling}
          >
            <X className="mr-1 h-4 w-4" aria-hidden />
            {cancelling ? 'Cancelling…' : 'Cancel run'}
          </Button>
        ) : null}
      </div>

      {/* Top metadata strip */}
      <div className="grid gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Subject</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {run.subjectKind === 'agent' && run.agent ? (
              <>
                <Badge variant="outline" className="text-[10px]">
                  agent
                </Badge>{' '}
                {run.agent.name}
              </>
            ) : run.workflow ? (
              <>
                <Badge variant="outline" className="text-[10px]">
                  workflow
                </Badge>{' '}
                {run.workflow.name}
              </>
            ) : (
              '—'
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Dataset</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {run.dataset ? (
              <Link
                href={`/admin/orchestration/evaluations/datasets/${run.dataset.id}`}
                className="underline-offset-4 hover:underline"
              >
                {run.dataset.name}
              </Link>
            ) : (
              '—'
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1">
              {run.metricConfigs.map((m) => (
                <Badge key={m.slug} variant="outline" className="text-[10px]">
                  {m.slug}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-xs font-medium">Total cost</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-sm">
            {run.totalCostUsd != null ? `$${run.totalCostUsd.toFixed(4)}` : '—'}
          </CardContent>
        </Card>
      </div>

      {/* Progress */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Progress</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="bg-muted h-3 flex-1 overflow-hidden rounded-full">
              <div className="bg-primary h-3 transition-all" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="font-mono text-sm">
              {run.progress.casesDone} / {run.progress.casesTotal} ({progressPct}%)
            </span>
            {run.progress.casesFailed > 0 ? (
              <Badge variant="destructive" className="text-[10px]">
                {run.progress.casesFailed} failed
              </Badge>
            ) : null}
          </div>
          {ACTIVE_STATUSES.has(run.status) ? (
            <p className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Refreshing every 3 seconds.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Summary */}
      {run.summary ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Metric</TableHead>
                  <TableHead className="w-24">Scored</TableHead>
                  <TableHead className="w-24">Mean</TableHead>
                  <TableHead className="w-24">Median</TableHead>
                  <TableHead className="w-24">p95</TableHead>
                  <TableHead className="w-28">Pass rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.summary.metricSlugs.map((slug) => {
                  const s = run.summary?.stats[slug];
                  if (!s) return null;
                  return (
                    <TableRow key={slug}>
                      <TableCell className="font-mono text-xs">{slug}</TableCell>
                      <TableCell className="font-mono text-xs">{s.scoredCount}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.mean != null ? s.mean.toFixed(3) : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.median != null ? s.median.toFixed(3) : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.p95 != null ? s.p95.toFixed(3) : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {s.passRate != null ? `${Math.round(s.passRate * 100)}%` : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {run.summary.note ? (
              <p className="text-muted-foreground mt-3 text-xs">Note: {run.summary.note}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Per-case results */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-case results</CardTitle>
        </CardHeader>
        <CardContent>
          {cases.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {ACTIVE_STATUSES.has(run.status)
                ? 'Cases will appear here as the worker processes them.'
                : 'No case results recorded.'}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Input</TableHead>
                  {run.metricConfigs.map((m) => (
                    <TableHead key={m.slug} className="font-mono text-xs">
                      {m.slug}
                    </TableHead>
                  ))}
                  <TableHead className="w-16">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map((c) => (
                  <TableRow
                    key={c.id}
                    className="hover:bg-muted/30 cursor-pointer"
                    onClick={() => setSelected(c)}
                  >
                    <TableCell className="font-mono">{c.casePosition}</TableCell>
                    <TableCell className="max-w-xs">
                      <div className="line-clamp-2 text-xs">
                        {typeof c.datasetCase.input === 'string'
                          ? c.datasetCase.input
                          : JSON.stringify(c.datasetCase.input)}
                      </div>
                    </TableCell>
                    {run.metricConfigs.map((m) => {
                      const cell = c.metricScores[m.slug];
                      return (
                        <TableCell key={m.slug} className="font-mono text-xs">
                          {cell == null ? (
                            '—'
                          ) : cell.score == null ? (
                            <span className="text-muted-foreground">n/a</span>
                          ) : (
                            cell.score.toFixed(2)
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell className="font-mono text-xs">${c.costUsd.toFixed(4)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Per-case drill-in */}
      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-3xl">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>Case #{selected.casePosition}</DialogTitle>
              </DialogHeader>
              <div className="max-h-[70vh] space-y-4 overflow-y-auto">
                <Section title="Input">
                  <pre className="bg-muted rounded p-3 text-xs whitespace-pre-wrap">
                    {typeof selected.datasetCase.input === 'string'
                      ? selected.datasetCase.input
                      : JSON.stringify(selected.datasetCase.input, null, 2)}
                  </pre>
                </Section>
                {selected.datasetCase.expectedOutput ? (
                  <Section title="Expected output">
                    <pre className="bg-muted rounded p-3 text-xs whitespace-pre-wrap">
                      {selected.datasetCase.expectedOutput}
                    </pre>
                  </Section>
                ) : null}
                <Section title="Subject output">
                  <pre className="bg-muted rounded p-3 text-xs whitespace-pre-wrap">
                    {selected.subjectOutput || '(empty)'}
                  </pre>
                </Section>
                {selected.errorCode ? (
                  <Section title="Error">
                    <div className="border-destructive/30 bg-destructive/5 text-destructive rounded border p-3 text-xs">
                      <strong>{selected.errorCode}</strong>
                      {selected.errorMessage ? (
                        <p className="mt-1">{selected.errorMessage}</p>
                      ) : null}
                    </div>
                  </Section>
                ) : null}
                <ToolCallsSection metadata={selected.subjectMetadata} />
                <CitationsSection metadata={selected.subjectMetadata} />
                <Section title="Scores">
                  <div className="space-y-2">
                    {Object.entries(selected.metricScores).map(([slug, cell]) => (
                      <div key={slug} className="rounded border p-2">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-mono">{slug}</span>
                          {cell.score == null ? (
                            <Badge variant="outline">n/a</Badge>
                          ) : (
                            <Badge variant="secondary">{cell.score.toFixed(3)}</Badge>
                          )}
                          {cell.passed !== undefined ? (
                            <Badge variant={cell.passed ? 'default' : 'destructive'}>
                              {cell.passed ? 'pass' : 'fail'}
                            </Badge>
                          ) : null}
                        </div>
                        {cell.reasoning ? (
                          <p className="text-muted-foreground mt-1 text-xs">{cell.reasoning}</p>
                        ) : null}
                        {cell.evaluationSteps && cell.evaluationSteps.length > 0 ? (
                          <details className="mt-2">
                            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-[11px]">
                              Show judge&apos;s working ({cell.evaluationSteps.length} steps)
                            </summary>
                            <ol className="text-muted-foreground bg-muted/40 mt-1.5 list-inside space-y-1 rounded p-2 text-[11px]">
                              {cell.evaluationSteps.map((step, i) => (
                                <li key={i} className="list-decimal">
                                  {step}
                                </li>
                              ))}
                            </ol>
                          </details>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </Section>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trajectory + citations drill-in (Phase 3.6 diagnostic surfaces)
//
// `subjectMetadata` is the worker's persisted trace blob — `toolCalls` and
// `citations` live on it. They're the only honest way to answer questions
// like "why did `tool_was_called` fail?" — without seeing what the agent
// actually called, the operator is guessing.
// ---------------------------------------------------------------------------

interface ToolCallTraceRow {
  slug?: unknown;
  args?: unknown;
  arguments?: unknown;
  success?: unknown;
  errorCode?: unknown;
  latencyMs?: unknown;
}

interface CitationRow {
  title?: unknown;
  documentName?: unknown;
  uri?: unknown;
  url?: unknown;
  marker?: unknown;
}

function readArray(metadata: Record<string, unknown> | null, key: string): unknown[] {
  if (!metadata) return [];
  const v = metadata[key];
  return Array.isArray(v) ? v : [];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function ToolCallsSection({
  metadata,
}: {
  metadata: Record<string, unknown> | null;
}): React.ReactElement {
  const calls = readArray(metadata, 'toolCalls') as ToolCallTraceRow[];
  return (
    <Section title={`Tool calls (${calls.length})`}>
      {calls.length === 0 ? (
        <p className="text-muted-foreground bg-muted/40 rounded p-3 text-xs">
          The agent did not call any tools for this case. If a{' '}
          <code className="bg-background rounded px-1">tool_was_called</code> grader failed here,
          the most common causes are: the agent&apos;s instructions don&apos;t direct it to use the
          tool, the input didn&apos;t obviously need it, or the tool isn&apos;t actually bound to
          the agent.
        </p>
      ) : (
        <div className="space-y-2">
          {calls.map((c, i) => {
            const slug = stringOrUndefined(c.slug) ?? '(unknown slug)';
            const success = c.success === true;
            const errorCode = stringOrUndefined(c.errorCode);
            const args = c.args ?? c.arguments;
            return (
              <div key={i} className="rounded border p-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono">{slug}</span>
                  <Badge variant={success ? 'default' : 'destructive'}>
                    {success ? 'ok' : (errorCode ?? 'fail')}
                  </Badge>
                  {typeof c.latencyMs === 'number' ? (
                    <span className="text-muted-foreground text-[10px]">{c.latencyMs}ms</span>
                  ) : null}
                </div>
                {args !== undefined && args !== null ? (
                  <pre className="bg-muted/40 mt-1 rounded p-2 text-[11px] whitespace-pre-wrap">
                    {JSON.stringify(args, null, 2)}
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function CitationsSection({
  metadata,
}: {
  metadata: Record<string, unknown> | null;
}): React.ReactElement | null {
  const citations = readArray(metadata, 'citations') as CitationRow[];
  if (citations.length === 0) return null;
  return (
    <Section title={`Citations (${citations.length})`}>
      <ol className="space-y-1.5">
        {citations.map((c, i) => {
          const title = stringOrUndefined(c.title) ?? stringOrUndefined(c.documentName);
          const uri = stringOrUndefined(c.uri) ?? stringOrUndefined(c.url);
          const marker = typeof c.marker === 'number' ? c.marker : i + 1;
          return (
            <li key={i} className="bg-muted/40 rounded p-2 text-xs">
              <span className="text-muted-foreground mr-1.5 font-mono">[{marker}]</span>
              <span>{title ?? '(untitled source)'}</span>
              {uri ? (
                <span className="text-muted-foreground ml-2 font-mono text-[10px]">{uri}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
