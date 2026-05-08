'use client';

/**
 * ProviderModelsPanel
 *
 * Model catalogue for a single provider, rendered inside a dialog on
 * the providers list page. Fetches `GET /providers/:id/models` on
 * mount; the route LEFT JOINs against `AiProviderModel` so each row
 * carries `inMatrix`, `capabilities`, and `tierRole` annotations
 * (Phase A). Local providers (`isLocal: true`) hide pricing columns.
 *
 * The panel offers three controls so the operator can navigate large
 * vendor catalogues without the dialog turning into a wall of rows:
 *
 *   - Search input — substring match on `id` + `name`
 *   - Capability filter chips (Chat / Embedding / Image / Audio /
 *     Other) — multi-select; "Other" buckets reasoning, moderation,
 *     and unknown
 *   - Two sections — "In your matrix" (matched against the curated
 *     `AiProviderModel` rows, default expanded) and "Discovered"
 *     (everything else, default expanded only when no matrix rows
 *     match — keeps the dialog tight by default)
 *
 * Per-row Test button is capability-aware (Phase B/C): chat and
 * embedding rows trigger the live SDK roundtrip via
 * `POST /providers/:id/test-model` with the inferred capability;
 * everything else renders a disabled button with a Tip explaining
 * why (e.g. "Reasoning models use the /v1/responses API — testing
 * through this panel is not supported yet").
 *
 * Errors are never raw — the server route already sanitizes the
 * upstream SDK error; we layer a friendly fallback on top.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Play, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tip } from '@/components/ui/tooltip';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

export interface ProviderModelInfo {
  id: string;
  name: string;
  provider: string;
  tier: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  maxContext: number;
  supportsTools: boolean;
  available?: boolean;
  // Phase A enrichment.
  inMatrix?: boolean;
  matrixId?: string | null;
  capabilities?: string[];
  tierRole?: string | null;
}

interface ProviderModelsResponse {
  providerId: string;
  slug: string;
  models: ProviderModelInfo[];
}

type Capability = 'chat' | 'reasoning' | 'embedding' | 'image' | 'audio' | 'moderation' | 'unknown';

interface TestModelResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
  message?: string;
}

export interface ProviderModelsPanelProps {
  providerId: string;
  providerName: string;
  isLocal: boolean;
  /** Whether the provider's API key env var is set. When false, skips the live fetch. */
  apiKeyPresent?: boolean;
}

// Filter chip buckets — "Other" lumps together reasoning / moderation
// / unknown so the chips stay readable even on OpenAI's catalogue.
type FilterBucket = 'chat' | 'embedding' | 'image' | 'audio' | 'other';

const FILTER_BUCKETS: Array<{ id: FilterBucket; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'embedding', label: 'Embedding' },
  { id: 'image', label: 'Image' },
  { id: 'audio', label: 'Audio' },
  { id: 'other', label: 'Other' },
];

const CAPABILITIES_TESTABLE: Capability[] = ['chat', 'embedding'];

// Per-capability reason for a disabled test button. Shown in the Tip
// label so the operator understands why the button isn't actionable
// instead of assuming the panel is broken.
const UNTESTABLE_REASON: Partial<Record<Capability, string>> = {
  reasoning:
    'Reasoning models use the /v1/responses API — testing through this panel is not supported yet.',
  image: "Image generation models can't be tested through this panel.",
  audio: "Audio models (transcription / synthesis) can't be tested through this panel.",
  moderation: "Moderation models can't be tested through this panel.",
  unknown: "Unknown model type — we don't have a test surface for this capability.",
};

function primaryCapability(model: ProviderModelInfo): Capability {
  // Default to 'chat' when the route didn't enrich. Keeps backwards
  // compat with anything that calls listModels() without the matrix
  // LEFT JOIN — they get a usable test button instead of a disabled
  // one.
  const list = model.capabilities;
  if (!list || list.length === 0) return 'chat';
  return list[0] as Capability;
}

function bucketFor(cap: Capability): FilterBucket {
  if (cap === 'chat') return 'chat';
  if (cap === 'embedding') return 'embedding';
  if (cap === 'image') return 'image';
  if (cap === 'audio') return 'audio';
  return 'other';
}

export function ProviderModelsPanel({
  providerId,
  providerName,
  isLocal,
  apiKeyPresent = true,
}: ProviderModelsPanelProps): React.ReactElement {
  const [models, setModels] = useState<ProviderModelInfo[] | null>(null);
  const shouldFetch = apiKeyPresent || isLocal;
  const [loading, setLoading] = useState(shouldFetch);
  const [error, setError] = useState<string | null>(null);
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestModelResult>>({});
  const [search, setSearch] = useState('');
  const [activeBuckets, setActiveBuckets] = useState<Set<FilterBucket>>(new Set());
  const [discoveredOpen, setDiscoveredOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(true);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<ProviderModelsResponse>(
        API.ADMIN.ORCHESTRATION.providerModels(providerId)
      );
      const list = response.models ?? [];
      setModels(list);
      // Auto-expand Discovered when the matrix has zero matches —
      // otherwise the dialog looks empty until the operator clicks
      // through. When it has at least one matrix match, default the
      // section closed to keep the matched rows the focus.
      const hasMatrix = list.some((m) => m.inMatrix);
      setDiscoveredOpen(!hasMatrix);
    } catch {
      setError("Couldn't load models. Check the server logs for details.");
      setModels(null);
    } finally {
      setLoading(false);
    }
  }, [providerId]);

  const handleTestModel = useCallback(
    async (model: ProviderModelInfo) => {
      const cap = primaryCapability(model);
      setTestingModel(model.id);
      try {
        const result = await apiClient.post<TestModelResult>(
          API.ADMIN.ORCHESTRATION.providerTestModel(providerId),
          { body: { model: model.id, capability: cap } }
        );
        setTestResults((prev) => ({ ...prev, [model.id]: result }));
      } catch {
        setTestResults((prev) => ({
          ...prev,
          [model.id]: { ok: false, latencyMs: null },
        }));
      } finally {
        setTestingModel(null);
      }
    },
    [providerId]
  );

  useEffect(() => {
    if (!shouldFetch) return;
    void fetchModels();
  }, [fetchModels, shouldFetch]);

  const toggleBucket = useCallback((bucket: FilterBucket) => {
    setActiveBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    if (!models) return null;
    const q = search.trim().toLowerCase();
    return models.filter((m) => {
      // Substring search on id + name. Empty string matches everything.
      if (q && !`${m.id} ${m.name}`.toLowerCase().includes(q)) return false;
      // Empty filter set means "all" — only narrow when the operator
      // has selected at least one chip.
      if (activeBuckets.size === 0) return true;
      return activeBuckets.has(bucketFor(primaryCapability(m)));
    });
  }, [models, search, activeBuckets]);

  const matrixMatches = useMemo(
    () => (filtered ? filtered.filter((m) => m.inMatrix) : []),
    [filtered]
  );
  const discovered = useMemo(
    () => (filtered ? filtered.filter((m) => !m.inMatrix) : []),
    [filtered]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">{providerName}</h3>
          <p className="text-muted-foreground text-xs">
            {isLocal ? 'Local provider — pricing not applicable.' : 'Live model catalogue.'}
          </p>
        </div>
        {shouldFetch && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchModels()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh models
          </Button>
        )}
      </div>

      {!shouldFetch && (
        <div className="text-muted-foreground py-6 text-center text-sm">
          No API key configured for this provider. Set the environment variable and restart to fetch
          the live model catalogue.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {loading && !models && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading models…
        </div>
      )}

      {models && models.length === 0 && !loading && (
        <p className="text-muted-foreground py-6 text-center text-sm">
          No models reported by this provider.
        </p>
      )}

      {models && models.length > 0 && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              placeholder="Search models by id or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="sm:max-w-sm"
              aria-label="Search models"
            />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by capability">
              {FILTER_BUCKETS.map((b) => {
                const active = activeBuckets.has(b.id);
                return (
                  <Button
                    key={b.id}
                    type="button"
                    variant={active ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => toggleBucket(b.id)}
                    aria-pressed={active}
                  >
                    {b.label}
                  </Button>
                );
              })}
            </div>
          </div>

          {filtered && filtered.length === 0 && (
            <p className="text-muted-foreground py-6 text-center text-sm">
              No models match the current filters.
            </p>
          )}

          {matrixMatches.length > 0 && (
            <ModelSection
              title="In your matrix"
              count={matrixMatches.length}
              models={matrixMatches}
              isLocal={isLocal}
              testingModel={testingModel}
              testResults={testResults}
              onTest={handleTestModel}
              isOpen={matrixOpen}
              onToggle={() => setMatrixOpen((v) => !v)}
            />
          )}

          {discovered.length > 0 && (
            <ModelSection
              title="Discovered"
              count={discovered.length}
              models={discovered}
              isLocal={isLocal}
              testingModel={testingModel}
              testResults={testResults}
              onTest={handleTestModel}
              isOpen={discoveredOpen}
              onToggle={() => setDiscoveredOpen((v) => !v)}
            />
          )}
        </>
      )}
    </div>
  );
}

interface ModelSectionProps {
  title: string;
  count: number;
  models: ProviderModelInfo[];
  isLocal: boolean;
  testingModel: string | null;
  testResults: Record<string, TestModelResult>;
  onTest: (m: ProviderModelInfo) => void | Promise<void>;
  isOpen: boolean;
  onToggle: () => void;
}

function ModelSection({
  title,
  count,
  models,
  isLocal,
  testingModel,
  testResults,
  onTest,
  isOpen,
  onToggle,
}: ModelSectionProps): React.ReactElement {
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-muted/50 flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium"
        aria-expanded={isOpen}
      >
        <span className="flex items-center gap-2">
          {isOpen ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
          {title}
          <span className="text-muted-foreground text-xs">({count})</span>
        </span>
      </button>
      {isOpen && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Capabilities</TableHead>
              <TableHead>Context</TableHead>
              <TableHead>Tier</TableHead>
              {!isLocal && (
                <>
                  <TableHead className="text-right">Input $/1M</TableHead>
                  <TableHead className="text-right">Output $/1M</TableHead>
                </>
              )}
              <TableHead className="text-right">Available</TableHead>
              <TableHead className="text-right">Test</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((m) => {
              const result = testResults[m.id];
              const isTesting = testingModel === m.id;
              const cap = primaryCapability(m);
              const testable = CAPABILITIES_TESTABLE.includes(cap);
              return (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{m.name}</span>
                      {m.inMatrix && (
                        <Badge
                          variant="outline"
                          className="border-green-600/40 text-[10px] text-green-700 dark:text-green-400"
                        >
                          In matrix
                        </Badge>
                      )}
                    </div>
                    <div className="text-muted-foreground font-mono text-xs">{m.id}</div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(m.capabilities ?? ['chat']).map((c) => (
                        <Badge key={c} variant="secondary" className="text-[10px] capitalize">
                          {c}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">{m.maxContext.toLocaleString()} tok</TableCell>
                  <TableCell>
                    <span className="text-xs capitalize">{m.tier}</span>
                  </TableCell>
                  {!isLocal && (
                    <>
                      <TableCell className="text-right text-xs tabular-nums">
                        ${m.inputCostPerMillion.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        ${m.outputCostPerMillion.toFixed(2)}
                      </TableCell>
                    </>
                  )}
                  <TableCell className="text-right">
                    {m.available === false ? (
                      <span className="text-muted-foreground text-xs">—</span>
                    ) : (
                      <span className="text-xs text-green-600">✓</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {isTesting ? (
                      <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" />
                    ) : result ? (
                      <span className={`text-xs ${result.ok ? 'text-green-600' : 'text-red-600'}`}>
                        {result.ok
                          ? `${result.latencyMs} ms`
                          : (result.message ?? "Didn't respond — check server logs")}
                      </span>
                    ) : testable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => {
                          void onTest(m);
                        }}
                        title={`Test ${m.name}`}
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                    ) : (
                      <Tip label={UNTESTABLE_REASON[cap] ?? UNTESTABLE_REASON.unknown ?? ''}>
                        <span className="inline-flex">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 opacity-50"
                            disabled
                            aria-label={`Test not supported for ${m.name}`}
                          >
                            <Play className="h-3 w-3" />
                          </Button>
                        </span>
                      </Tip>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
