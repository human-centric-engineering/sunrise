'use client';

/**
 * OrchestrationSettingsForm — configuration section on the costs page.
 *
 * Two subsections, one `<form>`, one PATCH:
 *
 *   1. Default model assignments — one `<Select>` per `TaskType`
 *      (routing / chat / reasoning / embeddings). Populated from the
 *      `/models` response; not tier-restricted (admins may deliberately
 *      override, e.g. run routing on a frontier model).
 *
 *   2. Global monthly budget cap — single numeric input. Leave blank
 *      for "no cap". Value is enforced server-side by
 *      `cost-tracker.ts#checkBudget`, which short-circuits streaming
 *      chat with a `BUDGET_EXCEEDED_GLOBAL` error when month-to-date
 *      spend across all agents meets or exceeds this value.
 *
 * Sticky action bar mirrors `agent-form.tsx`. Every non-trivial field
 * is wrapped in `<FieldHelp>` — cross-cutting Phase 4 directive.
 */

import * as React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, Check, Loader2, Save } from 'lucide-react';

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
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { TASK_TYPES, type OrchestrationSettings, type TaskType } from '@/types/orchestration';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

export interface OrchestrationSettingsFormProps {
  settings: OrchestrationSettings | null;
  models: ModelInfo[] | null;
}

// Narrower client-side schema — the server re-validates every model id
// against the registry, so we only enforce the structural parts here.
const settingsFormSchema = z.object({
  routing: z.string().min(1),
  chat: z.string().min(1),
  reasoning: z.string().min(1),
  embeddings: z.string().min(1),
  globalMonthlyBudgetUsd: z
    .union([z.literal(''), z.coerce.number().nonnegative().max(1_000_000)])
    .transform((v) => (v === '' ? null : v)),
});

type SettingsFormData = z.input<typeof settingsFormSchema>;

const TASK_LABELS: Record<TaskType, { label: string; help: React.ReactNode }> = {
  routing: {
    label: 'Routing model',
    help: (
      <>
        <p>
          Used for fast classification decisions (e.g. &ldquo;which specialist agent should handle
          this question?&rdquo;). A cheap, fast model is usually the right choice.
        </p>
        <p>
          Typical picks: <code>claude-haiku-4-5</code>, <code>gpt-4o-mini</code>, or a local
          7B-class model.
        </p>
      </>
    ),
  },
  chat: {
    label: 'Default chat model',
    help: (
      <>
        <p>
          Fallback model for agents that have not explicitly set their own model. Changing this
          immediately affects every agent using the &ldquo;use default&rdquo; option. A mid-range
          model balances cost and quality for most use cases.
        </p>
        <p>
          Typical picks: <code>claude-sonnet-4-6</code> or <code>gpt-4o</code>.
        </p>
      </>
    ),
  },
  reasoning: {
    label: 'Reasoning model',
    help: (
      <>
        <p>
          Used for multi-step reasoning tasks (tool loops, complex planning, capability
          orchestration). These tasks need the strongest reasoning, so pick the most capable (and
          typically most expensive) model your provider offers.
        </p>
        <p>
          Typical picks: <code>claude-opus-4-6</code> or <code>o1</code>-class models.
        </p>
      </>
    ),
  },
  embeddings: {
    label: 'Embeddings model',
    help: (
      <>
        <p>
          Converts text into numeric vectors so the knowledge base can find relevant documents. Used
          both when documents are uploaded (ingest) and when the agent searches (query).
        </p>
        <p>
          <strong>Important:</strong> different models produce different vectors, so if you change
          this, existing document embeddings won&apos;t match new query embeddings. After switching,
          go to the Knowledge Base page and click &ldquo;Generate Embeddings&rdquo; to re-process
          all documents.
        </p>
      </>
    ),
  },
};

export function OrchestrationSettingsForm({ settings, models }: OrchestrationSettingsFormProps) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);

  const defaults: SettingsFormData = React.useMemo(
    () => ({
      routing: settings?.defaultModels.routing ?? '',
      chat: settings?.defaultModels.chat ?? '',
      reasoning: settings?.defaultModels.reasoning ?? '',
      embeddings: settings?.defaultModels.embeddings ?? '',
      globalMonthlyBudgetUsd:
        settings?.globalMonthlyBudgetUsd === null || settings?.globalMonthlyBudgetUsd === undefined
          ? ''
          : String(settings.globalMonthlyBudgetUsd),
    }),
    [settings]
  );

  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<SettingsFormData>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: defaults,
  });

  React.useEffect(() => {
    reset(defaults);
  }, [defaults, reset]);

  const modelOptions = React.useMemo(() => models ?? [], [models]);

  const onSubmit = async (data: SettingsFormData) => {
    setSubmitting(true);
    setError(null);
    try {
      const parsed = settingsFormSchema.parse(data);
      const payload = {
        defaultModels: {
          routing: parsed.routing,
          chat: parsed.chat,
          reasoning: parsed.reasoning,
          embeddings: parsed.embeddings,
        },
        globalMonthlyBudgetUsd: parsed.globalMonthlyBudgetUsd,
      };
      await apiClient.patch<OrchestrationSettings>(API.ADMIN.ORCHESTRATION.SETTINGS, {
        body: payload,
      });
      reset(data);
      setSavedAt(new Date());
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not save settings. Try again in a moment.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
      <Card data-testid="orchestration-settings-form">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Configuration</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">
              Defaults that every new agent inherits, plus the cross-agent monthly cap.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {savedAt && !isDirty && (
              <span className="text-muted-foreground flex items-center gap-1 text-xs">
                <Check className="h-3 w-3 text-emerald-500" />
                Saved
              </span>
            )}
            <Button type="submit" size="sm" disabled={submitting || !isDirty}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save changes
                </>
              )}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {error && (
            <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <section className="space-y-4">
            <h3 className="text-sm font-semibold">Default model assignments</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              {TASK_TYPES.map((task) => (
                <div key={task} className="space-y-1.5">
                  <Label htmlFor={`model-${task}`} className="flex items-center gap-1">
                    {TASK_LABELS[task].label}
                    <FieldHelp title={TASK_LABELS[task].label}>{TASK_LABELS[task].help}</FieldHelp>
                  </Label>
                  <Controller
                    name={task}
                    control={control}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id={`model-${task}`}>
                          <SelectValue placeholder="Select a model" />
                        </SelectTrigger>
                        <SelectContent>
                          {modelOptions.length === 0 ? (
                            <SelectItem value="__none" disabled>
                              No models available
                            </SelectItem>
                          ) : (
                            modelOptions.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.name} <span className="text-muted-foreground">({m.tier})</span>
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {errors[task] && (
                    <p className="text-xs text-red-600">{errors[task]?.message as string}</p>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Global monthly budget cap</h3>
            <div className="space-y-1.5">
              <Label htmlFor="globalMonthlyBudgetUsd" className="flex items-center gap-1">
                Cap (USD)
                <FieldHelp title="Cross-agent monthly cap">
                  <p>
                    A single spending limit that covers <b>all agents combined</b>. When
                    month-to-date spend reaches this value, every agent responds with a friendly
                    &ldquo;budget exhausted&rdquo; message instead of completing the request.
                  </p>
                  <p>Leave blank for no cross-agent cap — individual per-agent caps still apply.</p>
                  <p>
                    The cap resets on the first of each month (UTC), matching the rest of the cost
                    dashboard.
                  </p>
                </FieldHelp>
              </Label>
              <Input
                id="globalMonthlyBudgetUsd"
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                placeholder="No cap"
                className="max-w-xs"
                {...register('globalMonthlyBudgetUsd')}
              />
              {errors.globalMonthlyBudgetUsd && (
                <p className="text-xs text-red-600">
                  {errors.globalMonthlyBudgetUsd.message as string}
                </p>
              )}
            </div>
          </section>
        </CardContent>
      </Card>
    </form>
  );
}
