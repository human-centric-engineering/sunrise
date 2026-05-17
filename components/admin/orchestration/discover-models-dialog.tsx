'use client';

/**
 * DiscoverModelsDialog
 *
 * Three-step dialog that replaces the free-text "New Provider Model"
 * form. Mounted by the matrix list page's "Discover models" button
 * and reused by the View Models panel's "Add to matrix" button
 * (Phase G).
 *
 * Steps:
 *   1. Provider — Select dropdown sourced from active
 *      AiProviderConfig rows. Pre-filled and skipped when the
 *      caller passes `providerSlug`.
 *   2. Discovery — table of candidates returned by
 *      GET /discovery/models. Two source dots (vendor / openrouter),
 *      capability badge, "In matrix" status. Search input + filter
 *      chips reuse the same buckets as the View Models panel so the
 *      operator's mental model stays consistent.
 *   3. Review — expandable card per selection with the heuristic-
 *      derived defaults as editable controls (name, description,
 *      capabilities, tierRole, reasoningDepth, latency,
 *      costEfficiency, contextLength, toolUse, bestRole). Each
 *      card has a "Reset to suggestion" link so an operator who
 *      tweaks a value can roll it back without re-entering the
 *      dialog.
 *
 * On submit, POSTs the batch to /provider-models/bulk and renders
 * a result panel with `created` / `skipped` counts plus per-row
 * conflicts (so the operator sees that the duplicates were skipped
 * by name, not silently). Embedding-specific fields (dimensions,
 * schemaCompatible, etc) are intentionally not in the dialog UI —
 * they're rare and the operator can edit them via the legacy
 * /provider-models/[id] edit page after creation.
 */

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  CONTEXT_LENGTH_LEVELS,
  LATENCY_LEVELS,
  RATING_LEVELS,
  TIER_ROLES,
  TIER_ROLE_META,
  TOOL_USE_LEVELS,
  type ContextLengthLevel,
  type DeploymentProfile,
  type LatencyLevel,
  type RatingLevel,
  type TierRole,
  type ToolUseLevel,
} from '@/types/orchestration';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProviderRow {
  id: string;
  name: string;
  slug: string;
  isLocal: boolean;
  isActive: boolean;
}

interface SuggestedFields {
  capabilities: string[];
  tierRole: TierRole;
  deploymentProfiles: DeploymentProfile[];
  reasoningDepth: RatingLevel;
  latency: LatencyLevel;
  costEfficiency: RatingLevel;
  contextLength: ContextLengthLevel;
  toolUse: ToolUseLevel;
  bestRole: string;
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
  maxContext: number | null;
  slug: string;
}

interface Candidate {
  modelId: string;
  name: string;
  sources: { vendor: boolean; openrouter: boolean };
  inMatrix: boolean;
  matrixId: string | null;
  inferredCapability:
    | 'chat'
    | 'reasoning'
    | 'embedding'
    | 'image'
    | 'audio'
    | 'moderation'
    | 'unknown';
  suggested: SuggestedFields;
}

interface DiscoveryResponse {
  providerSlug: string;
  candidates: Candidate[];
}

interface BulkResult {
  created: number;
  skipped: number;
  conflicts: Array<{ modelId: string; reason: string }>;
}

// Editable per-row state in step 3. Mirrors the bulk schema's row
// shape (minus the embedding extras, which the dialog doesn't expose).
interface ReviewRow {
  modelId: string; // immutable
  name: string;
  description: string;
  capabilities: string[];
  tierRole: TierRole;
  deploymentProfiles: DeploymentProfile[];
  reasoningDepth: RatingLevel;
  latency: LatencyLevel;
  costEfficiency: RatingLevel;
  contextLength: ContextLengthLevel;
  toolUse: ToolUseLevel;
  bestRole: string;
}

// One bucket per inference output. Previously reasoning + moderation +
// unknown collapsed into a single "Other" chip, which made it hard to
// scan OpenAI's mixed catalogue — each carries distinct operational
// meaning (reasoning → /v1/responses, moderation → /v1/moderations,
// unknown → can't be classified) so they each get their own chip.
type FilterBucket = Candidate['inferredCapability'];

const FILTER_BUCKETS: Array<{ id: FilterBucket; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'embedding', label: 'Embedding' },
  { id: 'image', label: 'Image' },
  { id: 'audio', label: 'Audio' },
  { id: 'moderation', label: 'Moderation' },
  { id: 'unknown', label: 'Unknown' },
];

function bucketFor(cap: Candidate['inferredCapability']): FilterBucket {
  return cap;
}

// Matrix-storable capabilities the review-card surfaces as toggles.
// `unknown` is excluded — the matrix rejects it, so giving the
// operator a checkbox for it would let them build an unsubmittable
// row. Order mirrors MODEL_CAPABILITIES in types/orchestration.ts.
const REVIEW_CAPABILITIES: Array<{ id: string; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'embedding', label: 'Embedding' },
  { id: 'audio', label: 'Audio' },
  { id: 'image', label: 'Image' },
  { id: 'moderation', label: 'Moderation' },
];

function reviewFromCandidate(c: Candidate): ReviewRow {
  return {
    modelId: c.modelId,
    name: c.name,
    description: '',
    capabilities: c.suggested.capabilities,
    tierRole: c.suggested.tierRole,
    deploymentProfiles: c.suggested.deploymentProfiles,
    reasoningDepth: c.suggested.reasoningDepth,
    latency: c.suggested.latency,
    costEfficiency: c.suggested.costEfficiency,
    contextLength: c.suggested.contextLength,
    toolUse: c.suggested.toolUse,
    bestRole: c.suggested.bestRole,
  };
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface DiscoverModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill the provider so step 1 is skipped. */
  providerSlug?: string;
  /**
   * Display name for the pre-filled provider. Used in the dialog title and
   * discovery step header so the operator knows which provider's catalogue
   * they're looking at. When the operator picks via the step-1 dropdown,
   * the name is derived from the loaded providers list instead.
   */
  providerName?: string;
  /** Pre-check the named modelIds in step 2. Useful for the View Models reuse path. */
  prefilledModelIds?: string[];
  /** Called after a successful bulk create so the parent can refresh its data. */
  onCreated?: (result: BulkResult) => void;
}

type Step = 'provider' | 'discovery' | 'review' | 'result';

export function DiscoverModelsDialog({
  open,
  onOpenChange,
  providerSlug: initialProviderSlug,
  providerName: initialProviderName,
  prefilledModelIds,
  onCreated,
}: DiscoverModelsDialogProps): React.ReactElement {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initialProviderSlug ? 'discovery' : 'provider');
  const [providers, setProviders] = useState<ProviderRow[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providerSlug, setProviderSlug] = useState<string | null>(initialProviderSlug ?? null);

  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(prefilledModelIds ?? []));
  const [search, setSearch] = useState('');
  const [activeBuckets, setActiveBuckets] = useState<Set<FilterBucket>>(new Set());

  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);

  // Reset the dialog whenever it opens — otherwise stale candidates
  // bleed across separate launches (e.g. operator picks OpenAI,
  // closes, reopens to add an Anthropic model).
  useEffect(() => {
    if (!open) return;
    setStep(initialProviderSlug ? 'discovery' : 'provider');
    setProviderSlug(initialProviderSlug ?? null);
    setSelected(new Set(prefilledModelIds ?? []));
    setSearch('');
    setActiveBuckets(new Set());
    setReviewRows([]);
    setSubmitError(null);
    setResult(null);
    setCandidates(null);
    setDiscoveryError(null);
  }, [open, initialProviderSlug, prefilledModelIds]);

  // When the operator goes back to step 1 and picks a different
  // provider, drop any selections from the previous provider —
  // they refer to candidates that won't appear in the new list.
  // Without this they linger silently in the Set, and if the
  // operator ever swaps back to the original provider those rows
  // would be re-checked unexpectedly.
  const handleProviderChange = useCallback((slug: string) => {
    setProviderSlug(slug);
    setSelected(new Set());
    setCandidates(null);
    setSearch('');
    setActiveBuckets(new Set());
  }, []);

  // Fetch providers when the provider step mounts.
  useEffect(() => {
    if (!open || step !== 'provider') return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiClient.get<{ data?: ProviderRow[] } | ProviderRow[]>(
          `${API.ADMIN.ORCHESTRATION.PROVIDERS}?isActive=true`
        );
        // The list endpoint returns either an array or { data: [...] };
        // tolerate both shapes so we don't break on minor API drift.
        const list = Array.isArray(response)
          ? response
          : Array.isArray(response.data)
            ? response.data
            : [];
        if (!cancelled) setProviders(list.filter((p) => p.isActive));
      } catch (err) {
        if (!cancelled) {
          setProvidersError(
            err instanceof Error ? err.message : "Couldn't load providers — try again."
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, step]);

  // Run discovery when the discovery step is entered.
  //
  // Clears stale candidates upfront — without that, going back to
  // step 1, picking a different provider, and continuing leaves the
  // previous provider's candidate table on screen during the loading
  // window (the loading branch only renders when `candidates === null`).
  const runDiscovery = useCallback(async () => {
    if (!providerSlug) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    setCandidates(null);
    try {
      const response = await apiClient.get<DiscoveryResponse>(
        `${API.ADMIN.ORCHESTRATION.DISCOVERY_MODELS}?providerSlug=${encodeURIComponent(providerSlug)}`
      );
      setCandidates(response.candidates ?? []);
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : "Couldn't run discovery — try again.");
      setCandidates(null);
    } finally {
      setDiscoveryLoading(false);
    }
  }, [providerSlug]);

  useEffect(() => {
    if (open && step === 'discovery') void runDiscovery();
  }, [open, step, runDiscovery]);

  // Filter candidates by search + capability buckets. Memoised so the
  // table doesn't re-filter on every input keystroke unnecessarily.
  const filteredCandidates = useMemo(() => {
    if (!candidates) return null;
    const q = search.trim().toLowerCase();
    return candidates.filter((c) => {
      if (q && !`${c.modelId} ${c.name}`.toLowerCase().includes(q)) return false;
      if (activeBuckets.size === 0) return true;
      return activeBuckets.has(bucketFor(c.inferredCapability));
    });
  }, [candidates, search, activeBuckets]);

  const toggleBucket = useCallback((b: FilterBucket) => {
    setActiveBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((modelId: string, alreadyInMatrix: boolean) => {
    if (alreadyInMatrix) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, []);

  const goToReview = useCallback(() => {
    if (!candidates) return;
    const rows = candidates.filter((c) => selected.has(c.modelId)).map(reviewFromCandidate);
    setReviewRows(rows);
    setStep('review');
  }, [candidates, selected]);

  const updateReviewRow = useCallback((modelId: string, patch: Partial<ReviewRow>) => {
    setReviewRows((prev) => prev.map((r) => (r.modelId === modelId ? { ...r, ...patch } : r)));
  }, []);

  const resetReviewRow = useCallback(
    (modelId: string) => {
      const candidate = candidates?.find((c) => c.modelId === modelId);
      if (!candidate) return;
      setReviewRows((prev) =>
        prev.map((r) => (r.modelId === modelId ? reviewFromCandidate(candidate) : r))
      );
    },
    [candidates]
  );

  const handleSubmit = useCallback(async () => {
    if (!providerSlug || reviewRows.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await apiClient.post<BulkResult>(
        API.ADMIN.ORCHESTRATION.PROVIDER_MODELS_BULK,
        {
          body: {
            providerSlug,
            models: reviewRows.map((r) => ({
              modelId: r.modelId,
              name: r.name,
              description: r.description,
              capabilities: r.capabilities,
              tierRole: r.tierRole,
              deploymentProfiles: r.deploymentProfiles,
              reasoningDepth: r.reasoningDepth,
              latency: r.latency,
              costEfficiency: r.costEfficiency,
              contextLength: r.contextLength,
              toolUse: r.toolUse,
              bestRole: r.bestRole,
            })),
          },
        }
      );
      setResult(response);
      setStep('result');
      onCreated?.(response);
      // Refresh the underlying server-rendered matrix list so the new
      // rows appear when the operator closes the dialog.
      router.refresh();
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Couldn't add the models — check server logs."
      );
    } finally {
      setSubmitting(false);
    }
  }, [providerSlug, reviewRows, onCreated, router]);

  const matchedSelected = useMemo(() => {
    if (!candidates) return [];
    return candidates.filter((c) => selected.has(c.modelId) && !c.inMatrix);
  }, [candidates, selected]);

  // Active provider name shown in the title bar and discovery header.
  // Prefer the explicit prop (set when a caller pre-fills the provider
  // and skips step 1); otherwise resolve from the loaded providers
  // list once the operator picks via the dropdown.
  const activeProviderName = useMemo(() => {
    if (initialProviderName) return initialProviderName;
    if (!providerSlug || !providers) return null;
    return providers.find((p) => p.slug === providerSlug)?.name ?? null;
  }, [initialProviderName, providerSlug, providers]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            <span>
              Discover models
              {activeProviderName ? (
                <span className="text-muted-foreground font-normal"> — {activeProviderName}</span>
              ) : null}
            </span>
          </DialogTitle>
          <DialogDescription>
            {step === 'provider' && 'Pick a configured provider to discover models from.'}
            {step === 'discovery' &&
              'Vendor catalogue + OpenRouter cross-check. Select the models you want to add.'}
            {step === 'review' &&
              'Review the auto-derived metadata for each pick. Edit any field before adding.'}
            {step === 'result' && 'Done.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-1">
          {step === 'provider' && (
            <ProviderStep
              providers={providers}
              error={providersError}
              providerSlug={providerSlug}
              onChange={handleProviderChange}
            />
          )}

          {step === 'discovery' && (
            <DiscoveryStep
              candidates={filteredCandidates}
              loading={discoveryLoading}
              error={discoveryError}
              search={search}
              onSearch={setSearch}
              activeBuckets={activeBuckets}
              onToggleBucket={toggleBucket}
              selected={selected}
              onToggleSelect={toggleSelect}
              onRefresh={() => {
                void runDiscovery();
              }}
            />
          )}

          {step === 'review' && (
            <ReviewStep
              rows={reviewRows}
              onUpdate={updateReviewRow}
              onReset={resetReviewRow}
              submitError={submitError}
            />
          )}

          {step === 'result' && result && <ResultStep result={result} />}
        </div>

        <DialogFooter className="border-t pt-4">
          {step === 'provider' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!providerSlug} onClick={() => setStep('discovery')}>
                Continue →
              </Button>
            </>
          )}
          {step === 'discovery' && (
            <>
              <span className="text-muted-foreground mr-auto text-sm">
                {matchedSelected.length} selected
              </span>
              {!initialProviderSlug && (
                <Button variant="ghost" onClick={() => setStep('provider')}>
                  ← Back
                </Button>
              )}
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={matchedSelected.length === 0} onClick={goToReview}>
                Continue →
              </Button>
            </>
          )}
          {step === 'review' && (
            <>
              <Button variant="ghost" onClick={() => setStep('discovery')}>
                ← Back
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={submitting || reviewRows.length === 0}
                onClick={() => void handleSubmit()}
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Adding…
                  </>
                ) : (
                  `Add ${reviewRows.length} model${reviewRows.length === 1 ? '' : 's'} →`
                )}
              </Button>
            </>
          )}
          {step === 'result' && <Button onClick={() => onOpenChange(false)}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Step 1: Provider ─────────────────────────────────────────────────────────

function ProviderStep({
  providers,
  error,
  providerSlug,
  onChange,
}: {
  providers: ProviderRow[] | null;
  error: string | null;
  providerSlug: string | null;
  onChange: (slug: string) => void;
}): React.ReactElement {
  if (error) {
    return (
      <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
        {error}
      </div>
    );
  }
  if (providers === null) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading providers…
      </div>
    );
  }
  if (providers.length === 0) {
    return (
      <div className="space-y-2 py-4 text-sm">
        <p className="font-medium">No active providers configured.</p>
        <p className="text-muted-foreground">
          Configure a provider first via{' '}
          <Link className="underline" href="/admin/orchestration/providers">
            Providers
          </Link>
          , then come back here to discover its models.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3 py-2">
      <label className="text-sm font-medium" htmlFor="discovery-provider-select">
        Provider
      </label>
      <Select value={providerSlug ?? undefined} onValueChange={onChange}>
        <SelectTrigger id="discovery-provider-select" className="w-full sm:w-80">
          <SelectValue placeholder="Pick a provider…" />
        </SelectTrigger>
        <SelectContent>
          {providers.map((p) => (
            <SelectItem key={p.slug} value={p.slug}>
              {p.name}
              <span className="text-muted-foreground ml-2 font-mono text-xs">{p.slug}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">
        Discovery calls <code>provider.listModels()</code> live and cross-references against the
        OpenRouter catalogue (cached for 24 hours).
      </p>
    </div>
  );
}

// ─── Step 2: Discovery ────────────────────────────────────────────────────────

function DiscoveryStep({
  candidates,
  loading,
  error,
  search,
  onSearch,
  activeBuckets,
  onToggleBucket,
  selected,
  onToggleSelect,
  onRefresh,
}: {
  candidates: Candidate[] | null;
  loading: boolean;
  error: string | null;
  search: string;
  onSearch: (s: string) => void;
  activeBuckets: Set<FilterBucket>;
  onToggleBucket: (b: FilterBucket) => void;
  selected: Set<string>;
  onToggleSelect: (modelId: string, alreadyInMatrix: boolean) => void;
  onRefresh: () => void;
}): React.ReactElement {
  if (loading && !candidates) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Discovering models…
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          <RefreshCw className="mr-2 h-3 w-3" />
          Retry
        </Button>
      </div>
    );
  }
  if (!candidates) return <div />;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          placeholder="Search by id or name…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="sm:max-w-sm"
          aria-label="Search candidates"
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
                aria-pressed={active}
                onClick={() => onToggleBucket(b.id)}
              >
                {b.label}
              </Button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          className="ml-auto"
          aria-label="Refresh candidates"
        >
          <RefreshCw className="mr-2 h-3 w-3" />
          Refresh
        </Button>
      </div>

      {candidates.length === 0 && (
        <p className="text-muted-foreground py-6 text-center text-sm">
          No candidates returned. Try refreshing — both the vendor SDK and OpenRouter are checked.
        </p>
      )}

      {candidates.length > 0 && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Name</TableHead>
                <TableHead>Sources</TableHead>
                <TableHead>Capability</TableHead>
                <TableHead>Suggested tier</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((c) => {
                const isChecked = selected.has(c.modelId);
                return (
                  <TableRow key={c.modelId} className={c.inMatrix ? 'opacity-60' : ''}>
                    <TableCell>
                      <Checkbox
                        checked={isChecked}
                        disabled={c.inMatrix}
                        onCheckedChange={() => onToggleSelect(c.modelId, c.inMatrix)}
                        aria-label={
                          c.inMatrix ? `${c.name} is already in the matrix` : `Select ${c.name}`
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm">{c.modelId}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <SourceDot label="Vendor SDK" lit={c.sources.vendor} />
                        <SourceDot label="OpenRouter" lit={c.sources.openrouter} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-[10px] capitalize">
                        {c.inferredCapability}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs capitalize">
                      {TIER_ROLE_META[c.suggested.tierRole]?.label ?? c.suggested.tierRole}
                    </TableCell>
                    <TableCell>
                      {c.inMatrix ? (
                        <Badge variant="outline" className="text-[10px]">
                          In matrix
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-[10px]">New</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function SourceDot({ label, lit }: { label: string; lit: boolean }): React.ReactElement {
  return (
    <span
      className={`inline-flex h-2 w-2 rounded-full ${lit ? 'bg-emerald-500' : 'bg-muted'}`}
      title={`${label}: ${lit ? 'present' : 'absent'}`}
      aria-label={`${label}: ${lit ? 'present' : 'absent'}`}
    />
  );
}

// ─── Step 3: Review ───────────────────────────────────────────────────────────

function ReviewStep({
  rows,
  onUpdate,
  onReset,
  submitError,
}: {
  rows: ReviewRow[];
  onUpdate: (modelId: string, patch: Partial<ReviewRow>) => void;
  onReset: (modelId: string) => void;
  submitError: string | null;
}): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(rows.map((r) => r.modelId)));

  const toggle = (modelId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {submitError && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {submitError}
        </div>
      )}
      {rows.map((r) => (
        <ReviewCard
          key={r.modelId}
          row={r}
          isOpen={expanded.has(r.modelId)}
          onToggle={() => toggle(r.modelId)}
          onUpdate={(patch) => onUpdate(r.modelId, patch)}
          onReset={() => onReset(r.modelId)}
        />
      ))}
    </div>
  );
}

function ReviewCard({
  row,
  isOpen,
  onToggle,
  onUpdate,
  onReset,
}: {
  row: ReviewRow;
  isOpen: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<ReviewRow>) => void;
  onReset: () => void;
}): React.ReactElement {
  // Stable prefix for the per-row capability checkbox ids. Using
  // `useId()` keeps each row's ids unique even when multiple cards
  // expand simultaneously.
  const checkboxIdPrefix = useId();
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-muted/50 flex w-full items-center justify-between px-3 py-2 text-left text-sm"
        aria-expanded={isOpen}
      >
        <span className="flex items-center gap-2">
          {isOpen ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="font-mono text-sm">{row.modelId}</span>
        </span>
      </button>
      {isOpen && (
        <div className="space-y-3 border-t px-4 py-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={row.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
                aria-label={`Name for ${row.modelId}`}
              />
            </Field>
            <Field label="Best role">
              <Input
                value={row.bestRole}
                onChange={(e) => onUpdate({ bestRole: e.target.value })}
                aria-label={`Best role for ${row.modelId}`}
              />
            </Field>
          </div>

          <Field label="Description (optional)">
            <Textarea
              value={row.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
              rows={2}
              aria-label={`Description for ${row.modelId}`}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Capabilities:</span>
            {REVIEW_CAPABILITIES.map((cap) => {
              const id = `${checkboxIdPrefix}-${cap.id}`;
              return (
                <label key={cap.id} htmlFor={id} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    id={id}
                    checked={row.capabilities.includes(cap.id)}
                    onCheckedChange={(checked) => {
                      const next = new Set(row.capabilities);
                      if (checked) next.add(cap.id);
                      else next.delete(cap.id);
                      onUpdate({ capabilities: Array.from(next) });
                    }}
                    aria-label={`${cap.label} capability for ${row.modelId}`}
                  />
                  {cap.label}
                </label>
              );
            })}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField
              label="Tier role"
              value={row.tierRole}
              options={TIER_ROLES.map((t) => ({ value: t, label: TIER_ROLE_META[t].label }))}
              onChange={(v) => onUpdate({ tierRole: v as TierRole })}
              ariaLabel={`Tier role for ${row.modelId}`}
            />
            <SelectField
              label="Reasoning depth"
              value={row.reasoningDepth}
              options={RATING_LEVELS.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))}
              onChange={(v) => onUpdate({ reasoningDepth: v as RatingLevel })}
              ariaLabel={`Reasoning depth for ${row.modelId}`}
            />
            <SelectField
              label="Latency"
              value={row.latency}
              options={LATENCY_LEVELS.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))}
              onChange={(v) => onUpdate({ latency: v as LatencyLevel })}
              ariaLabel={`Latency for ${row.modelId}`}
            />
            <SelectField
              label="Cost efficiency"
              value={row.costEfficiency}
              options={RATING_LEVELS.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))}
              onChange={(v) => onUpdate({ costEfficiency: v as RatingLevel })}
              ariaLabel={`Cost efficiency for ${row.modelId}`}
            />
            <SelectField
              label="Context length"
              value={row.contextLength}
              options={CONTEXT_LENGTH_LEVELS.map((v) => ({
                value: v,
                label: v.replace(/_/g, ' '),
              }))}
              onChange={(v) => onUpdate({ contextLength: v as ContextLengthLevel })}
              ariaLabel={`Context length for ${row.modelId}`}
            />
            <SelectField
              label="Tool use"
              value={row.toolUse}
              options={TOOL_USE_LEVELS.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))}
              onChange={(v) => onUpdate({ toolUse: v as ToolUseLevel })}
              ariaLabel={`Tool use for ${row.modelId}`}
            />
          </div>

          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={onReset}>
              <X className="mr-1 h-3 w-3" />
              Reset to suggestion
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      {children}
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  ariaLabel: string;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={ariaLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="capitalize">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ─── Step 4: Result ───────────────────────────────────────────────────────────

function ResultStep({ result }: { result: BulkResult }): React.ReactElement {
  // Split conflicts so the inactive ones get a more actionable
  // message — those rows already exist but are deactivated, and the
  // discovery dialog can't reactivate them. The operator needs to go
  // to the matrix list to flip them back on.
  const inactiveConflicts = result.conflicts.filter(
    (c) => c.reason === 'already_in_matrix_inactive'
  );
  const activeConflicts = result.conflicts.filter((c) => c.reason === 'already_in_matrix');

  return (
    <div className="space-y-3 py-4">
      <p className="text-sm font-medium">
        {result.created} model{result.created === 1 ? '' : 's'} added
        {result.skipped > 0 && `, ${result.skipped} skipped`}.
      </p>

      {activeConflicts.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">Skipped (already in matrix):</p>
          <ul className="text-muted-foreground list-inside list-disc">
            {activeConflicts.map((c) => (
              <li key={c.modelId}>
                <code className="font-mono text-xs">{c.modelId}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inactiveConflicts.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="font-medium">Skipped (deactivated — reactivate from the matrix list):</p>
          <ul className="text-muted-foreground list-inside list-disc">
            {inactiveConflicts.map((c) => (
              <li key={c.modelId}>
                <code className="font-mono text-xs">{c.modelId}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        New rows are visible in the matrix table once you close this dialog.
      </p>
    </div>
  );
}
