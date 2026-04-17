'use client';

/**
 * ProvidersList (Phase 4 Session 4.3)
 *
 * Card grid rendering every provider config. Providers are typically
 * ≤ 6 rows with distinctive state (status dot, local badge, model
 * count) that reads better as cards than a table row.
 *
 * State rules for the status dot:
 *
 *   - **Green** — `apiKeyPresent === true` AND a `ProviderTestButton`
 *     click in the current session returned `ok: true`.
 *   - **Red**  — test-connection returned `ok: false` this session OR
 *     `apiKeyPresent === false` (env var missing on the server).
 *   - **Grey** — not tested yet this session.
 *
 * Test results are held in local state only; we never persist them.
 * The model count is lazy-fetched per card after first paint to
 * avoid blocking the list render on N upstream round trips.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Cpu, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { AiProviderConfig } from '@/types/prisma';
import {
  DeleteProviderDialog,
  type DeleteProviderTarget,
} from '@/components/admin/orchestration/delete-provider-dialog';
import {
  ProviderModelsPanel,
  type ProviderModelInfo,
} from '@/components/admin/orchestration/provider-models-panel';
import { ProviderTestButton } from '@/components/admin/orchestration/provider-test-button';

export interface ProviderRow extends AiProviderConfig {
  apiKeyPresent: boolean;
}

export interface ProvidersListProps {
  initialProviders: ProviderRow[];
}

type StatusDot = 'green' | 'red' | 'grey';

interface ModelCountState {
  count: number | null;
  loading: boolean;
}

export function ProvidersList({ initialProviders }: ProvidersListProps) {
  const [providers, setProviders] = useState<ProviderRow[]>(initialProviders);
  const [modelCounts, setModelCounts] = useState<Record<string, ModelCountState>>({});
  const [testedOk, setTestedOk] = useState<Record<string, boolean | null>>({});
  const [deleteTarget, setDeleteTarget] = useState<DeleteProviderTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [modelsDialogFor, setModelsDialogFor] = useState<ProviderRow | null>(null);

  // Lazy-fetch model counts for every visible provider after mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const p of providers) {
        if (modelCounts[p.id]) continue;
        setModelCounts((prev) => ({ ...prev, [p.id]: { count: null, loading: true } }));
        try {
          const response = await apiClient.get<{ models: ProviderModelInfo[] }>(
            API.ADMIN.ORCHESTRATION.providerModels(p.id)
          );
          if (cancelled) return;
          setModelCounts((prev) => ({
            ...prev,
            [p.id]: { count: response.models?.length ?? 0, loading: false },
          }));
        } catch {
          if (cancelled) return;
          setModelCounts((prev) => ({ ...prev, [p.id]: { count: null, loading: false } }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  const statusFor = useCallback(
    (p: ProviderRow): StatusDot => {
      const tested = testedOk[p.id];
      if (!p.apiKeyPresent && !p.isLocal) return 'red';
      if (tested === true) return 'green';
      if (tested === false) return 'red';
      return 'grey';
    },
    [testedOk]
  );

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.providerById(deleteTarget.id));
      setProviders((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(
        err instanceof APIClientError
          ? err.message
          : "Couldn't delete this provider. Try again in a moment."
      );
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          {providers.length} provider{providers.length === 1 ? '' : 's'} configured
        </p>
        <Button asChild>
          <Link href="/admin/orchestration/providers/new">
            <Plus className="mr-2 h-4 w-4" />
            Add provider
          </Link>
        </Button>
      </div>

      {providers.length === 0 ? (
        <div className="rounded-md border border-dashed py-12 text-center">
          <p className="text-muted-foreground text-sm">No providers configured yet.</p>
          <Button asChild className="mt-4">
            <Link href="/admin/orchestration/providers/new">
              <Plus className="mr-2 h-4 w-4" />
              Add your first provider
            </Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => {
            const status = statusFor(p);
            const dotClass =
              status === 'green'
                ? 'bg-green-500'
                : status === 'red'
                  ? 'bg-red-500'
                  : 'bg-muted-foreground/40';
            const statusLabel =
              status === 'green'
                ? 'Connected'
                : status === 'red'
                  ? !p.apiKeyPresent && !p.isLocal
                    ? 'Key missing'
                    : 'Test failed'
                  : 'Not tested';
            const mc = modelCounts[p.id];

            return (
              <div key={p.id} className="bg-card flex flex-col rounded-lg border shadow-sm">
                {/* ── Header: name + badges + menu ── */}
                <div className="flex items-start gap-2 p-4 pb-0">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold">{p.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {p.isLocal && (
                        <Badge
                          variant="outline"
                          className="text-[10px]"
                          title="Runs locally (e.g. Ollama) — no API key needed, zero cost"
                        >
                          Local
                        </Badge>
                      )}
                      {!p.isActive && (
                        <Badge variant="outline" className="text-[10px]">
                          Inactive
                        </Badge>
                      )}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/admin/orchestration/providers/${p.id}`}>
                          <Pencil className="mr-2 h-4 w-4" /> Edit
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setModelsDialogFor(p)}>
                        <Cpu className="mr-2 h-4 w-4" /> View models
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={() => setDeleteTarget({ id: p.id, name: p.name, slug: p.slug })}
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* ── Meta details ── */}
                <div className="text-muted-foreground space-y-1 px-4 pt-2 pb-3 text-xs">
                  <p className="truncate font-mono">{p.slug}</p>
                  {p.baseUrl && <p className="truncate">{p.baseUrl}</p>}
                  <p>
                    {mc?.loading
                      ? 'Loading models…'
                      : mc && mc.count !== null
                        ? `${mc.count} model${mc.count === 1 ? '' : 's'} available`
                        : '—'}
                  </p>
                </div>

                {/* ── Warning: missing API key ── */}
                {!p.apiKeyPresent && !p.isLocal && (
                  <div className="mx-4 mt-auto mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                    <p className="font-medium">API key not found</p>
                    <p className="mt-0.5">
                      This provider expects a server environment variable called{' '}
                      <code className="rounded bg-red-100 px-1 font-mono dark:bg-red-900/40">
                        {p.apiKeyEnvVar ?? '(not set)'}
                      </code>
                      . Ask your server admin or hosting provider to add it — the app reads it at
                      startup so no secrets are stored in the database.
                    </p>
                  </div>
                )}

                {/* ── Footer: status + test ── */}
                <div
                  className={`${p.apiKeyPresent || p.isLocal ? 'mt-auto' : ''} flex items-center justify-between border-t px-4 py-3`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`}
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground text-xs">{statusLabel}</span>
                  </div>
                  <ProviderTestButton
                    providerId={p.id}
                    onResult={(ok) => setTestedOk((prev) => ({ ...prev, [p.id]: ok }))}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <DeleteProviderDialog
        target={deleteTarget}
        error={deleteError}
        isDeleting={deleting}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
        onConfirm={() => void confirmDelete()}
      />

      <Dialog
        open={!!modelsDialogFor}
        onOpenChange={(open) => {
          if (!open) setModelsDialogFor(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Model catalogue</DialogTitle>
          </DialogHeader>
          {modelsDialogFor && (
            <ProviderModelsPanel
              providerId={modelsDialogFor.id}
              providerName={modelsDialogFor.name}
              isLocal={modelsDialogFor.isLocal}
              apiKeyPresent={modelsDialogFor.apiKeyPresent}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
