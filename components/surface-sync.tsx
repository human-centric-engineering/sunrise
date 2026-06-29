'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

import { classifySurface } from '@/lib/app/surface';

/**
 * Keeps `<html data-surface>` in sync with the current route on client-side
 * navigation.
 *
 * The root layout sets the attribute once from the proxy's `x-surface` header —
 * correct on a hard load and for first-paint portal theming. But the root
 * `<html>` persists across App Router navigations (the root layout does not
 * re-render), so without this the attribute would stay stuck at whatever the
 * first-loaded page was — e.g. a consumer page's fork theme bleeding into
 * `/admin`. This re-derives the surface from the pathname after each navigation
 * and updates the attribute. Renders nothing.
 *
 * Timing: the update runs in `useEffect` (after paint), so a client-side nav
 * between two DIFFERENTLY-themed surfaces can show one frame of the old theme.
 * Vanilla Sunrise ships an empty `app/brand-theme.css`, so there is no theme
 * delta and no visible flash. A fork that fills brand-theme.css and wants the
 * flash gone can swap to a guarded layout-effect:
 *
 *     const useIsomorphicLayoutEffect =
 *       typeof window !== 'undefined' ? useLayoutEffect : useEffect;
 *     useIsomorphicLayoutEffect(() => { ... }, [pathname]);
 *
 * (The guard avoids React's "useLayoutEffect does nothing on the server" warning
 * during SSR.) See `.context/ui/surface-theming.md`.
 */
export function SurfaceSync(): null {
  const pathname = usePathname();

  useEffect(() => {
    document.documentElement.dataset.surface = classifySurface(pathname);
  }, [pathname]);

  return null;
}
