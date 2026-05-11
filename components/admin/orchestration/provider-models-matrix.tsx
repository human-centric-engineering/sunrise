'use client';

/**
 * Provider Model Matrix
 *
 * Flat, filterable table showing per-model analysis with chat/embedding badges,
 * sortable columns, and provider/tier/capability filters.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useCallback, useMemo, useState } from 'react';
import { ArrowUpDown, ClipboardCheck, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FieldHelp } from '@/components/ui/field-help';
import { AuditModelsDialog } from '@/components/admin/orchestration/audit-models-dialog';
import { DiscoverModelsDialog } from '@/components/admin/orchestration/discover-models-dialog';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { Input } from '@/components/ui/input';
import {
  MODEL_CAPABILITIES,
  STORAGE_ONLY_CAPABILITIES,
  TIER_ROLE_META,
  type ModelCapability,
  type TaskType,
  type TierRole,
} from '@/types/orchestration';

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
  audio: 'Audio',
};

// Stable label + colour mapping shared by the per-capability badges
// in the table cells and the filter chips at the top. Same hue in
// both surfaces so the operator's eye stitches "chip → badge → row"
// without having to re-read the label. Kept locally rather than
// hoisted to types/ because the colours are presentational and may
// drift independently of the canonical capability set.
//
// `badgeClass` is the tinted style used by the cell badges.
// `dotClass` is the solid swatch used on the inactive filter chips
// — gives every chip a colour cue even when not pressed, so the
// chip row reads as a key for the table colours below.
const CAPABILITY_DISPLAY: Record<
  ModelCapability,
  { label: string; badgeClass: string; dotClass: string }
> = {
  chat: {
    label: 'Chat',
    badgeClass: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
    dotClass: 'bg-sky-500',
  },
  reasoning: {
    label: 'Reasoning',
    badgeClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    dotClass: 'bg-purple-500',
  },
  embedding: {
    label: 'Embedding',
    badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    dotClass: 'bg-amber-500',
  },
  audio: {
    label: 'Audio',
    badgeClass: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
    dotClass: 'bg-teal-500',
  },
  image: {
    label: 'Image',
    badgeClass: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200',
    dotClass: 'bg-rose-500',
  },
  moderation: {
    label: 'Moderation',
    badgeClass: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
    dotClass: 'bg-orange-500',
  },
};

const STORAGE_ONLY_SET = new Set<ModelCapability>(STORAGE_ONLY_CAPABILITIES);

export interface ModelRowAgentRef {
  id: string;
  name: string;
  slug: string;
}

export interface ModelRowWorkflowRef {
  id: string;
  name: string;
  slug: string;
}

export interface ModelRow {
  id: string;
  slug: string;
  providerSlug: string;
  modelId: string;
  name: string;
  description: string;
  capabilities: string[];
  tierRole: string;
  reasoningDepth: string;
  latency: string;
  costEfficiency: string;
  contextLength: string;
  toolUse: string;
  bestRole: string;
  isDefault: boolean;
  isActive: boolean;
  configured: boolean;
  configuredActive: boolean;
  dimensions?: number | null;
  schemaCompatible?: boolean | null;
  costPerMillionTokens?: number | null;
  // Active agents bound to (providerSlug, modelId). Empty when no agent
  // currently references the row. Source: GET /provider-models LEFT
  // JOIN against AiAgent on the (provider, model) string pair.
  agents?: ModelRowAgentRef[];
  // TaskType slots this model fills as the effective system default
  // (routing/chat/reasoning/embeddings). Distinct from `agents` —
  // tracks inheritance via the default-models settings rather than
  // direct assignment.
  defaultFor?: TaskType[];
  metadata?: {
    lastAudit?: {
      timestamp: string;
    };
    [key: string]: unknown;
  } | null;
}

interface ProviderModelsMatrixProps {
  initialModels: ModelRow[];
}

type SortKey =
  | 'providerSlug'
  | 'name'
  | 'tierRole'
  | 'reasoningDepth'
  | 'latency'
  | 'costEfficiency'
  | 'contextLength'
  | 'toolUse';

const RATING_ORDER: Record<string, number> = {
  very_high: 4,
  very_fast: 4,
  high: 3,
  fast: 3,
  strong: 3,
  medium: 2,
  moderate: 2,
  none: 1,
  n_a: 0,
};

function ratingBadge(value: string) {
  const colorMap: Record<string, string> = {
    very_high: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
    very_fast: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
    high: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    fast: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    strong: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    medium: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    moderate: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    none: 'bg-gray-50 text-gray-400 dark:bg-gray-900 dark:text-gray-600',
    n_a: 'bg-gray-50 text-gray-400 dark:bg-gray-900 dark:text-gray-600',
  };
  const label = value === 'n_a' ? 'N/A' : value.replace(/_/g, ' ');
  return (
    <Badge variant="outline" className={cn('text-xs capitalize', colorMap[value] ?? '')}>
      {label}
    </Badge>
  );
}

function capabilityBadges(capabilities: string[]): React.ReactElement {
  // Render one small pill per capability. Previously this collapsed
  // chat+embedding into "Both" and dropped everything else; with the
  // matrix now storing reasoning/audio/image/moderation we render the
  // full set instead.
  if (capabilities.length === 0) {
    return (
      <Badge
        variant="outline"
        className="bg-red-100 text-xs text-red-800 dark:bg-red-900 dark:text-red-200"
      >
        None
      </Badge>
    );
  }
  // Render in canonical order from MODEL_CAPABILITIES regardless of
  // input order, so two rows with the same capabilities render
  // identically.
  const ordered = MODEL_CAPABILITIES.filter((c) => capabilities.includes(c));
  return (
    <div className="flex flex-wrap items-center gap-1">
      {ordered.map((cap) => (
        <Badge
          key={cap}
          variant="outline"
          className={cn('text-xs', CAPABILITY_DISPLAY[cap].badgeClass)}
        >
          {CAPABILITY_DISPLAY[cap].label}
        </Badge>
      ))}
    </div>
  );
}

function SortableHead({
  label,
  field,
  activeKey,
  sortAsc,
  onToggle,
}: {
  label: string;
  field: SortKey;
  activeKey: SortKey;
  sortAsc: boolean;
  onToggle: (key: SortKey) => void;
}): React.ReactElement {
  const isActive = activeKey === field;
  return (
    <TableHead
      className="cursor-pointer select-none"
      tabIndex={0}
      role="columnheader"
      aria-sort={isActive ? (sortAsc ? 'ascending' : 'descending') : 'none'}
      onClick={() => onToggle(field)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(field);
        }
      }}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown className={cn('h-3 w-3', isActive ? 'opacity-100' : 'opacity-30')} />
      </span>
    </TableHead>
  );
}

export function ProviderModelsMatrix({
  initialModels,
}: ProviderModelsMatrixProps): React.ReactElement {
  const router = useRouter();
  const [providerFilter, setProviderFilter] = useState<string>('all');
  // Master "narrow to configured providers" toggle. When true, every
  // row from a provider with no AiProviderConfig (or one that's
  // inactive) is hidden. Distinct from `providerFilter` — that's a
  // drill-down to a single slug; this is the broad "only show what
  // I've actually wired up" filter the operator wants by default once
  // they've completed setup.
  const [configuredOnly, setConfiguredOnly] = useState<boolean>(false);
  const [tierFilter, setTierFilter] = useState<string>('all');
  // Chip multi-select: each capability the operator toggles is added
  // to the set. Empty set = no capability filter (show all). This is
  // the same shape used by the catalogue panel (provider-models-panel.tsx)
  // so the matrix mirrors the catalogue's UX.
  const [activeCapabilities, setActiveCapabilities] = useState<Set<ModelCapability>>(new Set());
  const [search, setSearch] = useState<string>('');
  const [inUseOnly, setInUseOnly] = useState<boolean>(false);
  const [sortKey, setSortKey] = useState<SortKey>('providerSlug');
  const [auditOpen, setAuditOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [sortAsc, setSortAsc] = useState(true);

  // Row deletion state. `target` doubles as the open flag for the
  // confirmation dialog. `error` surfaces 409 in-use responses or
  // network failures.
  const [deleteTarget, setDeleteTarget] = useState<ModelRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBlockedAgents, setDeleteBlockedAgents] = useState<ModelRowAgentRef[]>([]);
  const [deleteBlockedWorkflows, setDeleteBlockedWorkflows] = useState<ModelRowWorkflowRef[]>([]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.providerModelById(deleteTarget.id));
      setDeleteTarget(null);
      setDeleteBlockedAgents([]);
      setDeleteBlockedWorkflows([]);
      router.refresh();
    } catch (err) {
      // 409 → in-use guard tripped. Pull the blocking-ref lists out of
      // the structured details so the dialog can render names + slugs
      // instead of just an opaque error message.
      if (err instanceof APIClientError) {
        if (err.status === 409) {
          if (Array.isArray(err.details?.agents)) {
            setDeleteBlockedAgents(err.details.agents as ModelRowAgentRef[]);
          }
          if (Array.isArray(err.details?.workflows)) {
            setDeleteBlockedWorkflows(err.details.workflows as ModelRowWorkflowRef[]);
          }
        }
        setDeleteError(err.message);
      } else {
        setDeleteError(err instanceof Error ? err.message : "Couldn't delete the model.");
      }
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, router]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTarget(null);
    setDeleteError(null);
    setDeleteBlockedAgents([]);
    setDeleteBlockedWorkflows([]);
  }, []);

  const deleteBlocked = deleteBlockedAgents.length + deleteBlockedWorkflows.length > 0;

  // Aggregate per-provider state for the strip above the filter bar.
  // `configured` and `configuredActive` come from the row's enrichment
  // (LEFT JOIN against AiProviderConfig in the GET /provider-models
  // route); both ride per-row but apply to the whole provider, so we
  // collapse them here. Counts are over the unfiltered active model
  // set so the strip stays stable as other filters change — the
  // operator wants "Anthropic has 12 models in your matrix", not
  // "Anthropic has 3 models matching your current filters".
  const providerMeta = useMemo(() => {
    const bySlug = new Map<
      string,
      { slug: string; configured: boolean; configuredActive: boolean; modelCount: number }
    >();
    for (const m of initialModels) {
      if (!m.isActive) continue;
      const existing = bySlug.get(m.providerSlug);
      if (existing) {
        existing.modelCount += 1;
        // Promote to the most-configured state across rows. In
        // practice every row for the same slug agrees, but be
        // defensive — an inconsistent backend shouldn't downgrade the
        // chip's status dot.
        if (m.configured) existing.configured = true;
        if (m.configuredActive) existing.configuredActive = true;
      } else {
        bySlug.set(m.providerSlug, {
          slug: m.providerSlug,
          configured: m.configured,
          configuredActive: m.configuredActive,
          modelCount: 1,
        });
      }
    }
    return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }, [initialModels]);

  const configuredActiveCount = useMemo(
    () => providerMeta.filter((p) => p.configuredActive).length,
    [providerMeta]
  );

  const tiers = useMemo(
    () => [...new Set(initialModels.map((m) => m.tierRole))].sort(),
    [initialModels]
  );

  const filtered = useMemo(() => {
    let rows = initialModels.filter((m) => m.isActive);
    // Configured-only is broader than the per-provider drill-down. It
    // strips every row whose provider has no AiProviderConfig row OR
    // whose config row is inactive — i.e. "things that aren't going
    // to work right now". Applied first so the per-provider chip below
    // can still narrow within the configured set.
    if (configuredOnly) rows = rows.filter((m) => m.configured && m.configuredActive);
    if (providerFilter !== 'all') rows = rows.filter((m) => m.providerSlug === providerFilter);
    if (tierFilter !== 'all') rows = rows.filter((m) => m.tierRole === tierFilter);
    if (activeCapabilities.size > 0) {
      // Union (OR) semantics: a row matches when it carries any of the
      // selected capabilities. Mirrors the catalogue panel; the In-use
      // toggle handles the "narrow further" case.
      rows = rows.filter((m) =>
        m.capabilities.some((c) => activeCapabilities.has(c as ModelCapability))
      );
    }
    if (inUseOnly) {
      rows = rows.filter((m) => (m.agents?.length ?? 0) > 0);
    }
    const term = search.trim().toLowerCase();
    if (term.length > 0) {
      rows = rows.filter((m) =>
        [m.name, m.modelId, m.slug, m.bestRole]
          .filter(Boolean)
          .some((v) => v.toLowerCase().includes(term))
      );
    }

    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const aScore = RATING_ORDER[av] ?? 0;
      const bScore = RATING_ORDER[bv] ?? 0;
      if (aScore !== bScore) return sortAsc ? aScore - bScore : bScore - aScore;
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });

    return rows;
  }, [
    initialModels,
    configuredOnly,
    providerFilter,
    tierFilter,
    activeCapabilities,
    inUseOnly,
    search,
    sortKey,
    sortAsc,
  ]);

  const toggleCapability = useCallback((cap: ModelCapability) => {
    setActiveCapabilities((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  }, []);

  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortAsc(!sortAsc);
      } else {
        setSortKey(key);
        setSortAsc(true);
      }
    },
    [sortKey, sortAsc]
  );

  return (
    <div className="space-y-4">
      {/* Provider strip — one chip per provider with a status dot,
          plus the master "Configured only" toggle. Replaces the old
          Provider <Select> dropdown so the configured-vs-not state is
          legible at a glance (the dropdown only listed slugs, with no
          status indicator). */}
      <div
        className="bg-muted/30 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
        role="group"
        aria-label="Provider filter"
      >
        <span className="text-muted-foreground text-xs font-medium">Providers</span>
        <span className="text-muted-foreground/70 text-xs">
          {configuredActiveCount} active · {providerMeta.length} total
        </span>

        <button
          type="button"
          onClick={() => setConfiguredOnly((v) => !v)}
          aria-pressed={configuredOnly}
          title="Hide rows from providers without an active AiProviderConfig — i.e. providers you haven't wired up yet, or have intentionally deactivated."
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
            configuredOnly
              ? 'border-transparent bg-emerald-600 text-white shadow-sm dark:bg-emerald-500'
              : 'border-input bg-background text-muted-foreground hover:bg-muted'
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              configuredOnly ? 'bg-white' : 'bg-emerald-500'
            )}
            aria-hidden
          />
          Configured only
        </button>

        <div className="bg-border h-5 w-px" aria-hidden />

        {/* All-providers chip — clears the per-provider drill-down. */}
        <button
          type="button"
          onClick={() => setProviderFilter('all')}
          aria-pressed={providerFilter === 'all'}
          className={cn(
            'inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors',
            providerFilter === 'all'
              ? 'border-transparent bg-slate-700 text-white shadow-sm dark:bg-slate-300 dark:text-slate-900'
              : 'border-input bg-background text-muted-foreground hover:bg-muted'
          )}
        >
          All
        </button>

        {providerMeta
          // When the master toggle is on, the chips for un-configured
          // providers are dropped from the strip too — they can't
          // match anything in the filtered matrix, so keeping them
          // around would be pure noise.
          .filter((p) => !configuredOnly || (p.configured && p.configuredActive))
          .map((p) => {
            const isActive = providerFilter === p.slug;
            const dotClass =
              p.configured && p.configuredActive
                ? 'bg-green-500'
                : p.configured
                  ? 'bg-yellow-500'
                  : 'bg-gray-300';
            const dotTitle =
              p.configured && p.configuredActive
                ? 'Provider configured and active'
                : p.configured
                  ? 'Provider configured but inactive'
                  : 'Provider not configured';
            return (
              <button
                key={p.slug}
                type="button"
                onClick={() => setProviderFilter(isActive ? 'all' : p.slug)}
                aria-pressed={isActive}
                aria-label={`Filter to ${p.slug} models — ${dotTitle.toLowerCase()}`}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs capitalize transition-colors',
                  isActive
                    ? 'border-transparent bg-slate-700 text-white shadow-sm dark:bg-slate-300 dark:text-slate-900'
                    : 'border-input bg-background hover:bg-muted'
                )}
              >
                <span
                  className={cn('h-2 w-2 shrink-0 rounded-full', dotClass)}
                  title={dotTitle}
                  aria-hidden
                />
                {p.slug}
                <span
                  className={cn(
                    'tabular-nums',
                    isActive ? 'text-white/80 dark:text-slate-700' : 'text-muted-foreground/70'
                  )}
                >
                  {p.modelCount}
                </span>
              </button>
            );
          })}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={tierFilter} onValueChange={setTierFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Tier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tiers</SelectItem>
            {tiers.map((t) => (
              <SelectItem key={t} value={t}>
                {TIER_ROLE_META[t as TierRole]?.label ?? t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, model id, slug…"
          aria-label="Search models"
          className="w-[240px]"
        />

        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by capability">
          {MODEL_CAPABILITIES.map((cap) => {
            const active = activeCapabilities.has(cap);
            const display = CAPABILITY_DISPLAY[cap];
            return (
              <button
                key={cap}
                type="button"
                onClick={() => toggleCapability(cap)}
                aria-pressed={active}
                className={cn(
                  'inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors',
                  active
                    ? cn(display.badgeClass, 'border-transparent shadow-sm')
                    : 'border-input bg-background text-muted-foreground hover:bg-muted'
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', display.dotClass)} aria-hidden />
                {display.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setInUseOnly((v) => !v)}
            aria-pressed={inUseOnly}
            aria-label="Show only models with at least one bound agent"
            title="Show only models that at least one active agent is directly assigned to. Models that only serve as a default-settings fallback are hidden."
            className={cn(
              'inline-flex h-6 items-center rounded-full border px-2 text-xs transition-colors',
              inUseOnly
                ? 'border-transparent bg-slate-700 text-white shadow-sm dark:bg-slate-300 dark:text-slate-900'
                : 'border-input bg-background text-muted-foreground hover:bg-muted'
            )}
          >
            Has agent
          </button>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <p className="text-muted-foreground text-sm">
            {filtered.length} model{filtered.length !== 1 ? 's' : ''}
          </p>
          <Button variant="outline" onClick={() => setAuditOpen(true)}>
            <ClipboardCheck className="mr-2 h-4 w-4" />
            Audit Models
          </Button>
          <FieldHelp title="AI-Powered Model Audit">
            Triggers the Provider Model Audit workflow — a real orchestration workflow execution via{' '}
            <code>POST /workflows/:id/execute</code>. The audit evaluates your model entries for
            accuracy, proposes changes, and pauses for your approval before applying them. This also
            serves as a framework reference implementation, exercising 10 of 15 step types
            end-to-end.
          </FieldHelp>
          <Button onClick={() => setDiscoverOpen(true)}>
            <Sparkles className="mr-2 h-4 w-4" />
            Discover models
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead
                label="Provider"
                field="providerSlug"
                activeKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              <SortableHead
                label="Model"
                field="name"
                activeKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              <TableHead>Type</TableHead>
              <SortableHead
                label="Tier"
                field="tierRole"
                activeKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              <SortableHead
                label="Reasoning"
                field="reasoningDepth"
                activeKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              <SortableHead
                label="Latency"
                field="latency"
                activeKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              <SortableHead
                label="Cost Eff."
                field="costEfficiency"
                activeKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              <SortableHead
                label="Context"
                field="contextLength"
                activeKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              <SortableHead
                label="Tools"
                field="toolUse"
                activeKey={sortKey}
                sortAsc={sortAsc}
                onToggle={toggleSort}
              />
              <TableHead>Best For</TableHead>
              <TableHead className="text-right">
                <span className="inline-flex items-center gap-1">
                  Used by
                  <FieldHelp title="Used by">
                    Two distinct usage paths:
                    <br />
                    <strong>Agents</strong> — active agents that directly name this model in their
                    Provider/Model fields. Click the count to list them.
                    <br />
                    <strong>Default badges</strong> — system default-role slots
                    (routing/chat/reasoning/embeddings) this model currently fills via orchestration
                    settings. Agents with no explicit binding inherit these defaults at runtime, so
                    a model used as a default is implicitly in use even when no agent points at it
                    directly.
                  </FieldHelp>
                </span>
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="text-muted-foreground py-8 text-center">
                  No models match the current filters
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((model) => (
                <TableRow key={model.id} className="hover:bg-muted/50">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-block h-2 w-2 shrink-0 rounded-full',
                          model.configured && model.configuredActive
                            ? 'bg-green-500'
                            : model.configured
                              ? 'bg-yellow-500'
                              : 'bg-gray-300'
                        )}
                        title={
                          model.configured && model.configuredActive
                            ? 'Provider configured and active'
                            : model.configured
                              ? 'Provider configured but inactive'
                              : 'Provider not configured'
                        }
                      />
                      <span className="text-muted-foreground text-sm capitalize">
                        {model.providerSlug}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link
                      href={`/admin/orchestration/provider-models/${model.id}`}
                      className="hover:underline"
                    >
                      {model.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      {capabilityBadges(model.capabilities)}
                      {model.capabilities.length > 0 &&
                        model.capabilities.every((c) =>
                          STORAGE_ONLY_SET.has(c as ModelCapability)
                        ) && (
                          <Tip label="The orchestration engine has no runtime path for image or moderation models yet — this row is informational/inventory only.">
                            <span className="text-muted-foreground cursor-help text-[10px] uppercase">
                              Storage-only
                            </span>
                          </Tip>
                        )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className="text-xs">
                      {TIER_ROLE_META[model.tierRole as TierRole]?.label ?? model.tierRole}
                    </Badge>
                  </TableCell>
                  <TableCell>{ratingBadge(model.reasoningDepth)}</TableCell>
                  <TableCell>{ratingBadge(model.latency)}</TableCell>
                  <TableCell>{ratingBadge(model.costEfficiency)}</TableCell>
                  <TableCell>{ratingBadge(model.contextLength)}</TableCell>
                  <TableCell>{ratingBadge(model.toolUse)}</TableCell>
                  <TableCell className="text-muted-foreground max-w-[180px] truncate text-xs">
                    {model.bestRole}
                    {model.capabilities.includes('embedding') && model.dimensions && (
                      <span className="text-muted-foreground/70 ml-1">
                        ({model.dimensions}d{model.schemaCompatible ? ' ✓' : ''})
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {(() => {
                      const agentCount = model.agents?.length ?? 0;
                      const defaultRoles = model.defaultFor ?? [];
                      // Empty state — render an explicit "Not in use"
                      // so the operator gets a clear signal rather
                      // than guessing what a bare "0" means.
                      if (agentCount === 0 && defaultRoles.length === 0) {
                        return (
                          <span className="text-muted-foreground text-xs italic">Not in use</span>
                        );
                      }
                      return (
                        <div className="flex flex-col items-end gap-1">
                          {agentCount > 0 ? (
                            <Popover>
                              <PopoverTrigger asChild>
                                <button
                                  className="cursor-pointer text-xs tabular-nums hover:underline"
                                  aria-label={`Show ${agentCount} agent${
                                    agentCount === 1 ? '' : 's'
                                  } directly assigned to ${model.name}`}
                                >
                                  {agentCount} agent{agentCount === 1 ? '' : 's'} →
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-72 p-0" align="end">
                                <div className="border-b px-3 py-2">
                                  <p className="text-sm font-medium">
                                    {agentCount} agent
                                    {agentCount === 1 ? '' : 's'} directly assigned to{' '}
                                    <span className="font-semibold">{model.name}</span>
                                  </p>
                                  <p className="text-muted-foreground mt-0.5 text-xs">
                                    These agents pinned this model in their Provider/Model fields.
                                    Editing the agent re-points it.
                                  </p>
                                </div>
                                <ul className="max-h-48 overflow-y-auto py-1">
                                  {model.agents?.map((agent) => (
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
                                    <Badge variant="outline" className="text-[10px] font-normal">
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
                  <TableCell className="text-right">
                    {(model.agents?.length ?? 0) > 0 ? (
                      <Tip
                        label={`Cannot delete — ${model.agents?.length} agent${
                          model.agents?.length === 1 ? '' : 's'
                        } still ${model.agents?.length === 1 ? 'uses' : 'use'} this model.`}
                      >
                        <span className="inline-flex">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 opacity-50"
                            disabled
                            aria-label={`Delete ${model.name} disabled — model is in use`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      </Tip>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive h-7 w-7 p-0"
                        onClick={() => setDeleteTarget(model)}
                        aria-label={`Delete ${model.name}`}
                        title={`Delete ${model.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Audit dialog */}
      <AuditModelsDialog open={auditOpen} onOpenChange={setAuditOpen} models={initialModels} />

      {/* Discover dialog — replaces the legacy free-text "New Provider Model" form
          as the primary entry point. The legacy form stays mounted on
          /provider-models/[id] for editing. */}
      <DiscoverModelsDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) handleCancelDelete();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete model</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? (
                <>
                  Permanently removes <strong>{deleteTarget.name}</strong> from the matrix. Discover
                  models will list it again if the provider still serves it.
                </>
              ) : (
                'Permanently removes the model from the matrix.'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {deleteBlockedAgents.length > 0 && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">
                {deleteBlockedAgents.length} agent
                {deleteBlockedAgents.length === 1 ? '' : 's'} still{' '}
                {deleteBlockedAgents.length === 1 ? 'uses' : 'use'} this model — re-point{' '}
                {deleteBlockedAgents.length === 1 ? 'it' : 'them'} first:
              </p>
              <ul className="text-muted-foreground mt-1 list-inside list-disc">
                {deleteBlockedAgents.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <Link href={`/admin/orchestration/agents/${a.id}`} className="hover:underline">
                      {a.name}
                    </Link>{' '}
                    <span className="font-mono text-xs">({a.slug})</span>
                  </li>
                ))}
                {deleteBlockedAgents.length > 8 && (
                  <li>…and {deleteBlockedAgents.length - 8} more</li>
                )}
              </ul>
            </div>
          )}

          {deleteBlockedWorkflows.length > 0 && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">
                {deleteBlockedWorkflows.length} workflow
                {deleteBlockedWorkflows.length === 1 ? '' : 's'} pin
                {deleteBlockedWorkflows.length === 1 ? 's' : ''} this model via{' '}
                <code>modelOverride</code> — edit{' '}
                {deleteBlockedWorkflows.length === 1 ? 'it' : 'them'} first:
              </p>
              <ul className="text-muted-foreground mt-1 list-inside list-disc">
                {deleteBlockedWorkflows.slice(0, 8).map((w) => (
                  <li key={w.id}>
                    <Link
                      href={`/admin/orchestration/workflows/${w.id}`}
                      className="hover:underline"
                    >
                      {w.name}
                    </Link>{' '}
                    <span className="font-mono text-xs">({w.slug})</span>
                  </li>
                ))}
                {deleteBlockedWorkflows.length > 8 && (
                  <li>…and {deleteBlockedWorkflows.length - 8} more</li>
                )}
              </ul>
            </div>
          )}

          {deleteError && !deleteBlocked && (
            <p className="text-destructive text-sm">{deleteError}</p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Default closes the dialog; we want to keep it open if the
                // 409 response surfaces a list of bound refs the operator
                // needs to act on first.
                e.preventDefault();
                void handleConfirmDelete();
              }}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleting || deleteBlocked}
            >
              {deleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Decision heuristic */}
      <div className="rounded-md border">
        <div className="bg-muted/30 border-b px-4 py-2.5">
          <h3 className="text-sm font-medium">Model Selection Heuristic</h3>
          <p className="text-muted-foreground text-xs">
            Use the task characteristics below to determine the appropriate tier for your agent
            configuration.
          </p>
        </div>
        <table className="w-full text-sm">
          <colgroup>
            <col className="w-[30%]" />
            <col className="w-[15%]" />
            <col className="w-[55%]" />
          </colgroup>
          <thead>
            <tr className="border-b">
              <th className="text-muted-foreground px-4 py-2 text-left text-xs font-medium">
                Task Characteristic
              </th>
              <th className="text-muted-foreground px-4 py-2 text-left text-xs font-medium">
                Recommended Tier
              </th>
              <th className="text-muted-foreground px-4 py-2 text-left text-xs font-medium">
                Rationale
              </th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                [
                  'Complex reasoning or planning',
                  'Thinking',
                  'Frontier models optimise for multi-step logic, decomposition, and long-context synthesis.',
                ],
                [
                  'Execution, summarisation, transforms',
                  'Worker',
                  'Cost-efficient models that handle high-volume parallel tasks without frontier pricing.',
                ],
                [
                  'Latency-sensitive loops or scaling',
                  'Infrastructure',
                  'Ultra-fast inference providers built for throughput over depth.',
                ],
                [
                  'High reliability or compliance',
                  'Control Plane',
                  'Aggregators with automatic fallback, A/B routing, and enterprise SLAs.',
                ],
                [
                  'Privacy or data residency required',
                  'Local / Sovereign',
                  'Self-hosted models that keep data on-premises with no external API calls.',
                ],
                [
                  'Vector embeddings for search',
                  'Embedding',
                  'Specialised models producing dense vectors for semantic retrieval and knowledge bases.',
                ],
              ] as const
            ).map(([characteristic, tier, rationale]) => (
              <tr key={tier} className="border-b last:border-0">
                <td className="px-4 py-2.5 text-sm">{characteristic}</td>
                <td className="px-4 py-2.5">
                  <Badge variant="secondary" className="text-xs">
                    {tier}
                  </Badge>
                </td>
                <td className="text-muted-foreground px-4 py-2.5 text-xs">{rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
