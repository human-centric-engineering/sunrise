/**
 * API Route Auth Guards
 *
 * Higher-order functions that wrap API route handlers with authentication
 * and authorization checks. Eliminates duplicated session/role boilerplate
 * across route handlers.
 *
 * Usage:
 * ```typescript
 * // Admin-only route
 * export const GET = withAdminAuth(async (request, session) => {
 *   // session is guaranteed to be an authenticated admin
 *   return successResponse({ data: '...' });
 * });
 *
 * // Any authenticated user
 * export const GET = withAuth(async (request, session) => {
 *   return successResponse({ user: session.user });
 * });
 * ```
 *
 * Error handling is automatic — handlers don't need try/catch for auth
 * or unhandled errors. All errors are routed through handleAPIError.
 */

import { NextRequest } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { UnauthorizedError, ForbiddenError, handleAPIError } from '@/lib/api/errors';
import {
  resolveApiKey,
  hasScope,
  listValidApiKeyScopes,
  type ApiKeyScope,
} from '@/lib/auth/api-keys';
import { logger } from '@/lib/logging';
import {
  canAdminister,
  canRead,
  readTargetFor,
  type AuthorizationPrincipal,
  type AuthorizationResource,
} from '@/lib/auth/authorization';

/**
 * Session type from better-auth (matches AuthSession in utils.ts)
 */
export interface AuthSession {
  session: {
    id: string;
    userId: string;
    token: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
    role?: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

/**
 * What a guard hands its handler: the session, plus the principal the guard
 * **actually used** for its own authorization decision.
 *
 * `principal` is not a convenience. `subjectScope()` — the list face of the
 * authorization policy — needs a principal, and before this existed a handler
 * could not build the right one: `principalOf` is private, and the credential
 * kind and an API key's scopes are known only inside the guard. `AuthSession`
 * carries neither.
 *
 * A handler that reconstructed one got it **wrong in the widening direction**.
 * `administersEverything()` branches on `credential` and `scopes`: an
 * `api-key` principal is judged by `hasScope(scopes, 'admin')`, a `session`
 * principal by the platform role. `withAuth` accepts a key of any scope, so
 * assuming `credential: 'session'` means a `chat`-scoped key held by a user
 * whose role is `ADMIN` is judged by the role — `subjectScope` answers `{}`
 * (every subject) where it should answer `{ userId }`. That is the credential
 * narrowing #542 exists to hold, undone by a plausible-looking helper.
 *
 * It was also invisible to `checkAuthorizationParity`: the guard asked
 * `canRead` with the true principal while the handler asked `subjectScope` with
 * a reconstruction, so the two faces disagreed **at the call site** for a policy
 * the checker passes clean. One principal, built once, removes that class.
 *
 * It rides on the session rather than on the route context because `context` is
 * `undefined` for a non-dynamic route — and a list endpoint is precisely where
 * `subjectScope` is called.
 *
 * Additive: a handler typed `(request, session: AuthSession)` still compiles,
 * because `AuthenticatedSession` is assignable to `AuthSession`.
 */
export interface AuthenticatedSession extends AuthSession {
  principal: AuthorizationPrincipal;
}

/**
 * Next.js route params context shape
 */
export interface RouteContext<TParams = Record<string, string>> {
  params: Promise<TParams>;
}

/**
 * Tells the authorization policy **what** a request is acting on.
 *
 * Without one, the policy is asked about the caller and nothing else, which is
 * all Sunrise's own policy needs on all but one route — `app/api/v1/users/[id]`
 * (GET) supplies one, and is the worked example.
 * A fork scoping by owner (#367) or by org (§106) needs the resource, and the
 * alternative to this hook is rewriting every handler's signature to pass it
 * down.
 *
 * **Naming no resource DENIES.** Returning `null` or `undefined` — or throwing —
 * refuses the request; it does not mean "this route is unscoped". Those are
 * opposite answers and the guard cannot tell them apart from the outside, so the
 * one that is safe to guess wrong is the refusal. The permissive state is
 * reached by not declaring a resolver at all, which is a decision visible in the
 * route's source rather than in a row that happened to be missing. Do not add a
 * resolver to a route that does not act on a resource.
 *
 * That matters most for the shape below: a `findUnique` returns `null` for a row
 * that was deleted, or that the resolver's own `where` excluded. Under the
 * opposite convention that request would run the handler with no ownership check
 * at all, on a route that looks scoped in the diff and in the log.
 *
 * **Runs before the authorization decision**, not merely before the handler —
 * the policy cannot be asked about a resource that has not been resolved. So on
 * an admin route the resolver is reachable by any *authenticated* caller,
 * including one the policy is about to refuse. Treat its input as hostile: key
 * off the URL segment, select the few columns the policy needs, and do not do
 * expensive or side-effecting work in it.
 *
 * ```ts
 * export const GET = withAuth<{ id: string }>(handler, {
 *   resource: async (_request, context) => {
 *     const { id } = await context!.params;
 *     const row = await prisma.thing.findUnique({ where: { id }, select: { createdBy: true } });
 *     // `null` here refuses the request, which is what a missing row deserves.
 *     // `createdBy` is nullable on a SetNull model, and an absent `ownerId`
 *     // reaches `canRead` as its own state — answer it in your policy.
 *     return row ? { kind: 'thing', id, ownerId: row.createdBy ?? undefined } : null;
 *   },
 * });
 * ```
 */
export type AuthorizationResourceResolver<TParams = Record<string, string>> = (
  request: NextRequest,
  context?: RouteContext<TParams>
) => AuthorizationResource | null | Promise<AuthorizationResource | null>;

/** Options for `withAuth`. */
export interface WithAuthOptions<TParams = Record<string, string>> {
  /**
   * Names the resource this route acts on, for the authorization policy.
   *
   * Sunrise's default policy reads the resolved `ownerId` as the **subject** of
   * the request and asks `canRead`. Omitting it is behaviour-neutral: the policy
   * is asked about `{ kind: 'nothing' }`, which the default allows.
   *
   * **Adding one is not.** Declaring a resolver moves the decision to the
   * policy, and the policy does not answer identically to a hand-written role
   * check — most visibly, it judges an API-key caller by the key's scopes rather
   * than by its owner's role. `app/api/v1/users/[id]` (GET) is the worked
   * example and its CHANGELOG entry lists what changed. Treat adding a resolver
   * to a shipped endpoint as a behaviour change and test it as one.
   */
  resource?: AuthorizationResourceResolver<TParams>;
  /**
   * Scope an **API-key** caller must hold. A cookie session is unaffected — it
   * is the full user, and scopes exist to make a *credential* narrower than the
   * user it belongs to.
   *
   * Without this, `withAuth` accepted a key of any scope, so a key minted for
   * one narrow job also reached every other authenticated route as its owner
   * (#542). A wider scope list without this option would just be labels: the
   * two together are what make a scope mean something.
   *
   * Opt-in per route. Core routes deliberately do NOT set it yet — adding a
   * requirement to a shipped endpoint would revoke access from keys that work
   * today. New routes, and fork routes using a fork scope, should.
   *
   * `admin` satisfies any scope (see `hasScope`).
   */
  scope?: ApiKeyScope;
}

/** Options for `withAdminAuth`. */
export interface WithAdminAuthOptions<TParams = Record<string, string>> {
  /**
   * Names the resource being administered, for the authorization policy.
   *
   * `withAdminAuth` takes no resource context otherwise, so a policy could not
   * scope even with the decision extracted — "admin of THIS org" needs to know
   * which org. Sunrise's default policy ignores it; with no resolver the policy
   * is handed `null`, which is the same call it gets today.
   */
  resource?: AuthorizationResourceResolver<TParams>;
}

/**
 * Describe the caller to the authorization policy.
 *
 * The credential kind is passed rather than sniffed, because the guard already
 * knows it: it is in the API-key branch or it is not. `isApiKeySession()` exists
 * for callers downstream that only hold a session.
 */
function principalOf(
  session: AuthSession,
  credential: AuthorizationPrincipal['credential'],
  scopes?: readonly string[]
): AuthorizationPrincipal {
  return { userId: session.user.id, role: session.user.role, credential, scopes };
}

/**
 * Run a route's resource resolver, or answer `null` when it has none.
 *
 * **Two outcomes are unresolved, not one**, and both deny. A resolver that
 * throws is the obvious one. A resolver that RETURNS nothing is the one that
 * looks harmless: a `findUnique` answering `null` for a deleted or filtered row
 * is the single most likely thing a real resolver does, and reading that as
 * "this route named nothing" hands the policy the same value a route with no
 * resolver at all produces — which the default policy permits. The handler would
 * then run with no ownership check on a route that looks scoped in the diff and
 * in the log.
 *
 * So `UNRESOLVED` is a Symbol distinct from `null`, and only the guard's own
 * "this route declared no resolver" path yields `null`. A resolver cannot forge
 * either: it can return an object, or it cannot, and both are answered here.
 */
const UNRESOLVED = Symbol('resource-unresolved');

async function resolveResource(
  resolver: AuthorizationResourceResolver | undefined,
  request: NextRequest,
  context: RouteContext | undefined
): Promise<AuthorizationResource | null | typeof UNRESOLVED> {
  if (!resolver) return null;
  try {
    const resource = await resolver(request, context);
    if (!resource) {
      logger.warn('authorization: a route resource resolver named nothing — denying the request', {
        path: request.nextUrl?.pathname,
        fix: 'Returning null/undefined from a resource resolver refuses the request; it does not mean "unscoped". A route that acts on no resource should not declare a resolver.',
      });
      return UNRESOLVED;
    }
    return resource;
  } catch (error) {
    logger.error('authorization: a route resource resolver threw — denying the request', {
      path: request.nextUrl?.pathname,
      error: error instanceof Error ? error.message : String(error),
      fix: 'The policy cannot be asked about a resource that could not be resolved, and an unresolved scope is not an absent one.',
    });
    return UNRESOLVED;
  }
}

/**
 * Wrap an API route handler with authentication.
 *
 * - Retrieves the session from better-auth
 * - Throws UnauthorizedError (401) if no session
 * - Throws ForbiddenError (403) if `options.scope` is set and an API-key
 *   caller lacks it
 * - Asks the authorization policy `canRead(principal, target)`, where the target
 *   comes from `options.resource` — or `{ kind: 'nothing' }` when the route
 *   named none, which the default policy allows. Every core route but
 *   `app/api/v1/users/[id]` (GET) takes that arm
 * - Passes the session to the handler
 * - Catches all errors via handleAPIError
 *
 * @example
 * ```typescript
 * // Simple authenticated route (no params)
 * export const GET = withAuth(async (request, session) => {
 *   const user = await prisma.user.findUnique({ where: { id: session.user.id } });
 *   return successResponse(user);
 * });
 *
 * // Route with dynamic params
 * export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
 *   const { id } = await params;
 *   return successResponse({ id });
 * });
 *
 * // Reachable by a browser session, or by an API key scoped `capture`
 * export const POST = withAuth(handler, { scope: 'capture' });
 * ```
 */
export function withAuth(
  handler: (request: NextRequest, session: AuthenticatedSession) => Response | Promise<Response>,
  options?: WithAuthOptions
): (request: NextRequest) => Promise<Response>;

export function withAuth<TParams>(
  handler: (
    request: NextRequest,
    session: AuthenticatedSession,
    context: RouteContext<TParams>
  ) => Response | Promise<Response>,
  options?: WithAuthOptions<TParams>
): (request: NextRequest, context: RouteContext<TParams>) => Promise<Response>;

export function withAuth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Response | Promise<Response>,
  options?: WithAuthOptions
) {
  // Opening `ApiKeyScope` to `CoreApiKeyScope | (string & {})` is what lets a
  // fork name its own scope — and it also means `{ scope: 'knowlege' }`
  // type-checks. No user can ever hold a scope nothing declared, so the route
  // would 403 every non-`admin` key forever, and the 403 deliberately does not
  // echo the key's scopes, leaving nothing to diagnose from the outside.
  //
  // Warned at route-definition time rather than per request, so it surfaces at
  // boot even if nobody calls the endpoint. Not an error: a fork may legitimately
  // define a route before filling `lib/app/api-key-scopes.ts`.
  if (options?.scope && !listValidApiKeyScopes().includes(options.scope)) {
    logger.warn('withAuth: route requires a scope no install declares — every API key will 403', {
      scope: options.scope,
      declared: listValidApiKeyScopes(),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]): Promise<Response> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const [request, context] = args;

      // API-key fallback (Phase 4): if a valid `Authorization: Bearer sk_...`
      // header resolves to an active key, treat its owner as the session.
      // The CI eval-gate flow uses this so headless callers don't need a
      // browser cookie. Any scope is accepted unless the route asked for one
      // via `options.scope`.
      const apiKey = await resolveApiKey(request as NextRequest);
      let session: AuthSession;
      let principal: AuthorizationPrincipal;

      if (apiKey) {
        if (options?.scope && !hasScope(apiKey.scopes, options.scope)) {
          // Names the scope the route wants, never the ones the key holds —
          // a 403 should not be a scope-enumeration oracle.
          throw new ForbiddenError(`API key scope '${options.scope}' required`);
        }
        session = apiKey.session;
        principal = principalOf(session, 'api-key', apiKey.scopes);
      } else {
        const requestHeaders = await headers();
        const cookieSession = await auth.api.getSession({ headers: requestHeaders });

        if (!cookieSession) {
          throw new UnauthorizedError();
        }
        session = cookieSession;
        principal = principalOf(session, 'session');
      }

      // The read half of the authorization seam. The subject is whoever owns
      // the resource the route named; with no `resource` resolver there is no
      // subject, the policy is asked about `{ kind: 'nothing' }`, and Sunrise's
      // default policy allows it — so those routes take the same branch they
      // took before this call existed, which has its own test rather than being
      // assumed. `app/api/v1/users/[id]` (GET) is the one core route that does
      // name a resource.
      const resource = await resolveResource(
        options?.resource,
        request as NextRequest,
        context as RouteContext | undefined
      );
      if (resource === UNRESOLVED) {
        throw new ForbiddenError('Access denied');
      }
      // `readTargetFor` is the one place a resource becomes a read question, so
      // the three states it can be in are named rather than flattened. This used
      // to be `resource?.ownerId ?? null`, which collapsed "named nothing" and
      // "named a row with no owner" onto the value the default policy permits.
      if (!(await canRead(principal, readTargetFor(resource)))) {
        // Named, because the decision moved in here from the handlers. A route
        // that used to log its target before checking would otherwise lose that
        // record on exactly the requests worth recording: `handleAPIError` logs
        // neither the path nor the resource, so a refused cross-user read would
        // be an unattributable 'API Error'. Ids, not contents.
        logger.warn('authorization: canRead refused a request', {
          path: (request as NextRequest).nextUrl?.pathname,
          resourceKind: resource?.kind,
          resourceId: resource?.id,
          userId: principal.userId,
          credential: principal.credential,
        });
        throw new ForbiddenError('Access denied');
      }

      // One principal, built by the guard and handed on — never rebuilt by the
      // handler. See {@link AuthenticatedSession} for what reconstruction cost.
      const authenticated: AuthenticatedSession = { ...session, principal };
      if (context !== undefined) {
        return await handler(request, authenticated, context);
      }
      return await handler(request, authenticated);
    } catch (error) {
      return handleAPIError(error);
    }
  };
}

/**
 * Wrap an API route handler with admin authentication.
 *
 * - Retrieves the session from better-auth
 * - Throws UnauthorizedError (401) if no session
 * - Throws ForbiddenError (403) when the authorization policy says the caller
 *   may not administer. Sunrise's default policy answers exactly what this
 *   guard used to assert inline — platform role for a cookie session, the
 *   `admin` scope for an API key — and a fork replaces that answer from
 *   `lib/app/authorization.ts` without touching a route
 * - Passes the session to the handler
 * - Catches all errors via handleAPIError
 *
 * Rate limiting is NOT applied here. The project enforces rate limits in
 * `proxy.ts` via the central policy table at `lib/security/rate-limit-policy.ts`.
 * Route handlers should not call limiters directly except for additive
 * per-flow caps (e.g., `chatLimiter`, `audioLimiter`, `imageLimiter` for
 * the chat-stream route's expensive sub-flows).
 *
 * @example
 * ```typescript
 * // Admin-only route (no params)
 * export const GET = withAdminAuth(async (request, session) => {
 *   const stats = await getSystemStats();
 *   return successResponse(stats);
 * });
 *
 * // Admin route with dynamic params
 * export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
 *   const { id } = await params;
 *   await prisma.user.delete({ where: { id } });
 *   return successResponse({ id, deleted: true });
 * });
 * ```
 */
export function withAdminAuth(
  handler: (request: NextRequest, session: AuthenticatedSession) => Response | Promise<Response>,
  options?: WithAdminAuthOptions
): (request: NextRequest) => Promise<Response>;

export function withAdminAuth<TParams>(
  handler: (
    request: NextRequest,
    session: AuthenticatedSession,
    context: RouteContext<TParams>
  ) => Response | Promise<Response>,
  options?: WithAdminAuthOptions<TParams>
): (request: NextRequest, context: RouteContext<TParams>) => Promise<Response>;

export function withAdminAuth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => Response | Promise<Response>,
  options?: WithAdminAuthOptions
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (...args: any[]): Promise<Response> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const [request, context] = args;

      // API-key fallback (Phase 4): admin-scoped keys can hit admin
      // endpoints headlessly. The user behind the key needs neither
      // `role: 'ADMIN'` nor an active session cookie — the scope is the
      // capability check. Any key without `admin` scope is rejected
      // here with 403 rather than falling through to the cookie path
      // (which would 401 a key-bearing caller and confuse CI).
      const apiKey = await resolveApiKey(request as NextRequest);
      let session: AuthSession;
      let principal: AuthorizationPrincipal;

      if (apiKey) {
        // Kept in the guard as a FLOOR, not moved into the policy: it means a
        // fork's policy can only narrow the key path, never widen it. That is
        // the whole content of design decision Q6 — the `admin` scope is
        // platform-only — and leaving the check here is what stops a fork that
        // forgets to read `viewer.scopes` from handing every key holder the
        // admin surface. The default policy re-derives the same answer rather
        // than trusting this, so it is also correct when called directly.
        if (!hasScope(apiKey.scopes, 'admin')) {
          throw new ForbiddenError('Admin scope required');
        }
        session = apiKey.session;
        principal = principalOf(session, 'api-key', apiKey.scopes);
      } else {
        const requestHeaders = await headers();
        const cookieSession = await auth.api.getSession({ headers: requestHeaders });

        if (!cookieSession) {
          throw new UnauthorizedError();
        }
        session = cookieSession;
        principal = principalOf(session, 'session');
      }

      const resource = await resolveResource(
        options?.resource,
        request as NextRequest,
        context as RouteContext | undefined
      );

      // 'Admin access required' for BOTH credentials here, and that is not a
      // regression on the key path: the only thing that used to answer for a key
      // caller is the scope floor above, which still throws its own
      // 'Admin scope required' and is unreachable past. What lands here is a
      // resolver that named nothing, or a policy that refused — neither of which
      // is a missing scope, and telling an operator debugging safe mode to go
      // and look at their key would send them to the one place that is fine.
      if (resource === UNRESOLVED || !(await canAdminister(principal, resource))) {
        // Same reason as the `canRead` refusal above: the guard owns the
        // decision, so it owns the record of refusing.
        logger.warn('authorization: canAdminister refused a request', {
          path: (request as NextRequest).nextUrl?.pathname,
          resourceKind: resource === UNRESOLVED ? '(unresolved)' : resource?.kind,
          resourceId: resource === UNRESOLVED ? undefined : resource?.id,
          userId: principal.userId,
          credential: principal.credential,
        });
        throw new ForbiddenError('Admin access required');
      }

      // One principal, built by the guard and handed on — never rebuilt by the
      // handler. See {@link AuthenticatedSession} for what reconstruction cost.
      const authenticated: AuthenticatedSession = { ...session, principal };
      if (context !== undefined) {
        return await handler(request, authenticated, context);
      }
      return await handler(request, authenticated);
    } catch (error) {
      return handleAPIError(error);
    }
  };
}
