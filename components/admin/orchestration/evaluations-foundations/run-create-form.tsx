'use client';

/**
 * RunCreateForm — single-page form for queueing a batch evaluation run.
 *
 * Five logical sections (Basics → Subject → Dataset → Heuristic graders
 * + Judge agents → Review). The metric picker is split in two:
 *
 *   - Heuristic graders (cheap, deterministic, no LLM)
 *   - Judge agents (one LLM call per case, agents the admin can edit
 *     in the existing agent form)
 *
 * Judge agents are loaded live from /graders so any kind='judge' agent
 * the admin creates appears automatically.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Edit3, Loader2, Play, Plus, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  graderHelp,
  runHelp,
} from '@/components/admin/orchestration/evaluations-foundations/help-text';
import { API } from '@/lib/api/endpoints';

// ─── Option types passed from the server page ───────────────────────────────

export interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

export interface WorkflowStepOption {
  id: string;
  name: string;
  type: string;
}

export interface WorkflowOption {
  id: string;
  name: string;
  slug: string;
  steps: WorkflowStepOption[];
}

export interface DatasetOption {
  id: string;
  name: string;
  caseCount: number;
}

export interface HeuristicGraderOption {
  slug: string;
  family: 'heuristic';
  description: string;
  referenceRequired: boolean;
  defaultConfig: unknown;
}

export interface JudgeAgentOption {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  model: string;
  provider: string;
}

interface RunCreateFormProps {
  agents: AgentOption[];
  /**
   * Workflows available as eval subjects. Optional so existing call
   * sites and tests that don't care about workflow subjects can omit
   * it; production callers (run-create page) always pass the list.
   * When empty, the Subject card hides the Workflow toggle.
   */
  workflows?: WorkflowOption[];
  datasets: DatasetOption[];
  heuristicGraders: HeuristicGraderOption[];
  judgeAgents: JudgeAgentOption[];
}

type SubjectKind = 'agent' | 'workflow';
type SelectorKind = 'final_report' | 'last_step' | 'step_id';

// ─── Local state types ──────────────────────────────────────────────────────

/** A ticked metric — heuristic by slug, judge by agent slug. */
type MetricSelection =
  | { kind: 'heuristic'; slug: string; config: Record<string, unknown> }
  | { kind: 'judge'; agentSlug: string };

// ─── Component ──────────────────────────────────────────────────────────────

export function RunCreateForm({
  agents,
  workflows = [],
  datasets,
  heuristicGraders,
  judgeAgents,
}: RunCreateFormProps): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefilledDatasetId = searchParams.get('datasetId') ?? '';

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [subjectKind, setSubjectKind] = React.useState<SubjectKind>('agent');
  const [agentId, setAgentId] = React.useState(agents[0]?.id ?? '');
  const [workflowId, setWorkflowId] = React.useState(workflows[0]?.id ?? '');
  const [selectorKind, setSelectorKind] = React.useState<SelectorKind>('last_step');
  const [selectorStepId, setSelectorStepId] = React.useState<string>('');
  const [datasetId, setDatasetId] = React.useState(prefilledDatasetId || datasets[0]?.id || '');
  const [selectedMetrics, setSelectedMetrics] = React.useState<MetricSelection[]>([]);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [agentCapabilities, setAgentCapabilities] = React.useState<
    Array<{ slug: string; name: string }>
  >([]);

  // Fetch the chosen agent's bound capabilities so the
  // `tool_was_called` grader can offer a slug dropdown rather than a
  // free-text input. Workflow subjects don't surface a single
  // capability set (steps may bind different ones) — the dropdown
  // falls back to a text input in that case.
  React.useEffect(() => {
    if (subjectKind !== 'agent' || !agentId) {
      setAgentCapabilities([]);
      return;
    }
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.agentCapabilities(agentId), {
          credentials: 'same-origin',
          signal: ac.signal,
        });
        if (!res.ok) {
          setAgentCapabilities([]);
          return;
        }
        const body = (await res.json()) as
          | {
              success: true;
              data: Array<{
                isEnabled: boolean;
                capability: { slug: string; name: string };
              }>;
            }
          | { success: false };
        if (!body.success) {
          setAgentCapabilities([]);
          return;
        }
        const enabled = body.data
          .filter((row) => row.isEnabled)
          .map((row) => ({ slug: row.capability.slug, name: row.capability.name }));
        setAgentCapabilities(enabled);
      } catch (err) {
        // Aborted fetch from a fast agent-switch — ignore silently.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setAgentCapabilities([]);
      }
    })();
    return () => ac.abort();
  }, [subjectKind, agentId]);

  const chosenDataset = datasets.find((d) => d.id === datasetId) ?? null;
  const chosenWorkflow = workflows.find((w) => w.id === workflowId) ?? null;
  const builtInJudges = judgeAgents.filter((j) => j.isSystem);
  const customJudges = judgeAgents.filter((j) => !j.isSystem);

  // When the user switches to a workflow that doesn't contain the
  // previously-selected step, drop the stale stepId so the submit
  // can't carry a value from a different workflow.
  React.useEffect(() => {
    if (selectorKind !== 'step_id') return;
    if (!chosenWorkflow) return;
    if (!chosenWorkflow.steps.some((s) => s.id === selectorStepId)) {
      setSelectorStepId(chosenWorkflow.steps[0]?.id ?? '');
    }
  }, [chosenWorkflow, selectorKind, selectorStepId]);

  const estimate = useEvaluationCostEstimate({
    subjectKind,
    agentId,
    workflowId,
    datasetId,
    selectedMetrics,
  });

  function toggleHeuristic(g: HeuristicGraderOption): void {
    setSelectedMetrics((prev) => {
      const existing = prev.find((m) => m.kind === 'heuristic' && m.slug === g.slug);
      if (existing) {
        return prev.filter((m) => !(m.kind === 'heuristic' && m.slug === g.slug));
      }
      const config =
        g.defaultConfig && typeof g.defaultConfig === 'object'
          ? { ...(g.defaultConfig as Record<string, unknown>) }
          : {};
      return [...prev, { kind: 'heuristic', slug: g.slug, config }];
    });
  }

  function toggleJudge(agentSlug: string): void {
    setSelectedMetrics((prev) => {
      const existing = prev.find((m) => m.kind === 'judge' && m.agentSlug === agentSlug);
      if (existing) {
        return prev.filter((m) => !(m.kind === 'judge' && m.agentSlug === agentSlug));
      }
      return [...prev, { kind: 'judge', agentSlug }];
    });
  }

  function updateHeuristicConfig(slug: string, patch: Record<string, unknown>): void {
    setSelectedMetrics((prev) =>
      prev.map((m) =>
        m.kind === 'heuristic' && m.slug === slug ? { ...m, config: { ...m.config, ...patch } } : m
      )
    );
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError('Give the run a name.');
    if (subjectKind === 'agent' && !agentId) return setError('Pick an agent.');
    if (subjectKind === 'workflow' && !workflowId) return setError('Pick a workflow.');
    if (subjectKind === 'workflow' && selectorKind === 'step_id' && !selectorStepId) {
      return setError('Pick a step for the workflow output selector.');
    }
    if (!datasetId) return setError('Pick a dataset.');
    if (selectedMetrics.length === 0) return setError('Pick at least one metric.');

    // Per-grader required-field check. The server-side Zod schemas would
    // reject these too, but the surfaced error is a raw Zod path string
    // ("Grader \"tool_was_called\" config invalid: slug: Too small …")
    // — catching it here lets us point at the specific config field.
    for (const m of selectedMetrics) {
      if (m.kind !== 'heuristic') continue;
      const cfg = m.config;
      const toolSlug = typeof cfg.slug === 'string' ? cfg.slug.trim() : '';
      if (m.slug === 'tool_was_called' && toolSlug.length === 0) {
        return setError(
          'Pick a tool slug for the "tool_was_called" grader (e.g. `search_knowledge_base`).'
        );
      }
      const pattern = typeof cfg.pattern === 'string' ? cfg.pattern.trim() : '';
      if (m.slug === 'regex' && pattern.length === 0) {
        return setError('Set a pattern for the "regex" grader.');
      }
    }

    // Compile the wire-format metricConfigs.
    const metricConfigs = selectedMetrics.map((m) =>
      m.kind === 'heuristic'
        ? { slug: m.slug, config: m.config }
        : { slug: 'judge_agent', config: { agentSlug: m.agentSlug } }
    );

    const subjectOutputSelector =
      subjectKind === 'workflow'
        ? selectorKind === 'step_id'
          ? { kind: selectorKind, stepId: selectorStepId }
          : { kind: selectorKind }
        : undefined;

    setIsSubmitting(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.EVAL_RUNS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          subjectKind,
          ...(subjectKind === 'agent' ? { agentId } : { workflowId }),
          datasetId,
          metricConfigs,
          ...(subjectOutputSelector ? { subjectOutputSelector } : {}),
        }),
      });
      const payload = (await res.json()) as
        { success: true; data: { id: string } } | { success: false; error: { message: string } };
      if (!res.ok || !payload.success) {
        setError(!payload.success ? payload.error.message : `Failed (${res.status})`);
        return;
      }
      router.push(`/admin/orchestration/evaluations/runs/${payload.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  // Count selections for the footer summary.
  const judgeCount = selectedMetrics.filter((m) => m.kind === 'judge').length;
  const heuristicCount = selectedMetrics.filter((m) => m.kind === 'heuristic').length;

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="max-w-3xl space-y-6">
      {/* Basics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">
              Name <FieldHelp title="Name">{runHelp.name}</FieldHelp>
            </Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Support agent v3 — pre-launch checks"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">
              Description <FieldHelp title="Description">{runHelp.description}</FieldHelp>
            </Label>
            <Textarea
              id="description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes about what changed in the subject since the last run"
              maxLength={2000}
            />
          </div>
        </CardContent>
      </Card>

      {/* Subject */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Subject <FieldHelp title="Subject">{runHelp.subjectKind}</FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Kind</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={subjectKind === 'agent' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSubjectKind('agent')}
              >
                Agent
              </Button>
              <Button
                type="button"
                variant={subjectKind === 'workflow' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSubjectKind('workflow')}
                disabled={workflows.length === 0}
              >
                Workflow
              </Button>
              {workflows.length === 0 ? (
                <span className="text-muted-foreground self-center text-xs">
                  No published workflows to choose from yet.
                </span>
              ) : null}
            </div>
          </div>

          {subjectKind === 'agent' ? (
            <div className="space-y-2">
              <Label htmlFor="agentId">
                Agent <FieldHelp title="Agent">{runHelp.subjectAgent}</FieldHelp>
              </Label>
              {agents.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No agents available. Create an agent first.
                </p>
              ) : (
                <Select value={agentId} onValueChange={setAgentId}>
                  <SelectTrigger id="agentId">
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
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="workflowId">
                  Workflow{' '}
                  <FieldHelp title="Workflow">
                    The workflow runs once per dataset case. Each case&apos;s `input` object is
                    passed in as the workflow&apos;s variable map. Only active workflows with a
                    published version appear here.
                  </FieldHelp>
                </Label>
                <Select value={workflowId} onValueChange={setWorkflowId}>
                  <SelectTrigger id="workflowId">
                    <SelectValue placeholder="Pick a workflow" />
                  </SelectTrigger>
                  <SelectContent>
                    {workflows.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>
                  Output selector{' '}
                  <FieldHelp title="Output selector">
                    Picks which step output the graders see as the &quot;model output&quot;. Final
                    report = the last `report` step. Last step = the last completed step. Specific
                    step = pick a step by name.
                  </FieldHelp>
                </Label>
                <Select
                  value={selectorKind}
                  onValueChange={(v) => setSelectorKind(v as SelectorKind)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="final_report">Final report</SelectItem>
                    <SelectItem value="last_step">Last step output</SelectItem>
                    <SelectItem value="step_id">Specific step…</SelectItem>
                  </SelectContent>
                </Select>
                {selectorKind === 'step_id' ? (
                  chosenWorkflow && chosenWorkflow.steps.length > 0 ? (
                    <Select value={selectorStepId} onValueChange={setSelectorStepId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Pick a step" />
                      </SelectTrigger>
                      <SelectContent>
                        {chosenWorkflow.steps.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name} ({s.type})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-muted-foreground text-xs">
                      Selected workflow has no steps; pick a different output selector.
                    </p>
                  )
                ) : null}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dataset */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dataset</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {datasets.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No datasets available. Upload one first.
            </p>
          ) : (
            <>
              <Select value={datasetId} onValueChange={setDatasetId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a dataset" />
                </SelectTrigger>
                <SelectContent>
                  {datasets.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name} ({d.caseCount} cases)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {chosenDataset ? (
                <p className="text-muted-foreground text-xs">
                  Run will fire {chosenDataset.caseCount} case
                  {chosenDataset.caseCount === 1 ? '' : 's'} at the selected{' '}
                  {subjectKind === 'workflow' ? 'workflow' : 'agent'}.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/* Heuristic graders */}
      {heuristicGraders.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Heuristic graders{' '}
              <FieldHelp title="Heuristic graders">
                Deterministic checks — no LLM, no cost. Run on every case.
              </FieldHelp>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {heuristicGraders.map((g) => {
              const selected = selectedMetrics.find(
                (m) => m.kind === 'heuristic' && m.slug === g.slug
              );
              const helpText = (graderHelp as Record<string, string>)[g.slug] ?? g.description;
              return (
                <div key={g.slug} className="rounded-md border p-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id={`heuristic-${g.slug}`}
                      checked={!!selected}
                      onCheckedChange={() => toggleHeuristic(g)}
                    />
                    <div className="flex-1 space-y-1">
                      <Label htmlFor={`heuristic-${g.slug}`} className="flex items-center gap-2">
                        <span className="font-mono text-sm">{g.slug}</span>
                        {g.referenceRequired ? (
                          <Badge variant="secondary" className="text-[10px]">
                            needs expectedOutput
                          </Badge>
                        ) : null}
                        <FieldHelp title={g.slug}>{helpText}</FieldHelp>
                      </Label>
                      <p className="text-muted-foreground text-xs">{g.description}</p>

                      {selected && selected.kind === 'heuristic' && g.slug === 'regex' ? (
                        <ConfigEditor
                          config={selected.config}
                          fields={[
                            {
                              key: 'pattern',
                              label: 'Pattern (regex)',
                              placeholder: '\\d{4}-\\d{2}-\\d{2}',
                            },
                            { key: 'flags', label: 'Flags', placeholder: 'i, m, s …' },
                          ]}
                          onPatch={(patch) => updateHeuristicConfig(g.slug, patch)}
                        />
                      ) : null}
                      {selected && selected.kind === 'heuristic' && g.slug === 'length_between' ? (
                        <ConfigEditor
                          config={selected.config}
                          fields={[
                            { key: 'min', label: 'Min chars', type: 'number' },
                            { key: 'max', label: 'Max chars', type: 'number' },
                          ]}
                          onPatch={(patch) => updateHeuristicConfig(g.slug, patch)}
                        />
                      ) : null}
                      {selected && selected.kind === 'heuristic' && g.slug === 'tool_was_called' ? (
                        <ConfigEditor
                          config={selected.config}
                          fields={[
                            // Agent subject + ≥1 bound capability → dropdown.
                            // Workflow subject or no capabilities → free text
                            // (e.g. the agent has none bound yet, or the tool
                            // is one bound at a step level inside a workflow).
                            subjectKind === 'agent' && agentCapabilities.length > 0
                              ? {
                                  key: 'slug',
                                  label: 'Tool slug',
                                  type: 'select' as const,
                                  options: agentCapabilities.map((c) => ({
                                    value: c.slug,
                                    label: `${c.name} — ${c.slug}`,
                                  })),
                                  placeholder: 'Pick a tool the agent has bound',
                                  selectHint:
                                    'Lists capabilities currently attached to this agent.',
                                }
                              : {
                                  key: 'slug',
                                  label: 'Tool slug',
                                  placeholder: 'search_knowledge_base',
                                },
                            { key: 'min', label: 'Min invocations', type: 'number' },
                          ]}
                          onPatch={(patch) => updateHeuristicConfig(g.slug, patch)}
                        />
                      ) : null}
                      {selected &&
                      selected.kind === 'heuristic' &&
                      g.slug === 'citation_count_at_least' ? (
                        <ConfigEditor
                          config={selected.config}
                          fields={[{ key: 'min', label: 'Minimum citations', type: 'number' }]}
                          onPatch={(patch) => updateHeuristicConfig(g.slug, patch)}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {/* Judge agents */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" aria-hidden />
              Judge agents
              <FieldHelp title="Judge agents">
                Every model-graded metric is an Agent with kind=&quot;judge&quot;. Pick one or more
                — each judge fires one LLM call per case and scores via the judge&apos;s system
                instructions (the rubric). Built-in judges ship with tight rubrics; create custom
                judges for domain-specific scoring.
              </FieldHelp>
            </span>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/orchestration/agents/new?kind=judge">
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
                Create custom judge
              </Link>
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {builtInJudges.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                Built-in
              </h4>
              {builtInJudges.map((j) => (
                <JudgeRow
                  key={j.id}
                  judge={j}
                  selected={selectedMetrics.some(
                    (m) => m.kind === 'judge' && m.agentSlug === j.slug
                  )}
                  onToggle={() => toggleJudge(j.slug)}
                />
              ))}
            </div>
          ) : null}
          {customJudges.length > 0 ? (
            <div className="space-y-2">
              <h4 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                Custom
              </h4>
              {customJudges.map((j) => (
                <JudgeRow
                  key={j.id}
                  judge={j}
                  selected={selectedMetrics.some(
                    (m) => m.kind === 'judge' && m.agentSlug === j.slug
                  )}
                  onToggle={() => toggleJudge(j.slug)}
                />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              No custom judges yet. Click &quot;Create custom judge&quot; to build a domain-specific
              scorer (e.g. policy compliance, refund eligibility).
            </p>
          )}
        </CardContent>
      </Card>

      {error ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      ) : null}

      <CostEstimateBanner estimate={estimate} />

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          <strong>{heuristicCount}</strong> heuristic, <strong>{judgeCount}</strong> judge agent
          {judgeCount === 1 ? '' : 's'} selected. Dataset:{' '}
          <strong>{chosenDataset?.caseCount ?? 0}</strong> cases. Judge cost is metered per case on
          the judge agent itself — see costs on each judge&apos;s page.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.back()}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting || selectedMetrics.length === 0}>
            {isSubmitting ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Play className="mr-1.5 h-4 w-4" aria-hidden />
            )}
            Queue run
          </Button>
        </div>
      </div>
    </form>
  );
}

// ─── Per-judge row ──────────────────────────────────────────────────────────

function JudgeRow({
  judge,
  selected,
  onToggle,
}: {
  judge: JudgeAgentOption;
  selected: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start gap-3">
        <Checkbox id={`judge-${judge.slug}`} checked={selected} onCheckedChange={onToggle} />
        <div className="flex-1 space-y-1">
          <Label htmlFor={`judge-${judge.slug}`} className="flex items-center gap-2">
            <span className="font-medium">{judge.name}</span>
            <span className="text-muted-foreground font-mono text-[10px]">{judge.slug}</span>
            {judge.isSystem ? (
              <Badge variant="outline" className="text-[10px]">
                built-in
              </Badge>
            ) : null}
            {judge.model ? (
              <Badge variant="secondary" className="text-[10px]">
                {judge.model}
              </Badge>
            ) : null}
            <Link
              href={`/admin/orchestration/agents/${judge.id}`}
              target="_blank"
              className="text-muted-foreground hover:text-foreground ml-1 text-xs underline-offset-4 hover:underline"
              title="Edit this judge's rubric"
            >
              <Edit3 className="inline h-3 w-3" aria-hidden /> edit
            </Link>
          </Label>
          {judge.description ? (
            <p className="text-muted-foreground text-xs">{judge.description}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Generic config editor for heuristic graders ───────────────────────────

interface ConfigField {
  key: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'select';
  /** Required when `type: 'select'`. Empty list falls back to a text input. */
  options?: Array<{ value: string; label: string }>;
  /** Hint shown under a select when present. */
  selectHint?: string;
}

/**
 * Coerce an arbitrary config value to a safe display string. Heuristic
 * graders store strings/numbers in config, so this is straightforward
 * — but Zod's `unknown` typing here forces the no-base-to-string lint
 * unless we narrow.
 */
function stringifyConfigValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

// ─── Cost estimate hook + banner ───────────────────────────────────────────

interface EvaluationCostEstimateModel {
  modelId: string;
  role: 'subject' | 'judge';
  judgeAgentSlug?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  pricingKnown: boolean;
}

interface EvaluationCostEstimate {
  midUsd: number;
  lowUsd: number;
  highUsd: number;
  basedOn: 'empirical' | 'heuristic';
  sampleSize: number;
  caseCount: number;
  modelMix: EvaluationCostEstimateModel[];
  notes: string;
}

interface EstimateState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  data?: EvaluationCostEstimate;
  error?: string;
}

const ESTIMATE_DEBOUNCE_MS = 350;

/**
 * Debounced cost-estimate fetch keyed on `(agentId, datasetId, judge slugs)`.
 * Heuristic graders don't affect the estimate (they're free), so we
 * intentionally exclude them from the dependency key — re-fetching when
 * the user toggles a heuristic checkbox would burn requests for no UI
 * change.
 */
function useEvaluationCostEstimate(args: {
  subjectKind: SubjectKind;
  agentId: string;
  workflowId: string;
  datasetId: string;
  selectedMetrics: MetricSelection[];
}): EstimateState {
  const [state, setState] = React.useState<EstimateState>({ status: 'idle' });

  const judgeSlugs = React.useMemo(
    () =>
      args.selectedMetrics
        .filter((m): m is Extract<MetricSelection, { kind: 'judge' }> => m.kind === 'judge')
        .map((m) => m.agentSlug)
        .sort(),
    [args.selectedMetrics]
  );
  const judgeKey = judgeSlugs.join(',');

  React.useEffect(() => {
    // Need a subject (matching the chosen kind) + dataset before there's
    // anything to estimate.
    if (!args.datasetId) {
      setState({ status: 'idle' });
      return;
    }
    if (args.subjectKind === 'agent' && !args.agentId) {
      setState({ status: 'idle' });
      return;
    }
    if (args.subjectKind === 'workflow' && !args.workflowId) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState((prev) => ({ status: 'loading', data: prev.data }));
      void fetch(API.ADMIN.ORCHESTRATION.EVAL_RUN_ESTIMATE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectKind: args.subjectKind,
          ...(args.subjectKind === 'agent' ? { agentId: args.agentId } : {}),
          ...(args.subjectKind === 'workflow' ? { workflowId: args.workflowId } : {}),
          datasetId: args.datasetId,
          judgeAgentSlugs: judgeSlugs,
        }),
        signal: controller.signal,
      })
        .then(async (res) => {
          const payload = (await res.json()) as
            | { success: true; data: EvaluationCostEstimate }
            | { success: false; error: { message: string } };
          if (!res.ok || !payload.success) {
            const message = !payload.success ? payload.error.message : `Failed (${res.status})`;
            setState({ status: 'error', error: message });
            return;
          }
          // Defensive shape check — drop the banner cleanly when a test
          // (or a misbehaving route) returns success: true with the
          // wrong payload. Avoids a runtime crash on the unknown-pricing
          // check below.
          const data = payload.data;
          if (!data || typeof data.midUsd !== 'number' || !Array.isArray(data.modelMix)) {
            setState({ status: 'idle' });
            return;
          }
          setState({ status: 'ok', data });
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setState({
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, ESTIMATE_DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // judgeSlugs is captured via judgeKey; including the array directly
    // would re-fire on every selectedMetrics change even when the judge
    // set is identical.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.subjectKind, args.agentId, args.workflowId, args.datasetId, judgeKey]);

  return state;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '$0.00';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `<$0.01`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function CostEstimateBanner({ estimate }: { estimate: EstimateState }): React.ReactElement | null {
  if (estimate.status === 'idle') return null;
  if (estimate.status === 'error') {
    return (
      <div className="text-muted-foreground border-muted-foreground/30 rounded-md border border-dashed bg-transparent p-3 text-xs">
        Cost estimate unavailable: {estimate.error}.
      </div>
    );
  }
  const data = estimate.data;
  const isLoading = estimate.status === 'loading';
  if (!data) {
    return (
      <div className="text-muted-foreground rounded-md border p-3 text-xs">
        <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden />
        Estimating cost…
      </div>
    );
  }

  const anyUnknownPricing = data.modelMix.some((m) => !m.pricingKnown);

  return (
    <div className="bg-muted/30 space-y-1 rounded-md border p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-foreground font-medium">
          Estimated cost: {formatUsd(data.midUsd)}
        </span>
        <span className="text-muted-foreground">
          (range {formatUsd(data.lowUsd)} – {formatUsd(data.highUsd)})
        </span>
        <Badge
          variant={data.basedOn === 'empirical' ? 'default' : 'secondary'}
          className="text-[10px]"
        >
          {data.basedOn === 'empirical' ? `empirical · ${data.sampleSize} past runs` : 'heuristic'}
        </Badge>
        <FieldHelp title="Cost estimate">{runHelp.totalCostEstimate}</FieldHelp>
        {isLoading ? (
          <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" aria-hidden />
        ) : null}
      </div>
      <p className="text-muted-foreground">{data.notes}</p>
      {anyUnknownPricing ? (
        <p className="text-amber-700 dark:text-amber-500">
          One or more models in the mix have no pricing data — the total is missing a slice.{' '}
          <FieldHelp title="Pricing unknown">{runHelp.costEstimateUnknownPricing}</FieldHelp>
        </p>
      ) : null}
    </div>
  );
}

function ConfigEditor({
  config,
  fields,
  onPatch,
}: {
  config: Record<string, unknown>;
  fields: ConfigField[];
  onPatch: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div className="bg-muted/40 mt-2 grid grid-cols-2 gap-2 rounded p-3">
      {fields.map((f) => {
        const renderSelect = f.type === 'select' && f.options && f.options.length > 0;
        const currentValue = stringifyConfigValue(config[f.key]);
        return (
          <div key={f.key} className={`space-y-1 ${fields.length === 1 ? 'col-span-2' : ''}`}>
            <Label className="text-xs">{f.label}</Label>
            {renderSelect ? (
              <>
                <Select value={currentValue} onValueChange={(v) => onPatch({ [f.key]: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder={f.placeholder ?? 'Pick one'} />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options?.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {f.selectHint ? (
                  <p className="text-muted-foreground text-[10px]">{f.selectHint}</p>
                ) : null}
              </>
            ) : (
              <Input
                type={f.type === 'number' ? 'number' : 'text'}
                value={currentValue}
                placeholder={f.placeholder}
                onChange={(e) =>
                  onPatch({
                    [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value,
                  })
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
