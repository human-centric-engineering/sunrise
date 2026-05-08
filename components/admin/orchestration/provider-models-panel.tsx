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
 *   - Sortable columns — click a column header to sort. Default sort is
 *     alphabetical by model name; click the "In matrix" header to group
 *     curated `AiProviderModel` rows above the vendor-discovered tail.
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
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Play, RefreshCw } from 'lucide-react';

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

// Columns the operator can sort on. `name` covers the Model column
// (sorts on display name); `inMatrix` is the default — clicking it
// flips matrix-first → discovered-first.
type SortKey = 'name' | 'inMatrix' | 'tier' | 'context' | 'input' | 'output';
type SortDir = 'asc' | 'desc';

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
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<ProviderModelsResponse>(
        API.ADMIN.ORCHESTRATION.providerModels(providerId)
      );
      const list = response.models ?? [];
      setModels(list);
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

  const sorted = useMemo(() => {
    if (!filtered) return null;
    const out = [...filtered];
    out.sort((a, b) => {
      let primary = 0;
      switch (sortKey) {
        case 'name':
          primary = a.name.localeCompare(b.name);
          break;
        case 'inMatrix':
          // false → 0, true → 1; ascending puts non-matrix first, so the
          // default `desc` surfaces matrix rows at the top of the table.
          primary = Number(a.inMatrix ?? false) - Number(b.inMatrix ?? false);
          break;
        case 'tier':
          primary = a.tier.localeCompare(b.tier);
          break;
        case 'context':
          primary = a.maxContext - b.maxContext;
          break;
        case 'input':
          primary = a.inputCostPerMillion - b.inputCostPerMillion;
          break;
        case 'output':
          primary = a.outputCostPerMillion - b.outputCostPerMillion;
          break;
      }
      const directional = sortDir === 'asc' ? primary : -primary;
      if (directional !== 0) return directional;
      // Stable secondary sort always ascends by display name regardless of
      // the active direction — keeps ties in a predictable order so a
      // catalogue of dozens of identically-tiered rows doesn't flip when
      // the user toggles the primary direction.
      return a.name.localeCompare(b.name);
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        // `inMatrix` only has one useful direction (matrix-first). Second
        // click on it reverts to the default `name asc` instead of flipping
        // to non-matrix-first, which no operator would actually want.
        if (key === 'inMatrix') {
          setSortKey('name');
          setSortDir('asc');
          return;
        }
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(key);
      // First click on a new key picks the more useful direction:
      // matrix-first for `inMatrix`, ascending for everything else.
      setSortDir(key === 'inMatrix' ? 'desc' : 'asc');
    },
    [sortKey]
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

          {sorted && sorted.length === 0 && (
            <p className="text-muted-foreground py-6 text-center text-sm">
              No models match the current filters.
            </p>
          )}

          {sorted && sorted.length > 0 && (
            <div className="rounded-md border">
              <Table>
                <TableHeader className="bg-background sticky top-0 z-10">
                  <TableRow>
                    <SortableHead
                      label="Model"
                      sortKey="name"
                      activeKey={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHead
                      label="In matrix"
                      sortKey="inMatrix"
                      activeKey={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                    />
                    <TableHead>Capabilities</TableHead>
                    <SortableHead
                      label="Context"
                      sortKey="context"
                      activeKey={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHead
                      label="Tier"
                      sortKey="tier"
                      activeKey={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                    />
                    {!isLocal && (
                      <>
                        <SortableHead
                          label="Input $/1M"
                          sortKey="input"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleSort}
                          align="right"
                        />
                        <SortableHead
                          label="Output $/1M"
                          sortKey="output"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleSort}
                          align="right"
                        />
                      </>
                    )}
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Test</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((m) => {
                    const result = testResults[m.id];
                    const isTesting = testingModel === m.id;
                    const cap = primaryCapability(m);
                    const testable = CAPABILITIES_TESTABLE.includes(cap);
                    return (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div className="font-medium">{m.name}</div>
                          <div className="text-muted-foreground font-mono text-xs">{m.id}</div>
                        </TableCell>
                        <TableCell>
                          {m.inMatrix ? (
                            <Badge
                              variant="outline"
                              className="border-green-600/40 text-[10px] text-green-700 dark:text-green-400"
                            >
                              In matrix
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
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
                        <TableCell className="text-xs">
                          {m.maxContext.toLocaleString()} tok
                        </TableCell>
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
                            <span
                              className={`text-xs ${result.ok ? 'text-green-600' : 'text-red-600'}`}
                            >
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
                                void handleTestModel(m);
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
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface SortableHeadProps {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}

function SortableHead({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
}: SortableHeadProps): React.ReactElement {
  const isActive = sortKey === activeKey;
  const Icon = !isActive ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={align === 'right' ? 'text-right' : undefined}
      // `aria-sort` belongs on the column header cell, not the button —
      // it tells assistive tech the current sort state of the column.
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`hover:text-foreground inline-flex items-center gap-1 ${
          align === 'right' ? 'ml-auto' : ''
        } ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </TableHead>
  );
}
