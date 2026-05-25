'use client';

/**
 * GenerateCasesButton
 *
 * Opens a two-step modal for synthesising new dataset cases:
 *
 *   1. **Configure** — pick a subject agent, a mode (KB-grounded or
 *      failure-mining), how many cases (1–25), and (for KB mode) an
 *      optional topic anchor. Submitting hits
 *      `POST /datasets/:id/generate-cases` (the preview route — one
 *      LLM call, sub-capped at 10/min via `synthesisLimiter`).
 *   2. **Review** — the API returns proposed cases tagged with
 *      `source: 'synthetic'`. The admin scrolls them, optionally
 *      deselects ones that look wrong, and clicks Save → the modal
 *      POSTs the surviving cases to `.../generate-cases/commit`,
 *      which writes them via `appendCasesToDataset` (no LLM call,
 *      transactional).
 *
 * Lives next to `SaveToDatasetButton` so the two synthesis surfaces
 * share the same dataset-side patterns.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { API } from '@/lib/api/endpoints';

interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

interface ProposedCase {
  input: string | Record<string, unknown>;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
}

interface PreviewResult {
  cases: ProposedCase[];
  costUsd: number;
  tokenUsage: { input: number; output: number };
}

interface CommitResult {
  datasetId: string;
  appendedCount: number;
  newCaseCount: number;
}

interface GenerateCasesButtonProps {
  datasetId: string;
  /**
   * Agents the operator can target — passed from the server page so
   * the modal doesn't have to round-trip. Empty list is fine; the
   * modal renders a helpful message.
   */
  agents: AgentOption[];
}

type ApiSuccess<T> = { success: true; data: T };
type ApiError = { success: false; error: { message: string } };

type Step = 'configure' | 'review';

export function GenerateCasesButton({
  datasetId,
  agents,
}: GenerateCasesButtonProps): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<Step>('configure');

  const [agentId, setAgentId] = React.useState<string>(agents[0]?.id ?? '');
  const [mode, setMode] = React.useState<'kb' | 'failure_mining'>('kb');
  const [count, setCount] = React.useState<number>(5);
  const [topic, setTopic] = React.useState('');

  const [generating, setGenerating] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<PreviewResult | null>(null);
  const [selectedIndices, setSelectedIndices] = React.useState<Set<number>>(new Set());

  function reset(): void {
    setStep('configure');
    setPreview(null);
    setError(null);
    setSelectedIndices(new Set());
  }

  function handleOpen(next: boolean): void {
    if (!next) reset();
    setOpen(next);
  }

  async function handleGenerate(): Promise<void> {
    if (!agentId) {
      setError('Pick a subject agent first.');
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { agentId, mode, count };
      if (mode === 'kb' && topic.trim().length > 0) body.topic = topic.trim();
      const res = await fetch(API.ADMIN.ORCHESTRATION.evalDatasetGenerateCases(datasetId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as ApiSuccess<PreviewResult> | ApiError;
      if (!res.ok || !payload.success) {
        setError(!payload.success ? payload.error.message : `Failed (${res.status})`);
        return;
      }
      setPreview(payload.data);
      // Default to "select all proposals" — operator can untick the ones
      // they don't want before saving. Saves them clicking through
      // a presumably-good set.
      setSelectedIndices(new Set(payload.data.cases.map((_, i) => i)));
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleCommit(): Promise<void> {
    if (!preview) return;
    const accepted = preview.cases.filter((_, i) => selectedIndices.has(i));
    if (accepted.length === 0) {
      setError('Select at least one case to save.');
      return;
    }
    setCommitting(true);
    setError(null);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.evalDatasetGenerateCasesCommit(datasetId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cases: accepted }),
      });
      const payload = (await res.json()) as ApiSuccess<CommitResult> | ApiError;
      if (!res.ok || !payload.success) {
        setError(!payload.success ? payload.error.message : `Failed (${res.status})`);
        return;
      }
      // Refresh the server-rendered dataset page so the new caseCount
      // + content hash + first-N case list reflect the synth.
      router.refresh();
      handleOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  }

  function toggleSelected(i: number): void {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => handleOpen(true)}>
        <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
        Generate cases
      </Button>
      <Dialog open={open} onOpenChange={handleOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Generate dataset cases</DialogTitle>
            <DialogDescription>
              {step === 'configure'
                ? 'Pick a subject agent and a seed mode. The case-generator agent proposes cases; nothing is saved until you accept them.'
                : `Review the ${preview?.cases.length ?? 0} proposed case${preview?.cases.length === 1 ? '' : 's'} below. Untick anything that looks wrong before saving.`}
            </DialogDescription>
          </DialogHeader>

          {step === 'configure' ? (
            <ConfigureStep
              agents={agents}
              agentId={agentId}
              setAgentId={setAgentId}
              mode={mode}
              setMode={setMode}
              count={count}
              setCount={setCount}
              topic={topic}
              setTopic={setTopic}
            />
          ) : (
            <ReviewStep
              preview={preview}
              selectedIndices={selectedIndices}
              toggleSelected={toggleSelected}
            />
          )}

          {error ? (
            <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
              {error}
            </div>
          ) : null}

          <DialogFooter>
            {step === 'configure' ? (
              <>
                <Button variant="ghost" onClick={() => handleOpen(false)} disabled={generating}>
                  Cancel
                </Button>
                <Button
                  onClick={() => void handleGenerate()}
                  disabled={generating || !agentId || agents.length === 0}
                >
                  {generating ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
                  )}
                  Generate
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={reset} disabled={committing}>
                  Back
                </Button>
                <Button
                  onClick={() => void handleCommit()}
                  disabled={committing || selectedIndices.size === 0}
                >
                  {committing ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                  ) : null}
                  Save {selectedIndices.size} case{selectedIndices.size === 1 ? '' : 's'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConfigureStep({
  agents,
  agentId,
  setAgentId,
  mode,
  setMode,
  count,
  setCount,
  topic,
  setTopic,
}: {
  agents: AgentOption[];
  agentId: string;
  setAgentId: (v: string) => void;
  mode: 'kb' | 'failure_mining';
  setMode: (v: 'kb' | 'failure_mining') => void;
  count: number;
  setCount: (v: number) => void;
  topic: string;
  setTopic: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-2">
        <Label htmlFor="synth-agent">Subject agent</Label>
        {agents.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No chat agents available. Create one before synthesising cases.
          </p>
        ) : (
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger id="synth-agent">
              <SelectValue placeholder="Pick an agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-muted-foreground text-xs">
          The generated cases will be aimed at this agent — KB mode samples its accessible
          knowledge, failure-mining samples its prior low-scoring runs.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="synth-mode">Mode</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as 'kb' | 'failure_mining')}>
          <SelectTrigger id="synth-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="kb">KB-grounded — sample the agent&apos;s docs</SelectItem>
            <SelectItem value="failure_mining">
              Failure-mining — harden against past failures
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="synth-count">Count</Label>
          <Input
            id="synth-count"
            type="number"
            min={1}
            max={25}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
          />
          <p className="text-muted-foreground text-xs">Up to 25 per request.</p>
        </div>
        {mode === 'kb' ? (
          <div className="space-y-2">
            <Label htmlFor="synth-topic">Topic (optional)</Label>
            <Input
              id="synth-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. refund policy"
              maxLength={500}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReviewStep({
  preview,
  selectedIndices,
  toggleSelected,
}: {
  preview: PreviewResult | null;
  selectedIndices: Set<number>;
  toggleSelected: (i: number) => void;
}): React.ReactElement {
  if (!preview) return <p className="text-muted-foreground text-sm">No proposals.</p>;
  return (
    <div className="space-y-3 py-2">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Badge variant="outline" className="text-[10px]">
          {preview.cases.length} proposals
        </Badge>
        <span>·</span>
        <span>${preview.costUsd.toFixed(4)} generator cost</span>
        <span>·</span>
        <span>
          {preview.tokenUsage.input} in / {preview.tokenUsage.output} out tokens
        </span>
      </div>
      <div className="max-h-[400px] space-y-2 overflow-y-auto pr-2">
        {preview.cases.map((c, i) => (
          <div key={i} className="rounded-md border p-3">
            <div className="flex items-start gap-3">
              <Checkbox
                id={`proposal-${i}`}
                checked={selectedIndices.has(i)}
                onCheckedChange={() => toggleSelected(i)}
                className="mt-1"
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor={`proposal-${i}`} className="text-xs font-medium uppercase">
                  Input
                </Label>
                <p className="text-sm whitespace-pre-wrap">
                  {typeof c.input === 'string' ? c.input : JSON.stringify(c.input)}
                </p>
                {c.expectedOutput ? (
                  <>
                    <Label className="text-xs font-medium uppercase">Expected output</Label>
                    <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                      {c.expectedOutput}
                    </p>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
