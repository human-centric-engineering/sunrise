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
 *   - **Green** — `/test` returned `ok: true`, either from an automatic
 *     probe on mount or a manual `ProviderTestButton` click.
 *   - **Red**  — `/test` returned `ok: false` OR `apiKeyPresent === false`
 *     on a non-local provider.
 *   - **Blue (pulsing)** — automatic probe in flight.
 *   - **Grey** — not tested (no API key check pending; rare in practice
 *     because the auto-probe fires immediately on mount).
 *
 * On mount, every provider with an API key (or `isLocal`) is auto-probed
 * via `POST /providers/:id/test`. The probe is cached for 10 minutes via
 * `provider-test-cache` so repeat visits and form-edit round-trips don't
 * cause a request storm.
 * The model count is lazy-fetched per card after first paint with a
 * 60-second client-side cache to avoid redundant N+1 fetches.
 *
 * Additional card features:
 *   - **Circuit breaker badge** — orange/yellow warning when the
 *     breaker is open or half-open, with a Reset button.
 *   - **Reactivate** — dropdown action for inactive providers;
 *     PATCHes `{ isActive: true }` without navigating to the form.
 *   - **Soft-delete** — confirmation dialog sets `isActive = false`;
 *     the card stays visible with an Inactive badge.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Cpu,
  MoreHorizontal,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RotateCcw,
  Trash2,
} from 'lucide-react';

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
  PermanentDeleteProviderDialog,
  type PermanentDeleteTarget,
} from '@/components/admin/orchestration/permanent-delete-provider-dialog';
import {
  ProviderModelsPanel,
  type ProviderModelInfo,
} from '@/components/admin/orchestration/provider-models-panel';
import { ProviderDetectionsBanner } from '@/components/admin/orchestration/provider-detections-banner';
import { ProviderTestButton } from '@/components/admin/orchestration/provider-test-button';
import {
  clearCachedTestResult,
  getCachedTestResult,
  setCachedTestResult,
} from '@/lib/orchestration/provider-test-cache';

export interface ProviderRow extends AiProviderConfig {
  apiKeyPresent: boolean;
  circuitBreaker?: {
    state: 'closed' | 'open' | 'half-open';
    failureCount: number;
    openedAt: string | null;
  };
}

export interface ProvidersListProps {
  initialProviders: ProviderRow[];
}

type StatusDot = 'green' | 'red' | 'grey' | 'testing';

interface ModelCountCache {
  count: number | null;
  fetchedAt: number;
}

// Module-level model count cache with 60s TTL
const modelCountCache = new Map<string, ModelCountCache>();
const MODEL_CACHE_TTL_MS = 60_000;

function getCachedModelCount(providerId: string): number | null | undefined {
  const cached = modelCountCache.get(providerId);
  if (!cached) return undefined;
  if (Date.now() - cached.fetchedAt > MODEL_CACHE_TTL_MS) {
    modelCountCache.delete(providerId);
    return undefined;
  }
  return cached.count;
}

interface ModelCountState {
  count: number | null;
  loading: boolean;
}

export function ProvidersList({ initialProviders }: ProvidersListProps) {
  const router = useRouter();
  const [providers, setProviders] = useState<ProviderRow[]>(initialProviders);

  // The server component (`app/admin/orchestration/providers/page.tsx`)
  // serves the initial list via `serverFetch`. If the parent route
  // gets revalidated (router.refresh), Next 16's data cache hands us
  // a fresh `initialProviders` prop. Mirror that into local state so
  // the grid actually updates without a full page reload.
  useEffect(() => {
    setProviders(initialProviders);
  }, [initialProviders]);
  const [modelCounts, setModelCounts] = useState<Record<string, ModelCountState>>({});
  // Hydrate from the localStorage test cache so the dot colour survives
  // navigation. Server components can't read localStorage so we seed
  // with `() => initialState` to read on first client render only.
  const [testedOk, setTestedOk] = useState<Record<string, boolean | null>>(() => {
    if (typeof window === 'undefined') return {};
    const seed: Record<string, boolean | null> = {};
    for (const p of initialProviders) {
      const cached = getCachedTestResult(p.id);
      if (cached) seed[p.id] = cached.ok;
    }
    return seed;
  });
  const [deleteTarget, setDeleteTarget] = useState<DeleteProviderTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [permanentTarget, setPermanentTarget] = useState<PermanentDeleteTarget | null>(null);
  const [permanentDeleting, setPermanentDeleting] = useState(false);
  const [permanentError, setPermanentError] = useState<string | null>(null);
  const [modelsDialogFor, setModelsDialogFor] = useState<ProviderRow | null>(null);
  const [reactivateError, setReactivateError] = useState<string | null>(null);
  const [resettingBreaker, setResettingBreaker] = useState<Record<string, boolean>>({});
  const [breakerError, setBreakerError] = useState<string | null>(null);
  const [testingInFlight, setTestingInFlight] = useState<Record<string, boolean>>({});

  // Lazy-fetch model counts for every visible provider after mount.
  // Uses module-level cache to avoid N+1 on every page navigation.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const p of providers) {
        if (modelCounts[p.id]) continue;

        // Check cache first
        const cached = getCachedModelCount(p.id);
        if (cached !== undefined) {
          setModelCounts((prev) => ({ ...prev, [p.id]: { count: cached, loading: false } }));
          continue;
        }

        setModelCounts((prev) => ({ ...prev, [p.id]: { count: null, loading: true } }));
        try {
          const response = await apiClient.get<{ models: ProviderModelInfo[] }>(
            API.ADMIN.ORCHESTRATION.providerModels(p.id)
          );
          if (cancelled) return;
          const count = response.models?.length ?? 0;
          modelCountCache.set(p.id, { count, fetchedAt: Date.now() });
          setModelCounts((prev) => ({
            ...prev,
            [p.id]: { count, loading: false },
          }));
        } catch {
          if (cancelled) return;
          modelCountCache.set(p.id, { count: null, fetchedAt: Date.now() });
          setModelCounts((prev) => ({ ...prev, [p.id]: { count: null, loading: false } }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  // Auto-test every provider on mount that doesn't already have a
  // cached result. The manual `Test connection` button hits the exact
  // same `/test` route, which delegates to `provider.testConnection()` —
  // for OpenAI-compatible providers that's a real `listModels` round-trip,
  // for Anthropic it's a `messages.create` ping with `max_tokens: 1`.
  // Both are valid connectivity probes for their respective vendors,
  // so firing this once on landing gives every card an honest dot
  // without the operator having to click through.
  //
  // Skip rules:
  //   - No API key on a non-local provider — already shown red, would
  //     just produce a guaranteed `ok: false`.
  //   - Cached result exists — the localStorage cache (`provider-test-
  //     cache`, 10-min TTL) seeded `testedOk` at construction time.
  //   - Already in flight — guard against the effect re-running before
  //     the first round of requests resolves.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const targets = providers.filter(
        (p) =>
          (p.apiKeyPresent || p.isLocal) && testedOk[p.id] === undefined && !testingInFlight[p.id]
      );
      if (targets.length === 0) return;

      setTestingInFlight((prev) => {
        const next = { ...prev };
        for (const p of targets) next[p.id] = true;
        return next;
      });

      await Promise.all(
        targets.map(async (p) => {
          try {
            const response = await apiClient.post<{ ok: boolean; models?: string[] }>(
              API.ADMIN.ORCHESTRATION.providerTest(p.id)
            );
            if (cancelled) return;
            const ok = !!response.ok;
            const modelCount = response.models?.length ?? 0;
            setCachedTestResult(p.id, { ok, modelCount });
            setTestedOk((prev) => ({ ...prev, [p.id]: ok }));
          } catch {
            if (cancelled) return;
            // Same shape as a failed test — server already sanitizes
            // raw SDK errors before they reach us.
            setCachedTestResult(p.id, { ok: false, modelCount: 0 });
            setTestedOk((prev) => ({ ...prev, [p.id]: false }));
          } finally {
            if (!cancelled) {
              setTestingInFlight((prev) => {
                const next = { ...prev };
                delete next[p.id];
                return next;
              });
            }
          }
        })
      );
    })();
    return () => {
      cancelled = true;
    };
    // `testedOk` and `testingInFlight` are intentionally read but not
    // listed — re-running on every state update would cause a request
    // storm. The `providers` dependency captures the only change that
    // should trigger a fresh round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  const statusFor = useCallback(
    (p: ProviderRow): StatusDot => {
      const tested = testedOk[p.id];
      if (!p.apiKeyPresent && !p.isLocal) return 'red';
      if (tested === true) return 'green';
      if (tested === false) return 'red';
      if (testingInFlight[p.id]) return 'testing';
      return 'grey';
    },
    [testedOk, testingInFlight]
  );

  // Re-fetch the provider list and replace local state. Called by the
  // detection banner after a one-click "Configure" so the new provider
  // shows up in the grid without a full page reload.
  //
  // We do TWO things in tandem:
  //
  //   1. `cache: 'no-store'` on the immediate refetch so the browser /
  //      Next 16 fetch layer doesn't hand back a cached "no providers"
  //      response that pre-dates the just-created row.
  //
  //   2. `router.refresh()` so Next's server-component data cache for
  //      this route is invalidated and a future navigation reads fresh
  //      `initialProviders`. Without this, navigating away and back
  //      could still show the stale empty state.
  const refreshProviders = useCallback(async () => {
    try {
      const res = await fetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=50`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) return;
      const body = (await res.json()) as { success?: boolean; data?: ProviderRow[] };
      if (body.success && Array.isArray(body.data)) {
        setProviders(body.data);
      }
    } catch {
      // Silent — the banner already showed any error from the create call.
    } finally {
      router.refresh();
    }
  }, [router]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.providerById(deleteTarget.id));
      // Soft-delete flips isActive=false; clear the cached test result
      // so the row's dot doesn't keep showing green after deactivation.
      clearCachedTestResult(deleteTarget.id);
      setTestedOk((prev) => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      setProviders((prev) =>
        prev.map((p) => (p.id === deleteTarget.id ? { ...p, isActive: false } : p))
      );
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

  const confirmPermanentDelete = useCallback(async () => {
    if (!permanentTarget) return;
    setPermanentDeleting(true);
    setPermanentError(null);
    try {
      // Hits the same DELETE /providers/:id route with ?permanent=true.
      // The server returns 409 with a clear message if any agent or
      // cost-log row still references the slug; that message gets
      // surfaced verbatim in the dialog so the operator knows what to
      // re-point first.
      await apiClient.delete(
        `${API.ADMIN.ORCHESTRATION.providerById(permanentTarget.id)}?permanent=true`
      );
      clearCachedTestResult(permanentTarget.id);
      setTestedOk((prev) => {
        const next = { ...prev };
        delete next[permanentTarget.id];
        return next;
      });
      // Drop the row from local state — the server actually deleted it.
      setProviders((prev) => prev.filter((p) => p.id !== permanentTarget.id));
      setPermanentTarget(null);
    } catch (err) {
      setPermanentError(
        err instanceof APIClientError
          ? err.message
          : "Couldn't permanently delete this provider. Try again in a moment."
      );
    } finally {
      setPermanentDeleting(false);
    }
  }, [permanentTarget]);

  const handleReactivate = useCallback(async (providerId: string) => {
    setReactivateError(null);
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.providerById(providerId), {
        body: { isActive: true },
      });
      // Reactivation could mean the operator changed env vars / base
      // URL since the last test ran — invalidate so the dot defaults to
      // grey until they retest.
      clearCachedTestResult(providerId);
      setTestedOk((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      setProviders((prev) => prev.map((p) => (p.id === providerId ? { ...p, isActive: true } : p)));
    } catch (err) {
      setReactivateError(
        err instanceof APIClientError
          ? err.message
          : "Couldn't reactivate this provider. Try again in a moment."
      );
    }
  }, []);

  const handleResetBreaker = useCallback(async (providerId: string) => {
    setResettingBreaker((prev) => ({ ...prev, [providerId]: true }));
    setBreakerError(null);
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.providerHealth(providerId), {});
      // Breaker reset means recent failures have been forgiven —
      // invalidate the cached test result so the operator runs a fresh
      // check rather than trusting an old "tested OK" from before the
      // failures.
      clearCachedTestResult(providerId);
      setTestedOk((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      setProviders((prev) =>
        prev.map((p) =>
          p.id === providerId
            ? { ...p, circuitBreaker: { state: 'closed', failureCount: 0, openedAt: null } }
            : p
        )
      );
    } catch (err) {
      setBreakerError(
        err instanceof APIClientError
          ? err.message
          : "Couldn't reset the circuit breaker. Try again in a moment."
      );
    } finally {
      setResettingBreaker((prev) => ({ ...prev, [providerId]: false }));
    }
  }, []);

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

      <ProviderDetectionsBanner
        onProviderCreated={() => {
          void refreshProviders();
        }}
      />

      {reactivateError && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {reactivateError}
        </div>
      )}

      {breakerError && (
        <div className="rounded-md border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
          {breakerError}
        </div>
      )}

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
                  : status === 'testing'
                    ? 'bg-blue-500 animate-pulse'
                    : 'bg-muted-foreground/40';
            const statusLabel =
              status === 'green'
                ? 'Connected'
                : status === 'red'
                  ? !p.apiKeyPresent && !p.isLocal
                    ? 'Key missing'
                    : 'Test failed'
                  : status === 'testing'
                    ? 'Testing…'
                    : 'Not tested';
            const mc = modelCounts[p.id];
            const breakerState = p.circuitBreaker?.state ?? 'closed';

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
                        <Badge
                          variant="outline"
                          className="border-amber-300 bg-amber-50 text-[10px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
                        >
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
                      {!p.isActive && (
                        <DropdownMenuItem onSelect={() => void handleReactivate(p.id)}>
                          <Power className="mr-2 h-4 w-4" /> Reactivate
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => setModelsDialogFor(p)}>
                        <Cpu className="mr-2 h-4 w-4" /> View models
                      </DropdownMenuItem>
                      {p.isActive && (
                        <DropdownMenuItem
                          onSelect={() => setDeleteTarget({ id: p.id, name: p.name, slug: p.slug })}
                        >
                          <PowerOff className="mr-2 h-4 w-4" /> Deactivate
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={() =>
                          setPermanentTarget({ id: p.id, name: p.name, slug: p.slug })
                        }
                      >
                        <Trash2 className="mr-2 h-4 w-4" /> Delete permanently
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

                {/* ── Circuit breaker warning ── */}
                {breakerState !== 'closed' && (
                  <div
                    className={`mx-4 mb-3 flex items-center justify-between rounded-md border px-3 py-2 text-xs ${
                      breakerState === 'open'
                        ? 'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200'
                        : 'border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {breakerState === 'open' ? 'Circuit open' : 'Circuit half-open'}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={resettingBreaker[p.id]}
                      onClick={() => void handleResetBreaker(p.id)}
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />
                      Reset
                    </Button>
                  </div>
                )}

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

      <PermanentDeleteProviderDialog
        target={permanentTarget}
        error={permanentError}
        isDeleting={permanentDeleting}
        onCancel={() => {
          setPermanentTarget(null);
          setPermanentError(null);
        }}
        onConfirm={() => void confirmPermanentDelete()}
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
