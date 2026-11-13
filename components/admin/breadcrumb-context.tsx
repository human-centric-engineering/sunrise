'use client';

/**
 * Breadcrumb label registry (admin).
 *
 * The admin breadcrumb lives in `<AdminHeader>`, which is a *sibling* of the
 * page content (both are rendered by `app/admin/layout.tsx`). A page therefore
 * can't hand the header a human-readable name for its dynamic `[id]` segment
 * through props. This context bridges that gap: a page drops a `<BreadcrumbLabel>`
 * marker that registers `id → name`, and the header reads the registry to render
 * "Northwind Logistics (Demo)" instead of the raw `cmq6kq6un0002oq5n19024sfd`.
 *
 * Several markers may name one segment (a detail layout and a page inside it).
 * Each keeps its own registration, the most recent one is shown, and a marker
 * that unmounts removes only its own, so the others' label stays.
 */

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from 'react';

type LabelMap = Record<string, string>;

/** Every marker's registration for a segment, oldest first. */
type Registrations = Record<string, ReadonlyArray<{ token: string; label: string }>>;

interface BreadcrumbContextValue {
  labels: LabelMap;
  setLabel: (segment: string, token: string, label: string) => void;
  clearLabel: (segment: string, token: string) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const [registrations, setRegistrations] = useState<Registrations>({});

  // A marker that registers again (its label or segment changed) moves to the
  // end, so it is the most recent.
  const setLabel = useCallback((segment: string, token: string, label: string) => {
    setRegistrations((prev) => ({
      ...prev,
      [segment]: [...(prev[segment] ?? []).filter((r) => r.token !== token), { token, label }],
    }));
  }, []);

  const clearLabel = useCallback((segment: string, token: string) => {
    setRegistrations((prev) => {
      const rest = (prev[segment] ?? []).filter((r) => r.token !== token);
      const next = { ...prev };
      if (rest.length > 0) next[segment] = rest;
      else delete next[segment];
      return next;
    });
  }, []);

  // Each segment shows its most recent marker's label: the last one written wins.
  const labels = useMemo(() => {
    const map: LabelMap = {};
    for (const [segment, regs] of Object.entries(registrations)) {
      for (const { label } of regs) map[segment] = label;
    }
    return map;
  }, [registrations]);

  const value = useMemo(() => ({ labels, setLabel, clearLabel }), [labels, setLabel, clearLabel]);

  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

/** Read the registered label overrides keyed by path segment. */
export function useBreadcrumbLabels(): LabelMap {
  return useContext(BreadcrumbContext)?.labels ?? {};
}

/**
 * Register a human-readable label for a path segment (typically a dynamic id).
 * Renders nothing; removes its own registration on unmount so stale names don't
 * linger, and leaves any other marker's for the same segment in place.
 */
export function BreadcrumbLabel({ segment, label }: { segment: string; label: string }) {
  const ctx = useContext(BreadcrumbContext);
  const token = useId();
  // Depend on the stable setter/clearer, NOT the ctx object — the latter gets a
  // new reference whenever labels change, which would re-fire the effect and loop.
  const setLabel = ctx?.setLabel;
  const clearLabel = ctx?.clearLabel;

  useEffect(() => {
    if (!setLabel || !clearLabel) return;
    setLabel(segment, token, label);
    return () => clearLabel(segment, token);
  }, [setLabel, clearLabel, segment, token, label]);

  return null;
}
