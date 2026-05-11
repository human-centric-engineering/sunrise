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
 *     alphabetical by canonical model id; click the "In matrix" header to
 *     group curated `AiProviderModel` rows above the vendor-discovered tail.
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
import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Play, Plus, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { DiscoverModelsDialog } from '@/components/admin/orchestration/discover-models-dialog';
import type { TaskType } from '@/types/orchestration';

// Short human labels for the four `TaskType` slots resolved via
// `OrchestrationSettings.defaultModels`. Surfaced as per-row badges
// so an operator can see at a glance which models the runtime falls
// back to when an agent has no explicit binding — distinct from the
// agents that directly name the model.
const TASK_TYPE_LABEL: Record<TaskType, string> = {
  routing: 'Routing',
  chat: 'Chat',
  reasoning: 'Reasoning',
  embeddings: 'Embeddings',
};

export interface ProviderModelAgentRef {
  id: string;
  name: string;
  slug: string;
}

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
  // Active agents bound to (provider, modelId). Empty when no agent
  // currently references the model.
  agents?: ProviderModelAgentRef[];
  // TaskType slots this model fills as the effective system default
  // (routing/chat/reasoning/embeddings). Distinct from `agents` —
  // tracks inheritance via the default-models settings rather than
  // direct assignment.
  defaultFor?: TaskType[];
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

// Filter chip buckets — one per inference output. Previously
// reasoning + moderation + unknown collapsed into a single "Other"
// chip, which lost information on OpenAI's mixed catalogue. Each now
// has its own chip; `unknown` is catalogue-only and stays here (the
// matrix rejects it).
type FilterBucket = Capability;

// Columns the operator can sort on. `name` covers the Model column
// (sorts on canonical model id, which is what the cell displays);
// `inMatrix` is the default — clicking it flips matrix-first →
// discovered-first.
type SortKey = 'name' | 'inMatrix' | 'inUse' | 'tier' | 'context' | 'input' | 'output';
type SortDir = 'asc' | 'desc';

const FILTER_BUCKETS: Array<{ id: FilterBucket; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'embedding', label: 'Embedding' },
  { id: 'image', label: 'Image' },
  { id: 'audio', label: 'Audio' },
  { id: 'moderation', label: 'Moderation' },
  { id: 'unknown', label: 'Unknown' },
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

// Per-capability description of what the Test button actually does.
// Mirrors the request shape in /providers/:id/test-model so operators
// know what's being sent on their behalf before they click.
const TESTABLE_ACTION: Partial<Record<Capability, string>> = {
  chat: "Sends a small 'Say hello.' prompt (max 10 tokens) and reports round-trip latency. Verifies the API key, base URL, and model are reachable.",
  embedding:
    "Embeds the string 'hello' and reports round-trip latency. Verifies the API key, base URL, and model are reachable.",
};

// Reason text shown on the per-cell tooltip when context / pricing is
// missing. Two variants:
//   - Remote providers: the OpenRouter catalogue is the upstream source
//     for this data, so a missing value means the model isn't listed
//     there (common for niche fine-tunes and some embedding models).
//   - Local providers: OpenRouter doesn't list local models at all, so
//     the catalogue isn't even consulted. Context length isn't reported
//     by the OpenAI-compatible /v1/models endpoint that local hosts
//     use, so the value is structurally unavailable.
const UNKNOWN_FIELD_REASON_REMOTE =
  "Not listed in OpenRouter's catalogue — common for niche fine-tunes and embedding-only models.";
const UNKNOWN_FIELD_REASON_LOCAL =
  "Local providers don't expose context length via the /v1/models endpoint — the value isn't reported by the host.";

// Tooltip for OpenRouter-listed models with explicit zero pricing
// (e.g. `:free` Llama variants). Distinguishes "we know it's free"
// from "we don't know the price" — the latter renders as "—".
//
// Detection: zero cost + `tier === 'local'` on a non-local provider.
// The OpenRouter parser's classifyTier() returns 'local' when
// inputCostPerMillion <= 0, so a non-local provider listing a
// tier='local' row is a reliable "free in OpenRouter" signal. The
// openai-compatible fallback for unknown models forces tier='mid',
// not 'local', so we won't false-positive on missing-from-catalogue.
const FREE_MODEL_REASON =
  'Listed in OpenRouter with zero per-token pricing — typically promotional or community access (e.g. :free model variants).';

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
  // Each capability maps to its own chip — no more lazy collapse into
  // "Other" for reasoning / moderation / unknown.
  return cap;
}

export function ProviderModelsPanel({
  providerId,
  providerName,
  isLocal,
  apiKeyPresent = true,
}: ProviderModelsPanelProps): React.ReactElement {
  const [models, setModels] = useState<ProviderModelInfo[] | null>(null);
  // Captured from the response so the Add to matrix dialog can be
  // pre-filled with the provider's slug (the dialog needs the slug,
  // not the providerId, to call /discovery/models).
  const [providerSlug, setProviderSlug] = useState<string | null>(null);
  const shouldFetch = apiKeyPresent || isLocal;
  const [loading, setLoading] = useState(shouldFetch);
  const [error, setError] = useState<string | null>(null);
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestModelResult>>({});
  const [search, setSearch] = useState('');
  const [activeBuckets, setActiveBuckets] = useState<Set<FilterBucket>>(new Set());
  const [inUseOnly, setInUseOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // Phase G: when set, the discover-models dialog opens with the
  // single modelId pre-checked and the provider preselected. Closes
  // by setting back to null. After a successful add we refetch so
  // the row's "In matrix" badge appears immediately.
  const [addModelId, setAddModelId] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<ProviderModelsResponse>(
        API.ADMIN.ORCHESTRATION.providerModels(providerId)
      );
      const list = response.models ?? [];
      setModels(list);
      setProviderSlug(response.slug ?? null);
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
      // "In use" toggle — only show models with at least one bound agent.
      if (inUseOnly && (m.agents?.length ?? 0) === 0) return false;
      // Empty filter set means "all" — only narrow when the operator
      // has selected at least one chip.
      if (activeBuckets.size === 0) return true;
      return activeBuckets.has(bucketFor(primaryCapability(m)));
    });
  }, [models, search, activeBuckets, inUseOnly]);

  const sorted = useMemo(() => {
    if (!filtered) return null;
    const out = [...filtered];
    out.sort((a, b) => {
      let primary = 0;
      switch (sortKey) {
        case 'name':
          primary = a.id.localeCompare(b.id);
          break;
        case 'inMatrix':
          // false → 0, true → 1; ascending puts non-matrix first, so the
          // default `desc` surfaces matrix rows at the top of the table.
          primary = Number(a.inMatrix ?? false) - Number(b.inMatrix ?? false);
          break;
        case 'inUse':
          // Sort by agent count. Default `desc` surfaces in-use rows first.
          primary = (a.agents?.length ?? 0) - (b.agents?.length ?? 0);
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
        // `inMatrix` and `inUse` only have one useful direction (curated
        // / bound rows first). Second click reverts to the default `name
        // asc` instead of flipping the rare-but-uninteresting direction.
        if (key === 'inMatrix' || key === 'inUse') {
          setSortKey('name');
          setSortDir('asc');
          return;
        }
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return;
      }
      setSortKey(key);
      // First click on a new key picks the more useful direction:
      // matrix/in-use-first for those columns, ascending for everything else.
      setSortDir(key === 'inMatrix' || key === 'inUse' ? 'desc' : 'asc');
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
              <Button
                type="button"
                variant={inUseOnly ? 'default' : 'outline'}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setInUseOnly((v) => !v)}
                aria-pressed={inUseOnly}
                aria-label="Show only models with at least one bound agent"
                title="Show only models that at least one active agent is directly assigned to. Models that only serve as a default-settings fallback are hidden."
              >
                Has agent
              </Button>
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
                    <SortableHead
                      label="Used by"
                      sortKey="inUse"
                      activeKey={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      align="right"
                      tooltip="Two distinct usage paths. (1) Agents — count of active agents that directly name this model in their Provider/Model fields. (2) Default — badges for any default-role slots (routing/chat/reasoning/embeddings) this model fills via the orchestration settings. Agents with no explicit binding fall back to the system defaults, so a model used as a default is implicitly in use even when no agent points at it directly."
                    />
                    <TableHead>Capabilities</TableHead>
                    <SortableHead
                      label="Context"
                      sortKey="context"
                      activeKey={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      tooltip="Maximum context window in tokens. Pulled from OpenRouter's public catalogue (refreshed every 24h). Shown as — when the model isn't listed there."
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
                          tooltip="Cost per million input tokens. From OpenRouter's catalogue (refreshed every 24h). Shown as — when the model isn't listed there."
                        />
                        <SortableHead
                          label="Output $/1M"
                          sortKey="output"
                          activeKey={sortKey}
                          dir={sortDir}
                          onSort={handleSort}
                          align="right"
                          tooltip="Cost per million output tokens. From OpenRouter's catalogue (refreshed every 24h). Shown as — when the model isn't listed there."
                        />
                      </>
                    )}
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Test</TableHead>
                    <TableHead className="text-right">Add</TableHead>
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
                          <div className="font-mono text-sm">{m.id}</div>
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
                        <TableCell className="text-right tabular-nums">
                          {(() => {
                            const agentCount = m.agents?.length ?? 0;
                            const defaultRoles = m.defaultFor ?? [];
                            // Empty state — render an explicit "Not in
                            // use" so the operator gets a clear signal
                            // rather than guessing what a bare "0"
                            // means.
                            if (agentCount === 0 && defaultRoles.length === 0) {
                              return (
                                <span className="text-muted-foreground text-xs italic">
                                  Not in use
                                </span>
                              );
                            }
                            return (
                              <div className="flex flex-col items-end gap-1">
                                {agentCount > 0 ? (
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <button
                                        className="cursor-pointer text-xs tabular-nums hover:underline"
                                        aria-label={`Show ${agentCount} agent${agentCount === 1 ? '' : 's'} directly assigned to ${m.name}`}
                                      >
                                        {agentCount} agent{agentCount === 1 ? '' : 's'} →
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-72 p-0" align="end">
                                      <div className="border-b px-3 py-2">
                                        <p className="text-sm font-medium">
                                          {agentCount} agent
                                          {agentCount === 1 ? '' : 's'} directly assigned to{' '}
                                          <span className="font-semibold">{m.name}</span>
                                        </p>
                                        <p className="text-muted-foreground mt-0.5 text-xs">
                                          These agents pinned this model in their Provider/Model
                                          fields. Editing the agent re-points it.
                                        </p>
                                      </div>
                                      <ul className="max-h-48 overflow-y-auto py-1">
                                        {m.agents?.map((agent) => (
                                          <li key={agent.id}>
                                            <Link
                                              href={`/admin/orchestration/agents/${agent.id}`}
                                              className="hover:bg-muted flex items-center gap-2 px-3 py-1.5 text-sm transition-colors"
                                            >
                                              <span className="truncate">{agent.name}</span>
                                              <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
                                                {agent.slug}
                                              </span>
                                            </Link>
                                          </li>
                                        ))}
                                      </ul>
                                    </PopoverContent>
                                  </Popover>
                                ) : (
                                  <span className="text-muted-foreground text-xs">0 agents</span>
                                )}
                                {defaultRoles.length > 0 && (
                                  <div className="flex flex-wrap justify-end gap-1">
                                    {defaultRoles.map((task) => (
                                      <Tip
                                        key={task}
                                        label={`System default for ${TASK_TYPE_LABEL[task]} tasks. Agents with no explicit Provider/Model inherit this. Edit in orchestration settings.`}
                                      >
                                        <Link
                                          href="/admin/orchestration/settings"
                                          aria-label={`Edit ${TASK_TYPE_LABEL[task]} default in orchestration settings`}
                                        >
                                          <Badge
                                            variant="outline"
                                            className="text-[10px] font-normal"
                                          >
                                            Default: {TASK_TYPE_LABEL[task]}
                                          </Badge>
                                        </Link>
                                      </Tip>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
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
                          {m.maxContext > 0 ? (
                            `${m.maxContext.toLocaleString()} tok`
                          ) : (
                            <Tip
                              label={
                                isLocal ? UNKNOWN_FIELD_REASON_LOCAL : UNKNOWN_FIELD_REASON_REMOTE
                              }
                            >
                              <span className="text-muted-foreground cursor-help">—</span>
                            </Tip>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs capitalize">{m.tier}</span>
                        </TableCell>
                        {!isLocal && (
                          <>
                            <TableCell className="text-right text-xs tabular-nums">
                              {m.inputCostPerMillion > 0 ? (
                                `$${m.inputCostPerMillion.toFixed(2)}`
                              ) : m.tier === 'local' ? (
                                <Tip label={FREE_MODEL_REASON}>
                                  <span className="cursor-help text-green-600">Free</span>
                                </Tip>
                              ) : (
                                <Tip label={UNKNOWN_FIELD_REASON_REMOTE}>
                                  <span className="text-muted-foreground cursor-help">—</span>
                                </Tip>
                              )}
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums">
                              {m.outputCostPerMillion > 0 ? (
                                `$${m.outputCostPerMillion.toFixed(2)}`
                              ) : m.tier === 'local' ? (
                                <Tip label={FREE_MODEL_REASON}>
                                  <span className="cursor-help text-green-600">Free</span>
                                </Tip>
                              ) : (
                                <Tip label={UNKNOWN_FIELD_REASON_REMOTE}>
                                  <span className="text-muted-foreground cursor-help">—</span>
                                </Tip>
                              )}
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
                            <Tip label={TESTABLE_ACTION[cap] ?? TESTABLE_ACTION.chat ?? ''}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => {
                                  void handleTestModel(m);
                                }}
                                aria-label={`Test ${m.name}`}
                              >
                                <Play className="h-3 w-3" />
                              </Button>
                            </Tip>
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
                        <TableCell className="text-right">
                          {m.inMatrix ? (
                            // Already curated — nothing to add. Spacer keeps the
                            // column width stable across rows.
                            <span className="text-muted-foreground text-xs">—</span>
                          ) : (
                            <Tip
                              label={`Add ${m.name} to the matrix — opens the discovery dialog with this row pre-selected.`}
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                disabled={!providerSlug}
                                onClick={() => setAddModelId(m.id)}
                                aria-label={`Add ${m.name} to matrix`}
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
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

      {/* Phase G — discovery dialog reuse. Mounted with providerSlug
          preselected and the single modelId pre-checked, so the
          operator goes straight to step 2 with the row ready and
          can move on to review without re-discovering anything. */}
      {providerSlug && (
        <DiscoverModelsDialog
          open={addModelId !== null}
          onOpenChange={(next) => {
            if (!next) {
              setAddModelId(null);
              // Best-effort refetch so the freshly-added row's "In
              // matrix" annotation appears without the operator
              // having to click Refresh.
              void fetchModels();
            }
          }}
          providerSlug={providerSlug}
          providerName={providerName}
          prefilledModelIds={addModelId ? [addModelId] : []}
        />
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
  tooltip?: string;
}

function SortableHead({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = 'left',
  tooltip,
}: SortableHeadProps): React.ReactElement {
  const isActive = sortKey === activeKey;
  const Icon = !isActive ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  const button = (
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
  );
  return (
    <TableHead
      className={align === 'right' ? 'text-right' : undefined}
      // `aria-sort` belongs on the column header cell, not the button —
      // it tells assistive tech the current sort state of the column.
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {tooltip ? <Tip label={tooltip}>{button}</Tip> : button}
    </TableHead>
  );
}
