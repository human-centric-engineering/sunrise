/**
 * The tenant resolver — how a fork tells the proxy which org a request is
 * for before any session is read (§106; Spike 6 in the design record).
 *
 * A subdomain scheme, a path prefix, a header from an upstream gateway:
 * Sunrise core does not know which, and deliberately ships none. A fork
 * registers ONE resolver from `lib/app/tenant-resolver.ts`; `proxy.ts` calls
 * it on every request and forwards the answer as the `x-sunrise-org` request
 * header, **deleting any inbound copy when there is no answer** — the
 * `x-visitor-id` shape, where the proxy is the header's sole writer and a
 * client cannot smuggle one in. The guard then trusts the header for WHICH
 * org, and still verifies the caller is a member of it: the resolver names a
 * tenant, it never grants access.
 *
 * **Web-standard only.** This module and any resolver run in the proxy, so
 * they may use `Request`, `URL` and `Headers` and nothing else — no `next/*`,
 * no Node builtins, no Prisma (the `lib/app/surface.ts` constraint). A
 * resolver that needs a lookup answers from something it can verify without
 * I/O — a signed cookie, a token, the hostname — and leaves the membership
 * check to the guard. The registry is a module variable rather than the
 * fork-init gate for the same reason: the gate imports the logger, and the
 * proxy's bundle should stay small and dependency-free here.
 */

/** The request header the proxy writes and the guards read. */
export const TENANT_HEADER_NAME = 'x-sunrise-org';

/**
 * Names the org a request is for, or `null` when it cannot say. Must not
 * throw on an ordinary request — a throw is reported to the proxy's
 * `onError` and treated as "no answer", which strips the header.
 */
export type TenantResolver = (request: Request) => string | null;

/**
 * What an org ID may look like on the wire: a cuid, or the literal
 * `install`. (An org's SLUG is not an answer — the guard verifies membership
 * by id — even though a slug-shaped string passes this test.) Bounded and
 * free of anything `Headers.set` would refuse (CR, LF, non-ASCII) — a
 * resolver that derives its answer from an inbound header or cookie could
 * otherwise hand the proxy a value that throws at `set`, which is the 500
 * the resolver's own try/catch exists to prevent.
 */
const ORG_ID_SHAPE = /^[A-Za-z0-9_-]{1,200}$/;

let resolver: TenantResolver | null = null;

/**
 * Register the install's tenant resolver. Called from the fork-owned
 * `registerAppTenantResolver()` scaffold; registering twice replaces the
 * first, and the proxy wires the scaffold once at module scope.
 */
export function registerTenantResolver(next: TenantResolver): void {
  resolver = next;
}

/** True when a fork has registered a resolver. */
export function hasTenantResolver(): boolean {
  return resolver !== null;
}

/**
 * Ask the registered resolver, or answer `null` when none is registered, the
 * resolver names nothing, or its answer is not org-id shaped. A throwing
 * resolver is `null` too, reported through `onError` so the proxy can log
 * it — a request must never 500 because a fork's resolver did, and a
 * resolver that has started throwing must never fail silently either: every
 * request would quietly fall back to the session's org while the hostname
 * says otherwise. This module stays logger-free (it runs in the proxy), so
 * the logging is the caller's.
 */
export function resolveTenantFromRequest(
  request: Request,
  onError?: (error: unknown) => void
): string | null {
  if (!resolver) return null;
  try {
    const answer = resolver(request);
    if (answer === null || answer === undefined) return null;
    if (typeof answer === 'string' && ORG_ID_SHAPE.test(answer)) return answer;
    // A malformed answer is the same silent fallback a throw would be —
    // every request for that tenant lands in the session's org — so it is
    // reported the same way, with the shape named and the value withheld.
    onError?.(
      new Error(
        `Tenant resolver answered a value that is not org-id shaped (${typeof answer}, ${
          typeof answer === 'string' ? answer.length : 0
        } chars; expected [A-Za-z0-9_-]{1,200}); treated as no answer`
      )
    );
    return null;
  } catch (error) {
    onError?.(error);
    return null;
  }
}

/** Test-only: forget the registered resolver. */
export function __resetTenantResolverForTests(): void {
  resolver = null;
}
