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
  subjectScope,
  type AuthorizationPrincipal,
  type AuthorizationResource,
  type SubjectFilter,
} from '@/lib/auth/authorization';
import { env } from '@/lib/env';

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
  /**
   * Which subjects this caller may see, as a Prisma `where` fragment —
   * `subjectScope(principal)`, computed once by the guard.
   *
   * `{}` is every subject; `{ userId }` narrows to one. `AND` it into a list
   * query rather than spreading it, so an optional filter built from a query
   * parameter cannot overwrite the key that is the boundary.
   *
   * **Reading this is what `ownership: { decidedBy: 'policy' }` promises**, and
   * the guard notices whether you did — see {@link RouteOwnership}. It is a
   * getter for exactly that reason, which is also why you should read it once
   * into a local rather than reaching for it inside a loop.
   *
   * **Do not read it off a COPY of the session.** It is non-enumerable, so
   * `{ ...session }` does not carry it: the copy still types as an
   * `AuthenticatedSession`, and `copy.subjectFilter` is `undefined` rather than
   * a getter. A helper doing `where: { AND: [{ ...copy.subjectFilter }, …] }`
   * then gets `{}` — every subject — which is the widening this whole type
   * exists to prevent, arriving through a reshape that looks harmless
   * (`{ ...session, user: redact(session.user) }`). Non-enumerable is not
   * squeamishness: an enumerable getter would fire on any spread and record the
   * filter as consumed by a handler that never used it. Pass the session itself,
   * or pass the filter you read from it.
   */
  readonly subjectFilter: SubjectFilter;
}

/**
 * How a route decides **whose** rows it may touch — the declarative owner-scope
 * marker #367 asked for.
 *
 * Every guarded route makes this decision, including the ones that make it by
 * not having one. Before this existed, "I forgot to narrow the query" and "this
 * route is platform-wide on purpose" produced identical code, identical logs and
 * identical passing tests; the only difference was in the author's head. This
 * type moves that difference into the route's source.
 *
 * - `'policy'` — the handler asks the authorization policy, by reading
 *   `session.subjectFilter`. The guard **checks that it actually did**: a route
 *   that claims the policy decides and never consults it is the failure this
 *   whole task is about, so claiming it is not enough.
 * - `'self'` — self-scoped by construction: the route reads only the caller's
 *   own rows, keyed on `session.user.id`. `users/me`, a user's own API keys and
 *   a user's own conversations are this. Note it is **not** the same as
 *   `'policy'` and must not be migrated to it: `subjectScope` widens to `{}` for
 *   a platform admin, which on a self endpoint would hand an admin everyone
 *   else's rows.
 * - `'resource'` — the policy decided in the guard, about the row this route's
 *   `resource` resolver named, **and the handler reads nothing else**. That
 *   second clause is the whole content of the claim and the guard cannot see it:
 *   `canRead` was asked about one row, and says nothing about a list of siblings
 *   the same handler goes on to run. Declaring a resolver used to exempt the
 *   whole handler automatically, which made it the one escape hatch that needed
 *   no sentence and produced no log line.
 * - `'nothing'` — the route makes no ownership decision, deliberately.
 *
 * All but `'policy'` carry a `because`, and it is required rather than
 * encouraged: the value of the marker is the sentence, not the enum. A reviewer
 * reading `{ decidedBy: 'nothing' }` alone learns only that somebody typed it.
 * `'policy'` is the exception because it is the one the guard can check for
 * itself — the handler either read the filter or it did not.
 */
export type RouteOwnership =
  | { decidedBy: 'policy' }
  | { decidedBy: 'resource'; because: string }
  | { decidedBy: 'self'; because: string }
  | { decidedBy: 'nothing'; because: string };

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
  /**
   * How this route decides whose rows it may touch. See {@link RouteOwnership}.
   *
   * Required in practice, not in the type: the guard demands one only once the
   * caller is **actually narrowed** — see {@link reportOwnershipGap}. Making it
   * a required field would have meant annotating 285 handlers to say nothing on
   * an install with no ownership boundary, and a field everybody fills in with
   * the first value that compiles is not a declaration.
   */
  ownership?: RouteOwnership;
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
  /**
   * How this route decides whose rows it may touch. See {@link RouteOwnership}.
   *
   * Sunrise's own admin routes carry none, and that is not an oversight: under
   * the default policy every caller who gets past `canAdminister` is a platform
   * admin, whose `subjectScope` is `{}` — unrestricted, so there is nothing to
   * narrow and nothing to declare. On a fork whose org admin is narrowed, these
   * are the routes that start asking for one.
   */
  ownership?: RouteOwnership;
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
 * What the guard does when a route made no ownership decision it should have.
 *
 * **Refuses under test, logs everywhere else** — including development, which is
 * a deliberate reversal of the obvious "everything but production refuses".
 *
 * The reason is what the canonical fork migration actually looks like. The
 * documented one-line override is
 * `{ ...DEFAULT_AUTHORIZATION_POLICY, canAdminister: isOrgAdmin }`, and under it
 * an org admin passes `canAdminister` while the *retained* default
 * `subjectScope` answers `{ userId }`. Every one of the 262 `withAdminAuth`
 * handlers then owes a declaration **at once**. Refusing in development would
 * mean a fork's entire admin console 500s the first time they boot after
 * upgrading — from following the recipe correctly. The same blast radius is
 * reachable transiently: a fork's `subjectScope` that throws falls back to
 * `SAFE_MODE_POLICY`'s `{ userId }`, so one flaky membership lookup would take
 * the console down on top of the original fault.
 *
 * A failing test is what the contract asks for and it is the better instrument
 * anyway: the fork's suite enumerates the routes, one per failure, in a list
 * they can work through — instead of a running app that stops working.
 *
 * A fork that wants development to refuse too flips this constant. It is a
 * constant and not an environment variable on purpose: which way this goes is a
 * property of the product, decided once by whoever owns the fork, not a
 * per-deploy dial that can differ between staging and production and hide the
 * difference.
 *
 * Written as "development or production ⇒ log" rather than "test ⇒ refuse"
 * because `env.NODE_ENV` is **undefined** under happy-dom: `lib/env.ts` sees
 * `typeof window !== 'undefined'` and validates only the client schema, which
 * does not carry `NODE_ENV`. Keying on `=== 'test'` would silently turn the
 * check off for every DOM-environment test in the suite.
 *
 * **What `'refuse'` looks like on a mutating route, so it is not a surprise:**
 * the check can only run after the handler, because whether the handler
 * consulted the filter is not knowable before it does. So a `POST` that writes
 * and then turns out to have no ownership declaration returns 500 **with the
 * write committed**. That is a misconfigured route reporting itself under test,
 * not a rollback — do not read the 500 as "nothing happened".
 */
const OWNERSHIP_GAP_ACTION: 'refuse' | 'log' =
  env.NODE_ENV === 'development' || env.NODE_ENV === 'production' ? 'log' : 'refuse';

/**
 * One route's "already reported" flag, owned by that route's guard closure.
 *
 * A fork mid-migration has every un-annotated route reporting on every request,
 * and the signal does not survive its own volume — the failure the
 * `'unattributed'` arm in `lib/auth/authorization.ts` already logs-once-per-kind
 * to avoid.
 *
 * **A module-level `Set` keyed on the request path was the wrong instrument, in
 * two ways at once.** `nextUrl.pathname` is the CONCRETE path, so on a dynamic
 * route every id is its own key: `/agents/[id]` deduplicated nothing across
 * 10k agent views, and the Set grew one permanent entry per id in a long-lived
 * process — traffic-proportional, never evicted. Each `withAuth(...)` call
 * already creates exactly one closure per route, so the flag lives there: no
 * key to get wrong, no growth, and it is right on dynamic routes by
 * construction rather than by string handling.
 *
 * The `'refuse'` branch does not consult it. It throws, so it cannot be missed,
 * and suppressing a second occurrence would make one test's assertion depend on
 * whether another had run.
 */
interface OwnershipReportState {
  reported: boolean;
}

/**
 * Raised when a route reached the end of a request without deciding whose rows
 * it was allowed to touch, on an install where that question has an answer.
 *
 * Its own class so a fork can recognise it — `handleAPIError` turns it into a
 * 500, which is the correct shape for "this route is misconfigured" and the
 * wrong shape for anything a caller can fix.
 */
export class OwnershipDecisionMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipDecisionMissingError';
  }
}

/**
 * The check behind {@link RouteOwnership}: did this request make an ownership
 * decision, on an install where there was one to make?
 *
 * **It is silent unless the caller is actually narrowed**, and that is the whole
 * reason it can exist at all. A static check cannot tell a leak from correct
 * behaviour here, because the difference is a runtime fact about the registered
 * policy: in single-tenant Sunrise a route that reads every row is *right*, and
 * a build-time scan of this tree flags 97 such reads, nearly all of them
 * correct. `subjectScope(principal) === {}` says this caller may see every
 * subject, so there is no boundary to forget. `{ userId }` says there is.
 *
 * **It is also silent on a response that carried no rows.** A handler that
 * returns 4xx — a rate-limit 429, a validation 400, a 404 — answered nobody's
 * query, so it cannot have answered it too widely. Without this the documented
 * `'policy'` recipe would be a trap: the shape core itself uses opens with
 * `if (!rateLimit.success) return createRateLimitResponse(rateLimit)`, and 38
 * guarded routes in this tree return early like that. Under a narrowing policy
 * every rate-limited request on such a route would have become a 500 in
 * development and a log line per request in production — the check breaking the
 * routes that were written correctly.
 *
 * Note the asymmetry it removes: a handler that *throws* was never checked
 * (`runHandler` only reports on a returned response), so before this a route
 * that refused by throwing was exempt while the same route refusing by
 * returning was not. Nothing in the design intended that difference.
 *
 * Four ways to satisfy it:
 *
 * 1. `ownership: { decidedBy: 'policy' }` **and** the handler read
 *    `session.subjectFilter`. Declaring without reading is reported separately,
 *    with its own message, because it is a different mistake: the author knew
 *    the rule and the query still went out unnarrowed.
 * 2. `ownership: { decidedBy: 'resource', … }` — the policy decided about the
 *    row the resolver named, and the handler reads nothing else.
 * 3. `ownership: { decidedBy: 'self', … }` — keyed on the caller's own id.
 * 4. `ownership: { decidedBy: 'nothing', … }` — no ownership decision, said out
 *    loud.
 *
 * Two things it cannot see, and neither is a reason to trust it less than it
 * deserves:
 *
 * - **A library function called by a satisfied route.** A route that declares
 *   `'nothing'` and calls an exporter reading every row is exactly as leaky as
 *   before — but the declaration is now in its source, which is the difference
 *   between an unreviewed omission and a reviewed decision. The query-level
 *   control that would close it is the tenancy chokepoint in `lib/db/client.ts`.
 * - **A read that happens after the response is returned**, which is what a
 *   streamed body is. Read `session.subjectFilter` before you hand back the
 *   stream — you need it to build the query anyway — or the route will be
 *   reported despite being correct.
 *
 * See `.context/auth/authorization.md`.
 */
function reportOwnershipGap(options: {
  guard: 'withAuth' | 'withAdminAuth';
  path: string | undefined;
  ownership: RouteOwnership | undefined;
  declaredResource: boolean;
  responseCarriedRows: boolean;
  filter: SubjectFilter;
  filterRead: boolean;
  principal: AuthorizationPrincipal;
  state: OwnershipReportState;
}): void {
  // Not narrowed ⇒ every subject is this caller's to see ⇒ nothing to forget.
  if (options.filter.userId === undefined) return;
  if (!options.responseCarriedRows) return;

  const declared = options.ownership?.decidedBy;

  // A switch over the union rather than a chain of early returns, and the
  // difference is not style. Each arm states its OWN requirement, and adding a
  // `decidedBy` value without stating one stops compiling — `complaint` would be
  // `undefined`, which `string | null` does not admit. Two review rounds found
  // one missing condition each on the chain version (`'resource'` declared with
  // no resolver; the shape below), because a chain has no place that has to be
  // updated when the union grows. This does.
  let complaint: string | null;
  switch (declared) {
    case undefined:
      complaint = `${options.guard}: this route made no ownership decision for a caller the policy narrows to their own rows. Declare an \`ownership\` — 'policy' (and read session.subjectFilter), or 'resource' / 'self' / 'nothing' with a reason.`;
      break;
    case 'policy':
      // A 2xx that short-circuits before building its query — `if (!ids.length)
      // return successResponse({ items: [] })` — lands here honestly, having
      // answered nobody's query. There is no way to tell it apart from a route
      // that forgot, so it is reported and the remedy is one line: read the
      // filter before the early return.
      complaint = options.filterRead
        ? null
        : `${options.guard}: this route declares ownership { decidedBy: 'policy' } but never read session.subjectFilter, so the policy did not narrow anything it did. If the handler returned early without building its query, read the filter before that return.`;
      break;
    case 'resource':
      // The arm whose entire meaning is "the resolver decided". With no
      // resolver, `canRead` was asked about `{ kind: 'nothing' }` — which the
      // default policy always permits — so no policy decision about any row ever
      // happened, and the declaration is exempting a route that reads whatever
      // it likes. A dropped or renamed `resource` key while copying the
      // `app/api/v1/users/[id]` recipe is exactly how that arrives.
      complaint = options.declaredResource
        ? null
        : `${options.guard}: this route declares ownership { decidedBy: 'resource' } but supplies no \`resource\` resolver, so the policy was asked about nothing and permitted it. Add the resolver, or declare the ownership this route actually has.`;
      break;
    case 'self':
    case 'nothing':
      // **Unreachable today, and it must stay anyway.** Both settle the question
      // on their own, so `declarationSettlesIt` skips the `subjectScope` call for
      // them, the filter is `{}`, and this function has already returned at its
      // first gate. The arm exists so the switch stays exhaustive over
      // `RouteOwnership`: delete it as dead code and the next `decidedBy` value
      // added compiles into a silent `undefined` complaint instead of failing
      // the build, which is the entire reason this is a switch and not a chain.
      // Its absence from the coverage report is that, not a missing test.
      complaint = null;
      break;
  }

  if (complaint === null) return;

  // Once per route on the log branch — the flag belongs to this route's guard
  // closure, so "this route" needs no key.
  if (OWNERSHIP_GAP_ACTION === 'log') {
    if (options.state.reported) return;
    options.state.reported = true;
  }

  // `undefined` in the error slot, context in `meta`: the signature is
  // `error(message, error?, meta?)`, so passing this object second would
  // JSON-stringify it into `entry.error.message` under `name: 'UnknownError'`
  // and leave `entry.meta` empty — the fields an operator filters on would not
  // be fields. That matters most on the log branch, which is every environment
  // but test.
  logger.error('authorization: a route made no ownership decision', undefined, {
    path: options.path,
    guard: options.guard,
    declared: declared ?? '(none)',
    userId: options.principal.userId,
    credential: options.principal.credential,
    action: OWNERSHIP_GAP_ACTION,
    fix: complaint,
  });

  if (OWNERSHIP_GAP_ACTION === 'refuse') {
    throw new OwnershipDecisionMissingError(complaint);
  }
}

/**
 * Warn at route-definition time about a declaration that cannot be true.
 *
 * Boot-time rather than per-request, matching the `scope` warning above: this is
 * a property of how the route is written, so it surfaces even if nobody calls
 * the endpoint. The request-time check reports it too — this is the earlier of
 * the two, not a replacement.
 */
function warnOnContradictoryOwnership(
  guard: 'withAuth' | 'withAdminAuth',
  options: { ownership?: RouteOwnership; resource?: unknown } | undefined
): void {
  if (options?.ownership?.decidedBy === 'resource' && options.resource === undefined) {
    logger.warn(`${guard}: ownership says 'resource' but the route declares no resource resolver`, {
      because: options.ownership.because,
      fix: "Add the `resource` resolver, or declare the ownership this route actually has. Without a resolver the policy is asked about `{ kind: 'nothing' }`, which it permits.",
    });
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

  // The same shape, for the same reason: a contradiction knowable without a
  // request, so it is said at boot rather than waiting for traffic.
  // `{ decidedBy: 'resource' }` means "the resolver decided"; with no resolver
  // `canRead` is asked about `{ kind: 'nothing' }`, which the default policy
  // always permits — so nothing decided anything. A dropped or renamed
  // `resource` key while copying the users/[id] recipe is how it arrives.
  warnOnContradictoryOwnership('withAuth', options);

  // One per route, because this factory runs once per route module.
  const ownershipReportState: OwnershipReportState = { reported: false };

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

      return await runHandler({
        guard: 'withAuth',
        handler,
        request: request as NextRequest,
        context: context as RouteContext | undefined,
        session,
        principal,
        ownership: options?.ownership,
        declaredResource: options?.resource !== undefined,
        state: ownershipReportState,
      });
    } catch (error) {
      return handleAPIError(error);
    }
  };
}

/**
 * Hand the handler its session and watch what it does with the ownership half.
 *
 * Shared by both guards because the two must not drift here: this is the third
 * time this seam has had a rule that one guard applied and the other did not
 * (`readTargetFor` was the first, the principal hand-off the second), and each
 * time the gap was invisible until somebody read the two bodies side by side.
 *
 * `subjectFilter` is a getter rather than a value so that *reading it* is
 * observable — which is what lets `ownership: { decidedBy: 'policy' }` be a
 * checkable claim rather than a comment. Nothing else about it is unusual: it
 * returns the same object every time and computes nothing.
 */
async function runHandler(args: {
  guard: 'withAuth' | 'withAdminAuth';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...handlerArgs: any[]) => Response | Promise<Response>;
  request: NextRequest;
  context: RouteContext | undefined;
  session: AuthSession;
  principal: AuthorizationPrincipal;
  ownership: RouteOwnership | undefined;
  declaredResource: boolean;
  state: OwnershipReportState;
}): Promise<Response> {
  // Asked only where the answer can be used: the check needs it when the route
  // declared nothing, and the handler needs it when the route declared
  // `'policy'`. Everything else skips it.
  //
  // Be clear about how much that saves, because the first version of this
  // comment claimed the opposite. `ownership === undefined` is TRUE for all 262
  // `withAdminAuth` handlers, so they still pay; what the skip covers is the 22
  // routes that declare `'self'` or `'nothing'`. A fork stops paying on an admin
  // route by annotating it — which is the same act that resolves the ownership
  // question, so the two arrive together.
  // The filter is needed unless the route's declaration settles the question on
  // its own. `'self'` and `'nothing'` do. `'resource'` does so ONLY when a
  // resolver actually exists — without one the declaration is a contradiction
  // the check below has to be able to report, and it cannot report anything
  // until it knows whether this caller is narrowed. Skipping the lookup there
  // made the contradiction unreachable, which a test caught after both halves
  // had been reviewed separately.
  const declarationSettlesIt =
    args.ownership !== undefined &&
    args.ownership.decidedBy !== 'policy' &&
    (args.ownership.decidedBy !== 'resource' || args.declaredResource);
  const filterIsUsable = !declarationSettlesIt;

  // Copied, not handed straight over. This is the first time a policy's return
  // value reaches route code, and the policy is a fork's. A fork that caches or
  // memoises its filter would otherwise be handing every request a reference to
  // one shared object, and a handler that mutated it rather than `AND`ing it in
  // would contaminate the next request's scope. One spread per request removes
  // the whole class in both directions, and — unlike `Object.freeze` — it does
  // it without reaching into an object this module does not own.
  const filter: SubjectFilter = filterIsUsable ? { ...(await subjectScope(args.principal)) } : {};
  let filterRead = false;

  // One principal, built by the guard and handed on — never rebuilt by the
  // handler. See {@link AuthenticatedSession} for what reconstruction cost.
  const authenticated: AuthenticatedSession = {
    ...args.session,
    principal: args.principal,
    get subjectFilter() {
      // Throws rather than answering `{}`, which is the WIDEST value this type
      // can express. A route that declared `'self'` and then read the filter
      // would otherwise be handed "every subject" and could build an unnarrowed
      // query out of it — the exact leak, delivered by the mechanism meant to
      // prevent it. Refusing is the only safe answer to "you did not ask for
      // this".
      if (!filterIsUsable) {
        // Logged and answered with the NARROWEST value — not thrown. This used
        // to throw in every environment, which sat badly beside
        // OWNERSHIP_GAP_ACTION's carefully argued "do not turn a misconfigured
        // route into an outage", and worse: `subjectFilter` is a required member,
        // so a cross-cutting helper typed against `AuthenticatedSession` — a
        // shared paginator, an audit wrapper — had no type-level signal that
        // reading it was unsafe and no way to probe but `try`/`catch`.
        //
        // `{ userId }` is the safe answer because it is the narrowest one the
        // type can express, so a query built from it returns too FEW rows rather
        // than too many. Answering `{}` would be the opposite and is what makes
        // this branch worth having at all. It is also exactly what
        // `subjectScope`'s own wrapper does with a policy it cannot trust: log,
        // and fall back to safe mode.
        logger.error(
          'authorization: subjectFilter read on a route that did not ask for it',
          undefined,
          {
            path: args.request.nextUrl?.pathname,
            guard: args.guard,
            declared: args.ownership?.decidedBy ?? '(none)',
            fix: "The filter is only computed for a route that declared { decidedBy: 'policy' }. This read got the reader's own id — the narrowest answer — rather than the policy's. Declare 'policy' if the handler needs the real one.",
          }
        );
        return { userId: args.principal.userId };
      }
      filterRead = true;
      return filter;
    },
  };

  // Non-enumerable, and that is a correctness fix rather than tidiness: a
  // handler writing `{ ...session }` — to log it, to pass it on — would
  // otherwise invoke the getter and mark the filter consumed without a single
  // query having been narrowed by it. That is a route claiming
  // `decidedBy: 'policy'` and passing while it leaks, which is the one outcome
  // this whole mechanism exists to prevent. Defined here rather than in the
  // literal so the accessor still satisfies the interface at construction.
  Object.defineProperty(authenticated, 'subjectFilter', { enumerable: false });

  const response =
    args.context !== undefined
      ? await args.handler(args.request, authenticated, args.context)
      : await args.handler(args.request, authenticated);

  // After the handler, not before: whether it consulted the filter is only
  // knowable once it has run. A handler that threw is not checked — no response
  // means no rows went out, and reporting a missing ownership decision on top of
  // a real failure would bury the failure.
  reportOwnershipGap({
    guard: args.guard,
    path: args.request.nextUrl?.pathname,
    ownership: args.ownership,
    declaredResource: args.declaredResource,
    state: args.state,
    // A 4xx/5xx answered nobody's query, so it cannot have answered it too
    // widely — and gating on it is what stops the check firing on the early
    // `return createRateLimitResponse(...)` that 38 guarded routes here open
    // with.
    responseCarriedRows: response.ok,
    filter,
    filterRead,
    principal: args.principal,
  });

  return response;
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
  warnOnContradictoryOwnership('withAdminAuth', options);

  // One per route, because this factory runs once per route module.
  const ownershipReportState: OwnershipReportState = { reported: false };

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

      return await runHandler({
        guard: 'withAdminAuth',
        handler,
        request: request as NextRequest,
        context: context as RouteContext | undefined,
        session,
        principal,
        ownership: options?.ownership,
        declaredResource: options?.resource !== undefined,
        state: ownershipReportState,
      });
    } catch (error) {
      return handleAPIError(error);
    }
  };
}
