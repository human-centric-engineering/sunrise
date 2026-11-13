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
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

type LabelMap = Record<string, string>;

interface BreadcrumbContextValue {
  labels: LabelMap;
  setLabel: (segment: string, label: string) => void;
  clearLabel: (segment: string) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

export function BreadcrumbProvider({ children }: { children: React.ReactNode }) {
  const [labels, setLabels] = useState<LabelMap>({});

  const setLabel = useCallback((segment: string, label: string) => {
    setLabels((prev) => (prev[segment] === label ? prev : { ...prev, [segment]: label }));
  }, []);

  const clearLabel = useCallback((segment: string) => {
    setLabels((prev) => {
      if (!(segment in prev)) return prev;
      const next = { ...prev };
      delete next[segment];
      return next;
    });
  }, []);

  const value = useMemo(() => ({ labels, setLabel, clearLabel }), [labels, setLabel, clearLabel]);

  return <BreadcrumbContext.Provider value={value}>{children}</BreadcrumbContext.Provider>;
}

/** Read the registered label overrides keyed by path segment. */
export function useBreadcrumbLabels(): LabelMap {
  return useContext(BreadcrumbContext)?.labels ?? {};
}

/**
 * Register a human-readable label for a path segment (typically a dynamic id).
 * Renders nothing; cleans up on unmount so stale names don't linger.
 */
export function BreadcrumbLabel({ segment, label }: { segment: string; label: string }) {
  const ctx = useContext(BreadcrumbContext);
  // Depend on the stable setter/clearer, NOT the ctx object — the latter gets a
  // new reference whenever labels change, which would re-fire the effect and loop.
  const setLabel = ctx?.setLabel;
  const clearLabel = ctx?.clearLabel;

  useEffect(() => {
    if (!setLabel || !clearLabel) return;
    setLabel(segment, label);
    return () => clearLabel(segment);
  }, [setLabel, clearLabel, segment, label]);

  return null;
}
