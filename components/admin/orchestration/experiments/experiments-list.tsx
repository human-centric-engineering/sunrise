'use client';

/**
 * ExperimentsList
 *
 * Client component that displays A/B experiments with status badges,
 * variant counts, action buttons, and an inline create form.
 */

import * as React from 'react';
import { CheckCircle, Loader2, Play, Plus, Trash2, X } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient, APIClientError } from '@/lib/api/client';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Variant {
  id: string;
  label: string;
  score: number | null;
}

interface Experiment {
  id: string;
  name: string;
  description: string | null;
  status: string;
  agentId: string;
  agent: { id: string; name: string; slug: string };
  variants: Variant[];
  creator: { id: string; name: string | null };
  createdAt: string;
}

interface Agent {
  id: string;
  name: string;
  slug: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ENDPOINT = '/api/v1/admin/orchestration/experiments';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  draft: 'secondary',
  running: 'default',
  completed: 'default',
};

// ─── Create Form ────────────────────────────────────────────────────────────

function CreateExperimentForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = React.useState(true);
  const [agentFetchError, setAgentFetchError] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [agentId, setAgentId] = React.useState('');
  const [variants, setVariants] = React.useState([{ label: 'Variant A' }, { label: 'Variant B' }]);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    async function loadAgents(): Promise<void> {
      try {
        const data = await apiClient.get<Agent[]>('/api/v1/admin/orchestration/agents?limit=100');
        setAgents(data);
      } catch {
        setAgents([]);
        setAgentFetchError(true);
      } finally {
        setLoadingAgents(false);
      }
    }
    void loadAgents();
  }, []);

  function addVariant(): void {
    if (variants.length >= 5) return;
    const letters = ['A', 'B', 'C', 'D', 'E'];
    setVariants((prev) => [
      ...prev,
      { label: `Variant ${letters[prev.length] ?? prev.length + 1}` },
    ]);
  }

  function removeVariant(index: number): void {
    if (variants.length <= 2) return;
    setVariants((prev) => prev.filter((_, i) => i !== index));
  }

  function updateVariantLabel(index: number, label: string): void {
    setVariants((prev) => prev.map((v, i) => (i === index ? { label } : v)));
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || !agentId) return;

    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post(ENDPOINT, {
        body: {
          name: name.trim(),
          description: description.trim() || undefined,
          agentId,
          variants,
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to create experiment');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New Experiment</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="exp-name">
              Name{' '}
              <FieldHelp title="Experiment name">
                <p>A short, descriptive name so you can identify this experiment later.</p>
                <p>Example: &ldquo;Formal vs casual tone for support agent&rdquo;</p>
              </FieldHelp>
            </Label>
            <Input
              id="exp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Formal vs casual tone"
              maxLength={200}
              required
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="exp-desc">
              Description{' '}
              <FieldHelp title="Experiment description">
                <p>Optional context about what you&apos;re testing and what outcome you expect.</p>
              </FieldHelp>
            </Label>
            <Input
              id="exp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What are you trying to learn?"
              maxLength={2000}
            />
          </div>

          {/* Agent */}
          <div className="space-y-1.5">
            <Label>
              Agent{' '}
              <FieldHelp title="Target agent" contentClassName="w-72">
                <p>
                  The agent you want to experiment on. Each variant will be tested against this
                  agent&apos;s evaluation criteria. You must have at least one agent configured
                  before creating an experiment.
                </p>
              </FieldHelp>
            </Label>
            {loadingAgents ? (
              <p className="text-muted-foreground text-xs">Loading agents...</p>
            ) : agentFetchError ? (
              <p className="text-xs text-red-600">Failed to load agents. Please try again.</p>
            ) : agents.length === 0 ? (
              <p className="text-xs text-amber-600">
                No agents found. Create an agent first under Build &rarr; Agents.
              </p>
            ) : (
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an agent" />
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

          {/* Variants */}
          <div className="space-y-2">
            <Label>
              Variants{' '}
              <FieldHelp title="Experiment variants" contentClassName="w-80">
                <p>
                  Each variant represents a different prompt or configuration you want to compare.
                  Give each a descriptive label (e.g. &ldquo;Concise instructions&rdquo; vs
                  &ldquo;Detailed instructions&rdquo;).
                </p>
                <p className="mt-1">You need at least 2 variants, up to 5.</p>
              </FieldHelp>
            </Label>
            <div className="space-y-2">
              {variants.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={v.label}
                    onChange={(e) => updateVariantLabel(i, e.target.value)}
                    placeholder={`Variant ${i + 1} label`}
                    maxLength={100}
                    required
                  />
                  {variants.length > 2 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => removeVariant(i)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {variants.length < 5 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={addVariant}
                className="gap-1"
              >
                <Plus className="h-3.5 w-3.5" />
                Add variant
              </Button>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2">
            <Button
              type="submit"
              disabled={submitting || !name.trim() || !agentId}
              className="gap-2"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Experiment
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Main List ──────────────────────────────────────────────────────────────

export function ExperimentsList(): React.ReactElement {
  const [experiments, setExperiments] = React.useState<Experiment[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [runningId, setRunningId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [completingId, setCompletingId] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Experiment | null>(null);

  const fetchExperiments = React.useCallback(async () => {
    try {
      const data = await apiClient.get<Experiment[]>(ENDPOINT);
      setExperiments(data);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to load experiments');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchExperiments();
  }, [fetchExperiments]);

  async function handleRun(id: string): Promise<void> {
    setError(null);
    setRunningId(id);
    try {
      await apiClient.post(`${ENDPOINT}/${id}/run`);
      await fetchExperiments();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to start experiment');
    } finally {
      setRunningId(null);
    }
  }

  async function handleComplete(id: string): Promise<void> {
    setError(null);
    setCompletingId(id);
    try {
      await apiClient.patch(`${ENDPOINT}/${id}`, { body: { status: 'completed' } });
      await fetchExperiments();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to complete experiment');
    } finally {
      setCompletingId(null);
    }
  }

  async function handleDelete(id: string): Promise<void> {
    setError(null);
    setDeletingId(id);
    try {
      await apiClient.delete(`${ENDPOINT}/${id}`);
      setExperiments((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Failed to delete experiment');
    } finally {
      setDeletingId(null);
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return <p className="text-muted-foreground text-sm">Loading experiments...</p>;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Create form or button */}
      {showCreate ? (
        <CreateExperimentForm
          onCreated={() => {
            setShowCreate(false);
            void fetchExperiments();
          }}
          onCancel={() => setShowCreate(false)}
        />
      ) : (
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          New Experiment
        </Button>
      )}

      {/* Experiment table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Tip label="The experiment name — describes what you're testing">
                  <span>Name</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="The agent being tested in this experiment">
                  <span>Agent</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Draft → Running → Completed">
                  <span>Status</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Number of prompt variants being compared (2–5)">
                  <span>Variants</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="When this experiment was created">
                  <span>Created</span>
                </Tip>
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {experiments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground h-24 text-center">
                  {loading ? 'Loading\u2026' : 'No experiments found.'}
                </TableCell>
              </TableRow>
            ) : (
              experiments.map((exp) => (
                <TableRow key={exp.id}>
                  <TableCell>
                    <div className="font-medium">{exp.name}</div>
                    {exp.description && (
                      <p className="text-muted-foreground mt-0.5 text-xs">{exp.description}</p>
                    )}
                    {exp.status === 'completed' && (
                      <div className="mt-1 flex gap-3">
                        {exp.variants.map((v) => (
                          <span key={v.id} className="text-xs">
                            <span className="font-medium">{v.label}:</span>{' '}
                            {v.score !== null ? v.score.toFixed(2) : 'N/A'}
                          </span>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{exp.agent.name}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[exp.status] ?? 'secondary'}>{exp.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{exp.variants.length}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(exp.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {exp.status === 'draft' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={runningId === exp.id}
                          onClick={() => void handleRun(exp.id)}
                        >
                          {runningId === exp.id ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="mr-1 h-3 w-3" />
                          )}
                          Run
                        </Button>
                      )}
                      {exp.status === 'running' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={completingId === exp.id}
                          onClick={() => void handleComplete(exp.id)}
                        >
                          {completingId === exp.id ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle className="mr-1 h-3 w-3" />
                          )}
                          Complete
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Delete experiment"
                        disabled={deletingId === exp.id}
                        onClick={() => setDeleteTarget(exp)}
                      >
                        {deletingId === exp.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete experiment</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This will
              permanently remove the experiment and all its variants.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && void handleDelete(deleteTarget.id)}
              className="bg-red-600 hover:bg-red-700"
              disabled={!!deletingId}
            >
              {deletingId ? 'Deleting\u2026' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
