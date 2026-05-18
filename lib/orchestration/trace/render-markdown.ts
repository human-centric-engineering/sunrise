/**
 * Deterministic Markdown rendering of a workflow execution + trace.
 *
 * No LLM. The trace already has all the data; we render it as a
 * structured Markdown document a human can read top-to-bottom. The
 * supervisor's evidence-cited verdict heads the document (when
 * present); deterministic per-step narration follows.
 *
 * Why deterministic, not LLM-generated: an LLM narration of the trace
 * would re-introduce the marking-your-own-homework problem the
 * supervisor was added to fix. The reader gets opinion from the
 * supervisor and structured facts from this renderer.
 *
 * Used by:
 *  - `report` step executor (in-workflow rendering — output goes into
 *    `stepOutputs` and can feed a downstream `send_notification`)
 *  - `GET /api/v1/admin/orchestration/executions/:id/report.md`
 *    (on-demand download from `ExecutionDetailView`)
 *
 * Platform-agnostic: no Next.js imports.
 */

import {
  DEFAULT_PER_STEP_CAP_BYTES,
  TERMINAL_HEAD_CAP_BYTES,
  sampleString,
  serialiseStepOutput,
} from '@/lib/orchestration/trace/truncate';
import type {
  ExecutionTraceEntry,
  SupervisorReport,
  SupervisorWeakness,
} from '@/types/orchestration';

export interface RenderExecutionInfo {
  id: string;
  workflowId: string;
  workflowName?: string | null;
  status: string;
  totalTokensUsed: number;
  totalCostUsd: number;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string;
  inputData?: unknown;
  outputData?: unknown;
  errorMessage?: string | null;
  supervisorVerdict?: string | null;
  supervisorScore?: number | null;
  /**
   * Validated supervisor report — callers MUST run the raw Json column
   * through `supervisorReportSchema.safeParse` before passing it in.
   * `null` means "no supervisor ran" or "validation failed, skip block".
   * Keeping this typed (vs `unknown`) lets the renderer access fields
   * without local casts.
   */
  supervisorReport?: SupervisorReport | null;
  supervisorReviewedAt?: string | null;
}

export interface RenderOptions {
  /**
   * Output-truncation strategy. Defaults to `'auto'`.
   *  - `'auto'`: per-step outputs > 4KB get head + middle + tail sampling.
   *  - `'all'`: no truncation (large reports).
   *  - `'terminal-only'`: full output for the most-recent step; 1KB head for earlier steps.
   */
  includeStepOutputs?: 'auto' | 'all' | 'terminal-only';
  /**
   * Optional admin host (e.g. "https://admin.example.com") to absolutize
   * the link back to the execution detail page in the footer. Omit for
   * relative links.
   */
  hostPrefix?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDurationMs(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = (seconds % 60).toFixed(0);
  return `${minutes}m ${rem}s`;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString();
  } catch {
    return iso;
  }
}

function formatTotalDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined
): string {
  if (!startedAt || !completedAt) return '—';
  const t0 = new Date(startedAt).getTime();
  const t1 = new Date(completedAt).getTime();
  if (Number.isNaN(t0) || Number.isNaN(t1)) return '—';
  return formatDurationMs(t1 - t0);
}

function truncateOutput(
  raw: string,
  mode: 'auto' | 'all' | 'terminal-only',
  isTerminal: boolean
): string {
  if (mode === 'all') return raw;
  if (mode === 'terminal-only' && isTerminal) return raw;
  if (mode === 'terminal-only') return sampleString(raw, TERMINAL_HEAD_CAP_BYTES);
  return sampleString(raw, DEFAULT_PER_STEP_CAP_BYTES);
}

function fenceJson(input: unknown): string {
  if (input === null || input === undefined) return '_none_';
  try {
    return '```json\n' + JSON.stringify(input, null, 2) + '\n```';
  } catch (err) {
    return `_could not serialize: ${err instanceof Error ? err.message : 'unknown error'}_`;
  }
}

function statusBadge(status: string | undefined): string {
  if (!status) return '';
  return ` \`[${status}]\``;
}

// ─── Supervisor block ──────────────────────────────────────────────────────

function renderWeakness(w: SupervisorWeakness, idx: number): string {
  const sev = w.severity.toUpperCase();
  const recommendation = w.recommendation ? ` _Recommendation: ${w.recommendation}_` : '';
  const cite =
    w.evidenceStepId && w.evidenceQuote
      ? ` _(see step \`${w.evidenceStepId}\`: "${w.evidenceQuote.slice(0, 200)}")_`
      : '';
  return `${idx + 1}. **[${sev}]** ${w.claim}${cite}${recommendation}`;
}

function renderSupervisorBlock(report: SupervisorReport): string {
  const lines: string[] = [];
  lines.push(`> ## Neutral supervisor assessment`);
  lines.push(`>`);
  lines.push(
    `> **Verdict:** \`${report.verdict}\`${
      typeof report.score === 'number' ? ` &nbsp; **Score:** ${report.score.toFixed(2)}` : ''
    } &nbsp; **Confidence:** ${report.confidence}`
  );
  lines.push(`>`);
  lines.push(`> ${report.summary}`);

  if (report.weaknesses.length > 0) {
    lines.push(`>`);
    lines.push(`> **Weaknesses (${report.weaknesses.length})**`);
    for (let i = 0; i < report.weaknesses.length; i += 1) {
      lines.push(`> ${renderWeakness(report.weaknesses[i], i)}`);
    }
  }

  if (report.anomalies.length > 0) {
    lines.push(`>`);
    lines.push(`> **Anomalies**`);
    for (const a of report.anomalies) {
      lines.push(`> - \`${a.stepId}\`: ${a.observation}`);
    }
  }

  if (report.unverifiedAreas.length > 0) {
    lines.push(`>`);
    lines.push(`> **Unverified areas**`);
    for (const u of report.unverifiedAreas) {
      lines.push(`> - ${u}`);
    }
  }

  if (report.invalidCitations && report.invalidCitations.length > 0) {
    lines.push(`>`);
    lines.push(
      `> _The post-hoc citation validator stripped ${report.invalidCitations.length} claim(s) whose evidence did not ground in the trace; verdict may have been downgraded._`
    );
  }

  return lines.join('\n');
}

// ─── Renderer ───────────────────────────────────────────────────────────────

export function renderExecutionMarkdown(
  execution: RenderExecutionInfo,
  trace: ExecutionTraceEntry[],
  options: RenderOptions = {}
): string {
  const mode = options.includeStepOutputs ?? 'auto';
  const totalDuration = formatTotalDuration(execution.startedAt, execution.completedAt);
  const workflowLabel = execution.workflowName
    ? `${execution.workflowName} (\`${execution.workflowId}\`)`
    : `\`${execution.workflowId}\``;
  const mostRecentStepId = trace.length > 0 ? trace[trace.length - 1].stepId : null;

  const lines: string[] = [];

  // ─── Header ────────────────────────────────────────────────────────────
  lines.push(`# Execution report — \`${execution.id}\``);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Workflow | ${workflowLabel} |`);
  lines.push(`| Status | \`${execution.status}\` |`);
  lines.push(`| Started | ${formatTimestamp(execution.startedAt)} |`);
  lines.push(`| Completed | ${formatTimestamp(execution.completedAt)} |`);
  lines.push(`| Duration | ${totalDuration} |`);
  lines.push(`| Total tokens | ${execution.totalTokensUsed.toLocaleString()} |`);
  lines.push(`| Total cost | $${execution.totalCostUsd.toFixed(4)} |`);
  if (execution.supervisorVerdict) {
    lines.push(
      `| Supervisor verdict | \`${execution.supervisorVerdict}\`${
        typeof execution.supervisorScore === 'number'
          ? ` (score ${execution.supervisorScore.toFixed(2)})`
          : ''
      } |`
    );
  }
  lines.push('');

  // ─── Error banner ──────────────────────────────────────────────────────
  if (execution.errorMessage) {
    lines.push(`## Error`);
    lines.push('');
    lines.push('```');
    lines.push(execution.errorMessage);
    lines.push('```');
    lines.push('');
  }

  // ─── Supervisor block ──────────────────────────────────────────────────
  // `supervisorReport` is now typed `SupervisorReport | null` on
  // `RenderExecutionInfo`, validated by the caller. No cast needed.
  if (execution.supervisorReport) {
    lines.push(renderSupervisorBlock(execution.supervisorReport));
    lines.push('');
  }

  // ─── Input ─────────────────────────────────────────────────────────────
  lines.push(`## Input data`);
  lines.push('');
  lines.push(fenceJson(execution.inputData));
  lines.push('');

  // ─── Step timeline ─────────────────────────────────────────────────────
  lines.push(`## Step timeline (${trace.length} steps)`);
  lines.push('');
  if (trace.length === 0) {
    lines.push('_No trace entries recorded._');
    lines.push('');
  } else {
    trace.forEach((entry, idx) => {
      lines.push(`### ${idx + 1}. ${entry.label || entry.stepId}${statusBadge(entry.status)}`);
      lines.push('');
      const meta: string[] = [
        `Type \`${entry.stepType}\``,
        `Duration ${formatDurationMs(entry.durationMs)}`,
        `Tokens ${(entry.tokensUsed ?? 0).toLocaleString()}`,
        `Cost $${(entry.costUsd ?? 0).toFixed(4)}`,
      ];
      if (entry.model) meta.push(`Model \`${entry.model}\``);
      if (entry.provider) meta.push(`Provider \`${entry.provider}\``);
      lines.push(meta.join(' · '));
      lines.push('');

      if (entry.expectedSkip && entry.status === 'skipped') {
        lines.push('_Skip is part of the workflow’s happy path (expectedSkip)._');
        lines.push('');
      }

      if (entry.error) {
        lines.push(`**Error:** \`${entry.error}\``);
        lines.push('');
      }

      if (entry.retries && entry.retries.length > 0) {
        lines.push(`**Retries:**`);
        for (const r of entry.retries) {
          const exhausted = r.exhausted ? ' (exhausted)' : '';
          lines.push(`- attempt ${r.attempt}/${r.maxRetries}: ${r.reason}${exhausted}`);
        }
        lines.push('');
      }

      if (entry.input !== undefined) {
        lines.push(`**Input**`);
        lines.push('');
        const rawIn = serialiseStepOutput(entry.input);
        const truncIn = truncateOutput(rawIn, mode, false);
        lines.push('```');
        lines.push(truncIn);
        lines.push('```');
        lines.push('');
      }

      if (entry.output !== undefined) {
        lines.push(`**Output**`);
        lines.push('');
        const raw = serialiseStepOutput(entry.output);
        const trunc = truncateOutput(raw, mode, entry.stepId === mostRecentStepId);
        lines.push('```');
        lines.push(trunc);
        lines.push('```');
        lines.push('');
      }
    });
  }

  // ─── Output ────────────────────────────────────────────────────────────
  lines.push(`## Output data`);
  lines.push('');
  lines.push(fenceJson(execution.outputData));
  lines.push('');

  // ─── Footer ────────────────────────────────────────────────────────────
  const url = `${options.hostPrefix ?? ''}/admin/orchestration/executions/${execution.id}`;
  lines.push(`---`);
  lines.push(`Execution \`${execution.id}\` — [open in admin](${url})`);
  lines.push(`Generated ${new Date().toISOString()}.`);

  return lines.join('\n');
}
