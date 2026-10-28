'use client';

/**
 * GenerateFromDescriptionForm — cold-start dataset creation flow.
 *
 * The admin describes their agent's domain in 1–3 sentences, optionally
 * supplies up to 3 anchor inputs, and clicks Generate. The preview
 * endpoint returns proposed cases; the admin reviews/unticks; clicks
 * Save → the commit endpoint creates a new AiDataset + writes the
 * accepted cases atomically.
 *
 * No dataset is created at preview time — the operator can cancel
 * out of the review without leaving a half-finished row behind.
 *
 * Companion to GenerateCasesButton (per-dataset modal). This form sits
 * on /admin/orchestration/evaluations/datasets/new under a Tabs
 * control alongside the upload form. They share the review-step
 * component so the two flows feel uniform.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  CaseReviewStep,
  type PreviewResult,
  type ProposedCase,
} from '@/components/admin/orchestration/evaluations-foundations/case-review-step';
import { datasetHelp } from '@/components/admin/orchestration/evaluations-foundations/help-text';
import { SaveError } from '@/components/forms/form-error';
import { APIClientError, apiErrorFromResponse } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

export interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

interface GenerateFromDescriptionFormProps {
  agents: AgentOption[];
}

type ApiSuccess<T> = { success: true; data: T };
type ApiError = { success: false; error: { message: string } };

type Step = 'configure' | 'review';

interface CommitResult {
  datasetId: string;
  caseCount: number;
  contentHash: string;
  warnings: string[];
}

const MIN_DOMAIN_CHARS = 20;
const MAX_DOMAIN_CHARS = 1000;
const MAX_SEED_INPUTS = 3;

export function GenerateFromDescriptionForm({
  agents,
}: GenerateFromDescriptionFormProps): React.ReactElement {
  const router = useRouter();
  const [step, setStep] = React.useState<Step>('configure');

  const [agentId, setAgentId] = React.useState<string>(agents[0]?.id ?? '');
  const [domainPrompt, setDomainPrompt] = React.useState('');
  const [count, setCount] = React.useState<number>(10);
  const [seedInputs, setSeedInputs] = React.useState<string[]>([]);
  const [seedDraft, setSeedDraft] = React.useState('');

  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');

  const [generating, setGenerating] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  // A failed generate (an LLM preview, nothing saved) keeps its own box.
  const [error, setError] = React.useState<string | null>(null);
  // A refused save of the dataset: directly above its Save button (§124).
  const commitSave = useSaveFailure({
    fallback: 'Could not save the dataset. Try again in a moment.',
    fields: NO_SERVER_FIELDS,
  });
  const [preview, setPreview] = React.useState<PreviewResult | null>(null);
  const [selectedIndices, setSelectedIndices] = React.useState<Set<number>>(new Set());

  function addSeed(): void {
    const trimmed = seedDraft.trim();
    if (!trimmed) return;
    if (seedInputs.length >= MAX_SEED_INPUTS) return;
    setSeedInputs((prev) => [...prev, trimmed]);
    setSeedDraft('');
  }

  function removeSeed(i: number): void {
    setSeedInputs((prev) => prev.filter((_, idx) => idx !== i));
  }

  function toggleSelected(i: number): void {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function handleEdit(
    i: number,
    patch: Partial<Pick<ProposedCase, 'input' | 'expectedOutput'>>
  ): void {
    setPreview((prev) => {
      if (!prev) return prev;
      const nextCases = prev.cases.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
      return { ...prev, cases: nextCases };
    });
  }

  async function handleGenerate(): Promise<void> {
    if (!agentId) {
      setError('Pick a subject agent first.');
      return;
    }
    const prompt = domainPrompt.trim();
    if (prompt.length < MIN_DOMAIN_CHARS) {
      setError(`Domain description must be at least ${MIN_DOMAIN_CHARS} characters.`);
      return;
    }

    setGenerating(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { agentId, count, domainPrompt: prompt };
      if (seedInputs.length > 0) body.seedInputs = seedInputs;

      const res = await fetch(API.ADMIN.ORCHESTRATION.EVAL_DATASETS_GENERATE_FROM_DESCRIPTION, {
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
      // Default to all-selected; admin unticks anything wrong.
      setSelectedIndices(new Set(payload.data.cases.map((_, i) => i)));
      // Seed the dataset name from the agent name so the operator doesn't
      // have to invent one. They can edit on the review step.
      if (!name) {
        const agent = agents.find((a) => a.id === agentId);
        const today = new Date().toISOString().slice(0, 10);
        if (agent) setName(`${agent.name} — synthetic ${today}`);
      }
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleCommit(): Promise<void> {
    if (!preview) return;
    commitSave.clear();
    const accepted = preview.cases.filter((_, i) => selectedIndices.has(i));
    if (accepted.length === 0) {
      commitSave.show('Select at least one case to save.');
      return;
    }
    if (!name.trim()) {
      commitSave.show('Give the dataset a name before saving.');
      return;
    }
    setCommitting(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        cases: accepted,
      };
      if (description.trim()) body.description = description.trim();

      const res = await fetch(
        API.ADMIN.ORCHESTRATION.EVAL_DATASETS_GENERATE_FROM_DESCRIPTION_COMMIT,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) throw await apiErrorFromResponse(res);
      const payload = await parseApiResponse<CommitResult>(res);
      if (!payload.success) {
        throw new APIClientError(
          payload.error.message,
          payload.error.code,
          res.status,
          payload.error.details
        );
      }
      router.push(`/admin/orchestration/evaluations/datasets/${payload.data.datasetId}`);
    } catch (err) {
      commitSave.report(err);
    } finally {
      setCommitting(false);
    }
  }

  const seedSlotsRemaining = MAX_SEED_INPUTS - seedInputs.length;

  if (step === 'review') {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Review proposed cases</CardTitle>
          </CardHeader>
          <CardContent>
            <CaseReviewStep
              preview={preview}
              selectedIndices={selectedIndices}
              toggleSelected={toggleSelected}
              onEdit={handleEdit}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Name this dataset</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="gen-name">
                Name <FieldHelp title="Name">{datasetHelp.name}</FieldHelp>
              </Label>
              <Input
                id="gen-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gen-description">
                Description <FieldHelp title="Description">{datasetHelp.description}</FieldHelp>
              </Label>
              <Textarea
                id="gen-description"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
              />
            </div>
          </CardContent>
        </Card>

        <SaveError failure={commitSave.failure} />

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setStep('configure');
              setError(null);
              commitSave.clear();
            }}
            disabled={committing}
          >
            Back
          </Button>
          <Button
            onClick={() => void handleCommit()}
            disabled={committing || selectedIndices.size === 0 || !name.trim()}
          >
            {committing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : null}
            Save {selectedIndices.size} case{selectedIndices.size === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Describe the agent</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">{datasetHelp.generateFromDescription}</p>

          <div className="space-y-2">
            <Label htmlFor="gen-agent">Subject agent</Label>
            {agents.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No chat agents available. Create one before generating cases.
              </p>
            ) : (
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger id="gen-agent">
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
              The agent the dataset will be fired at. Generated cases are tailored to its domain.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="gen-domain">
              Domain description{' '}
              <FieldHelp title="Domain description">{datasetHelp.domainPrompt}</FieldHelp>
            </Label>
            <Textarea
              id="gen-domain"
              rows={4}
              placeholder="e.g. Customer support agent for a fintech card issuer. Handles disputes, declines, fees, refunds."
              value={domainPrompt}
              onChange={(e) => setDomainPrompt(e.target.value)}
              minLength={MIN_DOMAIN_CHARS}
              maxLength={MAX_DOMAIN_CHARS}
            />
            <p className="text-muted-foreground text-xs">
              {domainPrompt.length} / {MAX_DOMAIN_CHARS} characters (min {MIN_DOMAIN_CHARS}).
            </p>
          </div>

          <div className="space-y-2">
            <Label>
              Anchor inputs (optional){' '}
              <FieldHelp title="Anchor inputs">{datasetHelp.seedInputs}</FieldHelp>
            </Label>
            <div className="space-y-2">
              {seedInputs.map((s, i) => (
                <div key={i} className="bg-muted/40 flex items-start gap-2 rounded-md p-2">
                  <p className="flex-1 text-sm">{s}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeSeed(i)}
                    aria-label={`Remove anchor input ${i + 1}`}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
            {seedSlotsRemaining > 0 ? (
              <div className="flex gap-2">
                <Input
                  value={seedDraft}
                  onChange={(e) => setSeedDraft(e.target.value)}
                  placeholder="e.g. My card was declined at checkout"
                  maxLength={2000}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSeed();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={addSeed}
                  disabled={seedDraft.trim().length === 0}
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden />
                  Add
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                Maximum of {MAX_SEED_INPUTS} anchor inputs reached.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="gen-count">How many cases?</Label>
            <Input
              id="gen-count"
              type="number"
              min={1}
              max={25}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
            />
            <p className="text-muted-foreground text-xs">Up to 25 per request.</p>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button
          onClick={() => void handleGenerate()}
          disabled={
            generating ||
            agents.length === 0 ||
            !agentId ||
            domainPrompt.trim().length < MIN_DOMAIN_CHARS
          }
        >
          {generating ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />
          )}
          Generate cases
        </Button>
      </div>
    </div>
  );
}
