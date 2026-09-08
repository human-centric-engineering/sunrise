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
 * Next.js route params context shape
 */
export interface RouteContext<TParams = Record<string, string>> {
  params: Promise<TParams>;
}

/**
 * Tells the authorization policy **what** a request is acting on.
 *
 * Without one, the policy is asked about the caller and nothing else — which is
 * all Sunrise's own policy needs, and is why no core route supplies a resolver.
 * A fork scoping by owner (#367) or by org (§106) needs the resource, and the
 * alternative to this hook is rewriting every handler's signature to pass it
 * down. Return `null` when there is nothing to name.
 *
 * Runs **before** the handler and on every request to the route, so keep it to
 * what the URL already carries where you can. A resolver that throws denies the
 * request — a scope that cannot be established is not permission.
 *
 * ```ts
 * export const GET = withAuth<{ id: string }>(handler, {
 *   resource: async (_request, context) => {
 *     const { id } = await context!.params;
 *     const row = await prisma.thing.findUnique({ where: { id }, select: { createdBy: true } });
 *     return row && { kind: 'thing', id, ownerId: row.createdBy };
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
   * the request and asks `canRead`. With no resolver the subject is `null` and
   * the default policy allows it, so this option is inert on a stock install —
   * that is the behaviour-neutrality this seam is built on, and it is asserted
   * rather than assumed.
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
 * A throwing resolver is turned into a denial rather than a 500. It sits in
 * front of the policy, so a scope it could not establish must not be read as no
 * scope at all — that would hand the policy `null` and, on the default policy,
 * quietly permit. `RESOLVER_FAILED` is a distinct sentinel from `null` for
 * exactly that reason.
 */
const RESOLVER_FAILED = Symbol('resource-resolver-failed');

async function resolveResource(
  resolver: AuthorizationResourceResolver | undefined,
  request: NextRequest,
  context: RouteContext | undefined
): Promise<AuthorizationResource | null | typeof RESOLVER_FAILED> {
  if (!resolver) return null;
  try {
    return (await resolver(request, context)) ?? null;
  } catch (error) {
    logger.error('authorization: a route resource resolver threw — denying the request', {
      path: request.nextUrl?.pathname,
      error: error instanceof Error ? error.message : String(error),
      fix: 'The policy cannot be asked about a resource that could not be resolved, and an unresolved scope is not an absent one.',
    });
    return RESOLVER_FAILED;
  }
}

/**
 * Wrap an API route handler with authentication.
 *
 * - Retrieves the session from better-auth
 * - Throws UnauthorizedError (401) if no session
 * - Throws ForbiddenError (403) if `options.scope` is set and an API-key
 *   caller lacks it
 * - Asks the authorization policy `canRead(principal, subject)`, where `subject`
 *   is the `ownerId` from `options.resource` — or `null` when the route named
 *   none, which is every core route and which the default policy allows
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
  handler: (request: NextRequest, session: AuthSession) => Response | Promise<Response>,
  options?: WithAuthOptions
): (request: NextRequest) => Promise<Response>;

export function withAuth<TParams>(
  handler: (
    request: NextRequest,
    session: AuthSession,
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
      // subject, the policy is asked about `null`, and Sunrise's default policy
      // allows it — so a stock install takes the same branch it took before this
      // call existed. That is the arm every core route takes, and it has its own
      // test rather than being assumed.
      const resource = await resolveResource(
        options?.resource,
        request as NextRequest,
        context as RouteContext | undefined
      );
      if (resource === RESOLVER_FAILED) {
        throw new ForbiddenError('Access denied');
      }
      // The resource goes through as well as the subject derived from it. It
      // is the same object `withAdminAuth` hands `canAdminister`, and passing
      // only `ownerId` made the read face structurally unable to see a row it
      // could not attribute — an org-owned row, or a nullable `createdBy` —
      // which then arrived indistinguishable from "this route named nothing"
      // and was permitted unconditionally. A fork could not fix that in its own
      // policy, because the information was discarded here.
      if (!(await canRead(principal, resource?.ownerId ?? null, {}, resource))) {
        throw new ForbiddenError('Access denied');
      }

      if (context !== undefined) {
        return await handler(request, session, context);
      }
      return await handler(request, session);
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
  handler: (request: NextRequest, session: AuthSession) => Response | Promise<Response>,
  options?: WithAdminAuthOptions
): (request: NextRequest) => Promise<Response>;

export function withAdminAuth<TParams>(
  handler: (
    request: NextRequest,
    session: AuthSession,
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

      if (resource === RESOLVER_FAILED || !(await canAdminister(principal, resource))) {
        // The message follows the credential, not the policy, so both 403s read
        // exactly as they did before the decision moved: a key caller is told
        // about the scope it is missing, a person about the access.
        throw new ForbiddenError(
          principal.credential === 'api-key' ? 'Admin scope required' : 'Admin access required'
        );
      }

      if (context !== undefined) {
        return await handler(request, session, context);
      }
      return await handler(request, session);
    } catch (error) {
      return handleAPIError(error);
    }
  };
}
