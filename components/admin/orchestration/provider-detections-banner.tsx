'use client';

/**
 * Provider Detections Banner
 *
 * Surfaces API keys present in `process.env` that don't have a matching
 * `AiProviderConfig` row yet. Renders above the providers grid, regardless
 * of how many providers are already configured — so an operator who has
 * OpenAI wired up but later sets `ANTHROPIC_API_KEY` still sees the gap.
 *
 * Each detection row offers two paths:
 *   - "Configure" — one-click POST that creates the provider with the
 *     suggested defaults (slug, base URL, env-var name, providerType)
 *     and writes `AiOrchestrationSettings.defaultModels.{chat,embeddings}`
 *     if those slots are empty.
 *   - Footer link "Open the setup wizard" — for operators who prefer a
 *     guided walkthrough.
 *
 * Errors never throw out of the banner. Server errors surface as inline
 * red text and the row stays visible so the operator can retry or open
 * the wizard.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { API } from '@/lib/api/endpoints';

interface DetectionRow {
  slug: string;
  name: string;
  providerType: 'anthropic' | 'openai-compatible' | 'voyage';
  defaultBaseUrl: string | null;
  apiKeyEnvVar: string | null;
  /** First candidate env-var from the provider's catalog (set or not). */
  primaryEnvVar: string | null;
  apiKeyPresent: boolean;
  alreadyConfigured: boolean;
  isLocal: boolean;
  suggestedDefaultChatModel: string | null;
  suggestedRoutingModel: string | null;
  suggestedReasoningModel: string | null;
  suggestedEmbeddingModel: string | null;
}

export interface ProviderDetectionsBannerProps {
  /**
   * Called after a successful one-click configure so the parent can
   * refresh its provider list. Detection list refreshes on its own.
   */
  onProviderCreated?: () => void;
  /**
   * When true, the banner also surfaces a "no LLM API keys detected"
   * warning whenever `/providers/detect` reports zero present keys.
   * Used by the providers list on a fresh install so the operator
   * gets the same env-setup guidance as the setup wizard, instead of
   * the bare "No providers configured yet" empty state. Leaving this
   * off (default) preserves the original behaviour: render nothing
   * when there's nothing detectable to act on.
   */
  showNoKeysWarning?: boolean;
}

export function ProviderDetectionsBanner({
  onProviderCreated,
  showNoKeysWarning = false,
}: ProviderDetectionsBannerProps): React.ReactElement | null {
  const [detected, setDetected] = useState<DetectionRow[] | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [errorBySlug, setErrorBySlug] = useState<Record<string, string>>({});

  const fetchDetection = useCallback(async () => {
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.PROVIDERS_DETECT, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        setDetected([]);
        return;
      }
      const body = (await res.json()) as {
        success?: boolean;
        data?: { detected?: DetectionRow[] };
      };
      setDetected(body.success && body.data?.detected ? body.data.detected : []);
    } catch {
      setDetected([]);
    }
  }, []);

  useEffect(() => {
    void fetchDetection();
  }, [fetchDetection]);

  // Best-effort write of suggested chat / embedding models to the
  // settings singleton. Reads `defaultModelsStored` (the raw operator-
  // saved subset), NOT `defaultModels` — the latter is hydrated with
  // computed defaults so its keys are always populated, which would
  // make the "only fill empty slots" check always falsy.
  const persistSuggestedDefaults = useCallback(async (row: DetectionRow): Promise<void> => {
    try {
      const settingsRes = await fetch(API.ADMIN.ORCHESTRATION.SETTINGS, {
        credentials: 'include',
      });
      if (!settingsRes.ok) return;
      const body = (await settingsRes.json()) as {
        success?: boolean;
        data?: { defaultModelsStored?: Partial<Record<string, string>> };
      };
      const stored = body.success ? (body.data?.defaultModelsStored ?? {}) : {};
      const patch: Record<string, string> = {};
      if (row.suggestedDefaultChatModel && !stored.chat) {
        patch.chat = row.suggestedDefaultChatModel;
      }
      if (row.suggestedRoutingModel && !stored.routing) {
        patch.routing = row.suggestedRoutingModel;
      }
      if (row.suggestedReasoningModel && !stored.reasoning) {
        patch.reasoning = row.suggestedReasoningModel;
      }
      if (row.suggestedEmbeddingModel && !stored.embeddings) {
        patch.embeddings = row.suggestedEmbeddingModel;
      }
      if (Object.keys(patch).length === 0) return;
      await fetch(API.ADMIN.ORCHESTRATION.SETTINGS, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultModels: patch }),
      });
    } catch {
      // Non-blocking — the operator can edit defaults from Settings later.
    }
  }, []);

  const handleConfigure = useCallback(
    async (row: DetectionRow) => {
      setSubmitting(row.slug);
      setErrorBySlug((prev) => {
        const next = { ...prev };
        delete next[row.slug];
        return next;
      });
      try {
        const payload: Record<string, unknown> = {
          name: row.name,
          slug: row.slug,
          providerType: row.providerType,
          isLocal: row.isLocal,
        };
        if (row.defaultBaseUrl) payload.baseUrl = row.defaultBaseUrl;
        if (row.apiKeyEnvVar) payload.apiKeyEnvVar = row.apiKeyEnvVar;

        const res = await fetch(API.ADMIN.ORCHESTRATION.PROVIDERS, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          setErrorBySlug((prev) => ({
            ...prev,
            [row.slug]: `Could not configure ${row.name}. Try the manual form or the setup wizard.`,
          }));
          return;
        }
        await persistSuggestedDefaults(row);
        // Notify the parent FIRST so the providers list starts its own
        // refetch concurrently with our detection refresh — that way
        // the user doesn't briefly see the empty providers grid while
        // we wait for /providers/detect to finish.
        onProviderCreated?.();
        // Refresh detection so the just-configured row drops out of
        // the banner.
        await fetchDetection();
      } catch {
        setErrorBySlug((prev) => ({
          ...prev,
          [row.slug]: 'Could not reach the server. Check your network and try again.',
        }));
      } finally {
        setSubmitting(null);
      }
    },
    [fetchDetection, onProviderCreated, persistSuggestedDefaults]
  );

  // Loading path renders nothing — wait until /providers/detect returns
  // before deciding which message (if any) to surface.
  if (detected === null) return null;
  const unconfigured = detected.filter((d) => d.apiKeyPresent && !d.alreadyConfigured);

  // No keys present anywhere AND the caller opted into the warning
  // (typically because there are zero configured providers). Mirror
  // the wizard's no-keys guidance so the operator hits the same
  // "set env keys and restart" message everywhere.
  if (unconfigured.length === 0 && showNoKeysWarning) {
    // Use `primaryEnvVar` (the catalog's first candidate, always set for
    // hosted providers) instead of `apiKeyEnvVar` (the one found in env,
    // which is null whenever no keys are configured — i.e. exactly the
    // branch we're rendering in). Without this the "Add one of the
    // following" list was empty.
    const candidateEnvVars = detected
      .filter((d) => !d.isLocal && !d.alreadyConfigured && d.primaryEnvVar)
      .map((d) => ({ name: d.name, envVar: d.primaryEnvVar! }));
    return (
      <Card
        data-testid="provider-no-keys-banner"
        className="border-amber-300 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/10"
      >
        <CardContent className="space-y-2 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden="true"
            />
            <div className="text-sm">
              <p className="font-medium">No LLM API keys detected in your environment</p>
              <p className="text-muted-foreground mt-1 text-xs">
                Sunrise reads provider API keys from environment variables at startup — it never
                stores them in the database. Add one of the following to your <code>.env</code> file
                and restart the server, then come back here.
              </p>
              {candidateEnvVars.length > 0 && (
                <ul className="text-muted-foreground mt-2 space-y-0.5 text-xs">
                  {candidateEnvVars.map((c) => (
                    <li key={c.envVar}>
                      <code className="bg-muted/60 rounded px-1 py-0.5">{c.envVar}</code> — {c.name}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-muted-foreground mt-2 text-xs">
                Running Ollama or a self-hosted endpoint without an API key?{' '}
                <Link href="/admin/orchestration/providers/new" className="underline">
                  Add it manually
                </Link>
                .
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Nothing to surface — the banner only takes vertical space when
  // there's a real gap to act on.
  if (unconfigured.length === 0) return null;

  return (
    <Card
      data-testid="provider-detections-banner"
      className="border-primary/30 bg-primary/5 dark:bg-primary/10"
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="text-primary mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-medium">
              {unconfigured.length === 1
                ? 'Detected an API key without a matching provider'
                : `Detected ${unconfigured.length} API keys without matching providers`}
            </p>
            <p className="text-muted-foreground mt-1">
              The following environment variables are set in your <code>.env</code> but there&apos;s
              no <code>AiProviderConfig</code> row for them yet. Configure each with one click, or
              run the setup wizard for a guided walkthrough.
            </p>
          </div>
        </div>

        <ul className="space-y-2">
          {unconfigured.map((row) => {
            const rowError = errorBySlug[row.slug];
            const isSubmitting = submitting === row.slug;
            return (
              <li
                key={row.slug}
                className="bg-background flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400"
                    aria-hidden="true"
                  />
                  <div className="space-y-1.5">
                    <div className="text-sm font-medium">{row.name}</div>
                    <div className="text-muted-foreground text-xs">
                      Detected <code>{row.apiKeyEnvVar}</code>
                    </div>

                    {/* Pre-click transparency: show what `Configure` is about to
                        write so operators don't have to read source to know
                        which model gets picked. Suggestions come from
                        `lib/orchestration/llm/known-providers.ts`. */}
                    <ConfigurePreview row={row} />

                    {rowError && <div className="text-destructive mt-1 text-xs">{rowError}</div>}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    void handleConfigure(row);
                  }}
                  disabled={isSubmitting}
                  className="shrink-0"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      Configuring…
                    </>
                  ) : (
                    'Configure'
                  )}
                </Button>
              </li>
            );
          })}
        </ul>

        <p className="text-muted-foreground text-xs">
          Prefer step-by-step?{' '}
          <Link href="/admin/orchestration" className="underline">
            Open the setup wizard
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Per-row preview of what the Configure button will write into
 * `AiOrchestrationSettings.defaultModels`, plus inline warnings when
 * the chosen provider doesn't cover both chat and embeddings:
 *
 *   - Anthropic, Groq, Together, Fireworks → no embedding model.
 *     Warns the operator that they'll need a separate provider
 *     (Voyage AI, OpenAI, Ollama) for knowledge-base vector search.
 *
 *   - Voyage → no chat model (embeddings-only). Warns that they'll
 *     need a separate chat provider for agent conversations.
 *
 * The defaults are only written into empty slots, so the preview also
 * notes that existing operator-set defaults are never overwritten.
 */
function ConfigurePreview({ row }: { row: DetectionRow }): React.ReactElement {
  const noEmbedding = !row.suggestedEmbeddingModel && !row.isLocal;
  const noChat = !row.suggestedDefaultChatModel;

  return (
    <div className="space-y-1 text-xs">
      {row.suggestedDefaultChatModel && (
        <div className="text-muted-foreground">
          Default chat model:{' '}
          <code className="bg-muted/60 rounded px-1 py-0.5">{row.suggestedDefaultChatModel}</code>
        </div>
      )}

      {row.suggestedEmbeddingModel && (
        <div className="text-muted-foreground">
          Default embedding model:{' '}
          <code className="bg-muted/60 rounded px-1 py-0.5">{row.suggestedEmbeddingModel}</code>
        </div>
      )}

      {noEmbedding && (
        <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {row.name} doesn&apos;t offer embeddings — knowledge-base search needs a separate
            embedding provider (Voyage AI, OpenAI, or Ollama).
          </span>
        </div>
      )}

      {noChat && (
        <div className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>
            {row.name} is embeddings-only — agent conversations need a separate chat provider.
          </span>
        </div>
      )}

      <div className="text-muted-foreground/70 italic">
        These are platform suggestions. Existing defaults are never overwritten.
      </div>
    </div>
  );
}
