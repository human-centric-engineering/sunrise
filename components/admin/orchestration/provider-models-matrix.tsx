'use client';

/**
 * Provider Model Matrix
 *
 * Flat, filterable table showing per-model analysis with chat/embedding badges,
 * sortable columns, and provider/tier/capability filters.
 */

import Link from 'next/link';
import React, { useCallback, useMemo, useState } from 'react';
import { ArrowUpDown, ClipboardCheck, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import { FieldHelp } from '@/components/ui/field-help';
import { AuditModelsDialog } from '@/components/admin/orchestration/audit-models-dialog';
import { TIER_ROLE_META, type TierRole } from '@/types/orchestration';

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

function capabilityBadge(capabilities: string[]) {
  const hasChat = capabilities.includes('chat');
  const hasEmbedding = capabilities.includes('embedding');

  if (hasChat && hasEmbedding) {
    return (
      <Badge
        variant="outline"
        className="bg-violet-100 text-xs text-violet-800 dark:bg-violet-900 dark:text-violet-200"
      >
        Both
      </Badge>
    );
  }
  if (hasEmbedding) {
    return (
      <Badge
        variant="outline"
        className="bg-amber-100 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200"
      >
        Embedding
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="bg-sky-100 text-xs text-sky-800 dark:bg-sky-900 dark:text-sky-200"
    >
      Chat
    </Badge>
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
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [capabilityFilter, setCapabilityFilter] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('providerSlug');
  const [auditOpen, setAuditOpen] = useState(false);
  const [sortAsc, setSortAsc] = useState(true);

  const providers = useMemo(
    () => [...new Set(initialModels.map((m) => m.providerSlug))].sort(),
    [initialModels]
  );

  const tiers = useMemo(
    () => [...new Set(initialModels.map((m) => m.tierRole))].sort(),
    [initialModels]
  );

  const filtered = useMemo(() => {
    let rows = initialModels.filter((m) => m.isActive);
    if (providerFilter !== 'all') rows = rows.filter((m) => m.providerSlug === providerFilter);
    if (tierFilter !== 'all') rows = rows.filter((m) => m.tierRole === tierFilter);
    if (capabilityFilter !== 'all')
      rows = rows.filter((m) => m.capabilities.includes(capabilityFilter));

    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const aScore = RATING_ORDER[av] ?? 0;
      const bScore = RATING_ORDER[bv] ?? 0;
      if (aScore !== bScore) return sortAsc ? aScore - bScore : bScore - aScore;
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });

    return rows;
  }, [initialModels, providerFilter, tierFilter, capabilityFilter, sortKey, sortAsc]);

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
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p} value={p} className="capitalize">
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

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

        <Select value={capabilityFilter} onValueChange={setCapabilityFilter}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="chat">Chat</SelectItem>
            <SelectItem value="embedding">Embedding</SelectItem>
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-3">
          <p className="text-muted-foreground text-sm">
            {filtered.length} model{filtered.length !== 1 ? 's' : ''}
          </p>
          <Button variant="outline" onClick={() => setAuditOpen(true)}>
            <ClipboardCheck className="mr-2 h-4 w-4" />
            Review Models
          </Button>
          <FieldHelp title="AI-Powered Model Audit">
            Triggers the Provider Model Audit workflow — a real orchestration workflow execution via{' '}
            <code>POST /workflows/:id/execute</code>. The audit evaluates your model entries for
            accuracy, proposes changes, and pauses for your approval before applying them. This also
            serves as a framework reference implementation, exercising 10 of 15 step types
            end-to-end.
          </FieldHelp>
          <Button asChild>
            <Link href="/admin/orchestration/provider-models/new">
              <Plus className="mr-2 h-4 w-4" />
              Add model
            </Link>
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
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-muted-foreground py-8 text-center">
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
                    {!model.isDefault && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        Custom
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{capabilityBadge(model.capabilities)}</TableCell>
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
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Audit dialog */}
      <AuditModelsDialog open={auditOpen} onOpenChange={setAuditOpen} models={initialModels} />

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
