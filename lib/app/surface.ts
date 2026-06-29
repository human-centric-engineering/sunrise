/**
 * Rendering-surface classification (fork-owned policy seam).
 *
 * A pure string predicate shared by the proxy (server-side, sets the `x-surface`
 * header for the first paint) and `SurfaceSync` (client-side, keeps
 * `<html data-surface>` correct across App Router navigations) so the two can
 * never drift. `/admin` is the only non-consumer URL segment in vanilla Sunrise
 * — route groups like `(public)` / `(protected)` don't affect the URL — so this
 * single prefix classifies the whole app into two surfaces.
 *
 * This is the ONE place a fork sets its surface policy. To put admin on the
 * consumer theme too, return `'consumer'` unconditionally; to add a third
 * surface, widen `Surface` and the predicate (and add a matching scope in
 * `app/brand-theme.css`). A descendant subtree can also override the inherited
 * surface by setting its own `data-surface` attribute — see the docs.
 *
 * Boundary-clean: no `next/*` imports, just a string check, so it's safe in the
 * proxy/edge runtime, on the client, and within the `lib/app/**` boundary.
 *
 * See `.context/ui/surface-theming.md` for the full mechanism and the six
 * design constraints behind it.
 */
export type Surface = 'admin' | 'consumer';

export function classifySurface(pathname: string): Surface {
  // Exact `/admin` or a `/admin/` descendant — not a `/admin`-prefixed sibling
  // like `/administrators`, which is consumer.
  return pathname === '/admin' || pathname.startsWith('/admin/') ? 'admin' : 'consumer';
}
