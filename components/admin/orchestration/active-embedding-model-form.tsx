'use client';

/**
 * ActiveEmbeddingModelForm — picks the model whose dimension the
 * `ai_knowledge_chunk` and `ai_message_embedding` vector columns are
 * currently sized for.
 *
 * Distinct from the embedding slot in `DefaultModelsForm`: that slot
 * is the per-task default for capabilities that mention "embeddings",
 * resolved by `getDefaultModelForTask()` (chat-only registry view).
 * This form drives the FK on `AiOrchestrationSettings`, which is
 * what `resolveActiveEmbeddingConfig()` reads at runtime to decide
 * which model + dim the embedder produces.
 *
 * Changing the picker doesn't migrate stored vectors — pgvector locks
 * dimension at the column level. The form surfaces a directive notice
 * after each save: run `npm run embeddings:reset` and re-upload to
 * apply, otherwise search throws a dimension-mismatch error (see
 * `assertActiveModelMatchesStoredVectors` in `search.ts`).
 */

import * as React from 'react';
import { AlertCircle, Check, Loader2, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
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

export interface ActiveEmbeddingModelOption {
  /** `AiProviderModel.id` — the FK value posted to /settings. */
  id: string;
  /** Display name (e.g. "Text Embedding 3 Small"). */
  name: string;
  /** Provider slug for grouping/labelling (e.g. "openai", "voyage"). */
  providerSlug: string;
  /** Bare model id sent to the API (e.g. "text-embedding-3-small"). */
  modelId: string;
  /** Native dimension — surfaced inline so the operator sees what they're committing to. */
  dimensions: number;
}

interface Props {
  /** Current FK; `null` = legacy provider-priority fallback. */
  initialActiveEmbeddingModelId: string | null;
  /** Embedding-capable, active models from the matrix. */
  options: ActiveEmbeddingModelOption[];
}

// Sentinel value for the Select component's "no active model" entry.
// Radix Select forbids empty string as an item value (it overlaps with
// the placeholder state), so use a distinguishable string and translate
// at submit time.
const UNSET_VALUE = '__unset__';

export function ActiveEmbeddingModelForm({
  initialActiveEmbeddingModelId,
  options,
}: Props): React.ReactElement {
  const [selected, setSelected] = React.useState<string>(
    initialActiveEmbeddingModelId ?? UNSET_VALUE
  );
  const [saved, setSaved] = React.useState<string | null>(initialActiveEmbeddingModelId);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [needsReset, setNeedsReset] = React.useState(false);

  const dirty = selected !== (saved ?? UNSET_VALUE);

  const selectedOption =
    selected === UNSET_VALUE ? null : (options.find((o) => o.id === selected) ?? null);
  const savedOption = saved ? (options.find((o) => o.id === saved) ?? null) : null;

  // A reset is needed when the operator picks a model whose dimension
  // differs from the previously-saved choice. First-time pick from the
  // legacy fallback also requires reset because today's column dim is
  // 1536; we can't introspect it client-side, so be conservative and
  // surface the notice on every successful change.
  async function handleSave(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const payload = selected === UNSET_VALUE ? null : selected;
      await apiClient.patch(API.ADMIN.ORCHESTRATION.SETTINGS, {
        body: { activeEmbeddingModelId: payload },
      });
      const dimChanged = (selectedOption?.dimensions ?? null) !== (savedOption?.dimensions ?? null);
      setSaved(payload);
      setNeedsReset(dimChanged);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to save — please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Active embedding model
          <FieldHelp title="Active embedding model" contentClassName="w-96">
            <p>
              The model whose output dimension the vector columns on{' '}
              <code className="font-mono text-xs">ai_knowledge_chunk</code> and{' '}
              <code className="font-mono text-xs">ai_message_embedding</code> are sized for.
            </p>
            <p className="mt-2">
              Changing this here saves the preference but does <em>not</em> resize the columns or
              re-embed existing data — pgvector locks dimension per column. After saving, run{' '}
              <code className="font-mono text-xs">npm run embeddings:reset</code> and re-upload your
              documents to apply the change.
            </p>
            <p className="mt-2">
              Leave unset to fall back to the legacy provider-priority resolver (Voyage → local →
              OpenAI), which always produces 1536-dim vectors.
            </p>
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="active-embedding-model">Model</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger id="active-embedding-model">
              <SelectValue placeholder="Select an embedding model…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET_VALUE}>Legacy fallback (no explicit pick)</SelectItem>
              {options.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  {opt.name}{' '}
                  <span className="text-muted-foreground text-xs">
                    · {opt.providerSlug} · {opt.dimensions}-dim
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {options.length === 0 && (
            <p className="text-muted-foreground text-xs">
              No embedding-capable models in the matrix. Add a row in{' '}
              <code className="font-mono">Provider Models</code> with{' '}
              <code className="font-mono">capability: embedding</code> and a non-null{' '}
              <code className="font-mono">dimensions</code> to populate this dropdown.
            </p>
          )}
        </div>

        {error && (
          <p className="text-destructive flex items-center gap-2 text-sm" role="alert">
            <AlertCircle className="h-4 w-4" />
            {error}
          </p>
        )}

        {needsReset && !dirty && (
          <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">Saved — but the vector columns aren&rsquo;t resized yet.</p>
            <p className="mt-1">
              Run <code className="font-mono">npm run embeddings:reset</code> and re-upload your
              documents to apply the new dimension. Until then, search will throw a clear mismatch
              error rather than returning wrong results.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => void handleSave()} disabled={!dirty || submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save
              </>
            )}
          </Button>
          {!dirty && !error && !needsReset && saved !== null && (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <Check className="h-3 w-3" />
              Saved
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
