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
 * throw on an ordinary request — a throw here is logged by the proxy and
 * treated as "no answer", which strips the header.
 */
export type TenantResolver = (request: Request) => string | null;

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
 * Ask the registered resolver, or answer `null` when none is registered or
 * the resolver names nothing. A throwing resolver is `null` too — the caller
 * (the proxy) logs it; a request must never 500 because a fork's resolver
 * did.
 */
export function resolveTenantFromRequest(request: Request): string | null {
  if (!resolver) return null;
  try {
    const answer = resolver(request);
    return typeof answer === 'string' && answer.length > 0 ? answer : null;
  } catch {
    return null;
  }
}

/** Test-only: forget the registered resolver. */
export function __resetTenantResolverForTests(): void {
  resolver = null;
}
