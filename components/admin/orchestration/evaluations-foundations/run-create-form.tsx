'use client';

/**
 * RunCreateForm — single-page form for queueing a batch evaluation run.
 *
 * Five logical sections (Subject → Dataset → Metrics → Judge → Review)
 * laid out top to bottom, no multi-step wizard. The user fills in the
 * form linearly; submit POSTs to /api/v1/admin/orchestration/evaluations/runs
 * which queues the run for the maintenance-tick worker.
 *
 * Phase 1 ships agent-only subjects; the schema is workflow-ready but
 * the UI omits workflow until Phase 3.
 *
 * FieldHelp on every non-trivial field. Tone strings pulled from
 * help-text.ts so the wording stays auditable in one place.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Play } from 'lucide-react';

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

export interface DatasetOption {
  id: string;
  name: string;
  caseCount: number;
}

export interface GraderOption {
  slug: string;
  family: 'heuristic' | 'model' | 'pairwise';
  description: string;
  referenceRequired: boolean;
  defaultConfig: unknown;
}

interface RunCreateFormProps {
  agents: AgentOption[];
  datasets: DatasetOption[];
  graders: GraderOption[];
}

// ─── Local state types ──────────────────────────────────────────────────────

interface CustomRubricConfig {
  prompt: string;
  scaleMin: number;
  scaleMax: number;
  passThreshold?: number;
}

interface MetricSelection {
  slug: string;
  config: Record<string, unknown>;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function RunCreateForm({
  agents,
  datasets,
  graders,
}: RunCreateFormProps): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefilledDatasetId = searchParams.get('datasetId') ?? '';

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [agentId, setAgentId] = React.useState(agents[0]?.id ?? '');
  const [datasetId, setDatasetId] = React.useState(prefilledDatasetId || datasets[0]?.id || '');
  const [selectedMetrics, setSelectedMetrics] = React.useState<MetricSelection[]>([]);
  const [judgeOverride, setJudgeOverride] = React.useState(false);
  const [judgeProvider, setJudgeProvider] = React.useState('');
  const [judgeModel, setJudgeModel] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const chosenDataset = datasets.find((d) => d.id === datasetId) ?? null;

  function toggleMetric(slug: string, defaultConfig: unknown): void {
    setSelectedMetrics((prev) => {
      const existing = prev.find((m) => m.slug === slug);
      if (existing) {
        return prev.filter((m) => m.slug !== slug);
      }
      const config =
        defaultConfig && typeof defaultConfig === 'object'
          ? { ...(defaultConfig as Record<string, unknown>) }
          : {};
      return [...prev, { slug, config }];
    });
  }

  function updateMetricConfig(slug: string, patch: Record<string, unknown>): void {
    setSelectedMetrics((prev) =>
      prev.map((m) => (m.slug === slug ? { ...m, config: { ...m.config, ...patch } } : m))
    );
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError('Give the run a name.');
    if (!agentId) return setError('Pick an agent.');
    if (!datasetId) return setError('Pick a dataset.');
    if (selectedMetrics.length === 0) return setError('Pick at least one metric.');

    setIsSubmitting(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.EVAL_RUNS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          subjectKind: 'agent',
          agentId,
          datasetId,
          metricConfigs: selectedMetrics,
          ...(judgeOverride && judgeProvider && judgeModel ? { judgeProvider, judgeModel } : {}),
        }),
      });
      const payload = (await res.json()) as
        | { success: true; data: { id: string } }
        | { success: false; error: { message: string } };
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
                  Run will fire {chosenDataset.caseCount} cases at the selected agent.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/* Metrics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Metrics <FieldHelp title="Metrics">{runHelp.metricsPicker}</FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {graders.map((g) => {
            const selected = selectedMetrics.find((m) => m.slug === g.slug);
            const helpText = (graderHelp as Record<string, string>)[g.slug] ?? g.description;
            return (
              <div key={g.slug} className="rounded-md border p-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id={`metric-${g.slug}`}
                    checked={!!selected}
                    onCheckedChange={() => toggleMetric(g.slug, g.defaultConfig)}
                  />
                  <div className="flex-1 space-y-1">
                    <Label htmlFor={`metric-${g.slug}`} className="flex items-center gap-2">
                      <span className="font-mono text-sm">{g.slug}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {g.family}
                      </Badge>
                      {g.referenceRequired ? (
                        <Badge variant="secondary" className="text-[10px]">
                          needs expectedOutput
                        </Badge>
                      ) : null}
                      <FieldHelp title={g.slug}>{helpText}</FieldHelp>
                    </Label>
                    <p className="text-muted-foreground text-xs">{g.description}</p>

                    {selected && g.slug === 'custom_rubric' ? (
                      <CustomRubricEditor
                        config={selected.config as unknown as CustomRubricConfig}
                        onPatch={(patch) => updateMetricConfig(g.slug, patch)}
                      />
                    ) : null}
                    {selected && g.slug === 'regex' ? (
                      <RegexEditor
                        config={selected.config}
                        onPatch={(patch) => updateMetricConfig(g.slug, patch)}
                      />
                    ) : null}
                    {selected && g.slug === 'contains' ? (
                      <ContainsEditor
                        config={selected.config}
                        onPatch={(patch) => updateMetricConfig(g.slug, patch)}
                      />
                    ) : null}
                    {selected && g.slug === 'length_between' ? (
                      <LengthBetweenEditor
                        config={selected.config}
                        onPatch={(patch) => updateMetricConfig(g.slug, patch)}
                      />
                    ) : null}
                    {selected && g.slug === 'tool_was_called' ? (
                      <ToolWasCalledEditor
                        config={selected.config}
                        onPatch={(patch) => updateMetricConfig(g.slug, patch)}
                      />
                    ) : null}
                    {selected && g.slug === 'citation_count_at_least' ? (
                      <MinEditor
                        config={selected.config}
                        label="Minimum citations"
                        onPatch={(patch) => updateMetricConfig(g.slug, patch)}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Judge override */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Judge model <FieldHelp title="Judge model">{runHelp.judgeModel}</FieldHelp>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">{runHelp.judgeOmission}</p>
          <div className="flex items-center gap-2">
            <Checkbox
              id="judgeOverride"
              checked={judgeOverride}
              onCheckedChange={(v) => setJudgeOverride(v === true)}
            />
            <Label htmlFor="judgeOverride" className="text-sm font-normal">
              Override the system default judge for this run
            </Label>
          </div>
          {judgeOverride ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="judgeProvider" className="text-xs">
                  Provider slug
                </Label>
                <Input
                  id="judgeProvider"
                  placeholder="e.g. anthropic"
                  value={judgeProvider}
                  onChange={(e) => setJudgeProvider(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="judgeModel" className="text-xs">
                  Model id
                </Label>
                <Input
                  id="judgeModel"
                  placeholder="e.g. claude-haiku-4-5-20251001"
                  value={judgeModel}
                  onChange={(e) => setJudgeModel(e.target.value)}
                />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          <FieldHelp title="Cost estimate">{runHelp.totalCostEstimate}</FieldHelp> Selected metrics:{' '}
          <strong>{selectedMetrics.length}</strong>; cases:{' '}
          <strong>{chosenDataset?.caseCount ?? 0}</strong>.
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

// ─── Per-grader inline editors ──────────────────────────────────────────────

function CustomRubricEditor({
  config,
  onPatch,
}: {
  config: CustomRubricConfig;
  onPatch: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div className="bg-muted/40 mt-2 space-y-2 rounded p-3">
      <div className="space-y-1">
        <Label className="text-xs">
          Rubric prompt <FieldHelp title="Rubric">{graderHelp.customRubricPrompt}</FieldHelp>
        </Label>
        <Textarea
          rows={3}
          value={config.prompt ?? ''}
          onChange={(e) => onPatch({ prompt: e.target.value })}
          placeholder="Describe what counts as a high vs. low score"
          maxLength={2000}
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Scale min</Label>
          <Input
            type="number"
            value={config.scaleMin ?? 1}
            onChange={(e) => onPatch({ scaleMin: Number(e.target.value) })}
            min={0}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">
            Scale max <FieldHelp title="Scale">{graderHelp.customRubricScale}</FieldHelp>
          </Label>
          <Input
            type="number"
            value={config.scaleMax ?? 5}
            onChange={(e) => onPatch({ scaleMax: Number(e.target.value) })}
            min={1}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">
            Pass threshold{' '}
            <FieldHelp title="Threshold">{graderHelp.customRubricThreshold}</FieldHelp>
          </Label>
          <Input
            type="number"
            value={config.passThreshold ?? ''}
            onChange={(e) =>
              onPatch({
                passThreshold: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            placeholder="optional"
          />
        </div>
      </div>
    </div>
  );
}

function RegexEditor({
  config,
  onPatch,
}: {
  config: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div className="bg-muted/40 mt-2 grid grid-cols-2 gap-2 rounded p-3">
      <div className="col-span-2 space-y-1">
        <Label className="text-xs">Pattern (regex)</Label>
        <Input
          value={(config.pattern as string) ?? ''}
          onChange={(e) => onPatch({ pattern: e.target.value })}
          placeholder="e.g. \\d{4}-\\d{2}-\\d{2}"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Flags</Label>
        <Input
          value={(config.flags as string) ?? ''}
          onChange={(e) => onPatch({ flags: e.target.value })}
          placeholder="i, m, s, …"
        />
      </div>
    </div>
  );
}

function ContainsEditor({
  config,
  onPatch,
}: {
  config: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div className="bg-muted/40 mt-2 flex items-center gap-2 rounded p-3 text-xs">
      <Checkbox
        id="contains-case"
        checked={config.caseInsensitive !== false}
        onCheckedChange={(v) => onPatch({ caseInsensitive: v === true })}
      />
      <Label htmlFor="contains-case" className="text-xs font-normal">
        Case-insensitive
      </Label>
    </div>
  );
}

function LengthBetweenEditor({
  config,
  onPatch,
}: {
  config: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div className="bg-muted/40 mt-2 grid grid-cols-2 gap-2 rounded p-3">
      <div className="space-y-1">
        <Label className="text-xs">Minimum chars</Label>
        <Input
          type="number"
          value={(config.min as number | undefined) ?? 10}
          onChange={(e) => onPatch({ min: Number(e.target.value) })}
          min={0}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Maximum chars</Label>
        <Input
          type="number"
          value={(config.max as number | undefined) ?? 2000}
          onChange={(e) => onPatch({ max: Number(e.target.value) })}
          min={1}
        />
      </div>
    </div>
  );
}

function ToolWasCalledEditor({
  config,
  onPatch,
}: {
  config: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div className="bg-muted/40 mt-2 grid grid-cols-2 gap-2 rounded p-3">
      <div className="col-span-2 space-y-1">
        <Label className="text-xs">Tool / capability slug</Label>
        <Input
          value={(config.slug as string) ?? ''}
          onChange={(e) => onPatch({ slug: e.target.value })}
          placeholder="e.g. search_knowledge_base"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Minimum invocations</Label>
        <Input
          type="number"
          value={(config.min as number | undefined) ?? 1}
          onChange={(e) => onPatch({ min: Number(e.target.value) })}
          min={1}
        />
      </div>
    </div>
  );
}

function MinEditor({
  config,
  label,
  onPatch,
}: {
  config: Record<string, unknown>;
  label: string;
  onPatch: (patch: Record<string, unknown>) => void;
}): React.ReactElement {
  return (
    <div className="bg-muted/40 mt-2 grid grid-cols-2 gap-2 rounded p-3">
      <div className="space-y-1">
        <Label className="text-xs">{label}</Label>
        <Input
          type="number"
          value={(config.min as number | undefined) ?? 1}
          onChange={(e) => onPatch({ min: Number(e.target.value) })}
          min={1}
        />
      </div>
    </div>
  );
}
