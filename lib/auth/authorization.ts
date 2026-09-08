/**
 * The authorization policy — one decision, three faces, one seam.
 *
 * Sunrise asks "may this principal do this?" in exactly three places:
 * `withAdminAuth`, `withAuth` (both in `lib/auth/guards.ts`) and
 * `app/admin/layout.tsx`. Until this module existed each of them *answered* the
 * question inline, with a role predicate in the guard body. That made the
 * chokepoint real and the decision unreachable: a fork needing "admin of this
 * org, not of the platform" (#366) or "only the questionnaires I created"
 * (#367) had to shadow `lib/auth/guards.ts` or edit every call site behind it:
 * 262 `withAdminAuth` handlers across 193 files, 257 of them under
 * `/api/v1/admin`, plus 23 `withAuth` handlers. Extracting the answer costs
 * those forks nothing at the call sites, because the chokepoint was already
 * there.
 *
 * ## The three faces
 *
 * - {@link AuthorizationPolicy.canAdminister} — "may this principal use an
 *   admin surface?", optionally about one resource. The face `withAdminAuth`
 *   and the admin layout call.
 * - {@link AuthorizationPolicy.canRead} — "may this principal read this
 *   subject's data?" A boolean about one subject.
 * - {@link AuthorizationPolicy.subjectScope} — the same predicate as a Prisma
 *   `where` fragment: *which* subjects may this principal see? The list face.
 *
 * **The last two are one rule wearing two shapes, and they must agree.** A
 * single-row read that permits and a list query that hides — or worse, the
 * reverse — is the defect Daybreak's review of this contract actually caught, so
 * {@link checkAuthorizationParity} exists to fail on it, and a fork that
 * overrides one face is expected to run it over their own policy.
 *
 * ## Shape decisions, and why they are locked in now
 *
 * **Async from day one.** Every face returns a `Promise`, and today's default
 * body needs none of it. The org input (§106) requires a membership lookup, and
 * converting a synchronous seam to an asynchronous one later is a sweep of
 * every caller — the exact churn a seam exists to avoid. This is the same call
 * Daybreak made fork-first in July, for the same reason.
 *
 * **`scope` is an open struct.** `{ ownership?, tier?, org? }`, every member
 * optional, `{}` meaning "the default view". #367 supplies `ownership`, #366
 * supplies `tier`, §106 supplies `org` — each without changing a signature.
 * Nothing in Sunrise core populates any of them today; they are carried for the
 * fork whose policy branches on them.
 *
 * **`subjectScope` returns `{}` for the unrestricted case, not a wildcard.**
 * `{ userId }` narrows to one subject; `{}` — no `userId` key at all — is every
 * subject. So widening a policy later is *dropping a key*, not rewriting the
 * callers that `AND` the fragment into their queries.
 *
 * ## What a failure does
 *
 * Every path here **fails closed**, and that is a deliberate outage rather than
 * a degradation:
 *
 * - A policy method that throws denies, and is logged. A restriction that
 *   cannot be evaluated must not be read as permission.
 * - A fork's registration that throws puts the install into
 *   {@link SAFE_MODE_POLICY} for the life of the process: nobody administers
 *   anything, and every declared read narrows to the reader's own rows.
 *
 * The rolled-back alternative — quietly falling back to Sunrise's default —
 * looks kinder and is worse. A fork's policy typically *narrows* the platform
 * default (an org admin must not see another org's rows), so silently using the
 * default in its place hands whoever the fork made `ADMIN` the whole install,
 * under a log line that says the feature is disabled. Safe mode is loud, and it
 * is fixed by fixing `lib/app/authorization.ts` and redeploying.
 *
 * Note what safe mode does NOT deny: a read with **no declared subject**. Core
 * routes declare none (nothing supplies a `resource` resolver yet), so denying
 * those would take the whole application down over an authorization seam that
 * is not yet load-bearing for them. Safe mode refuses what it was asked about,
 * not what it was not asked about.
 *
 * @see lib/app/authorization.ts — the fork-owned scaffold
 * @see lib/auth/guards.ts — `withAuth` / `withAdminAuth`, two of the three chokepoints
 * @see app/admin/layout.tsx — the third
 * @see .context/architecture/multi-tenancy-design.md — principle 7, and the Q6 ruling on `admin` keys
 */

import { logger } from '@/lib/logging';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { hasScope } from '@/lib/auth/api-key-scopes';
import { createAppInitGate } from '@/lib/fork-init';
import { initAppAuthorizationPolicy } from '@/lib/app/authorization';

/**
 * The ownership axis of #367: over whose data, within one tenant.
 *
 * Carried, not branched on, by the default policy — Sunrise has no team model,
 * and the grouping one sits below the org is fork-owned by design.
 */
export type Ownership = 'own' | 'team' | 'all';

/**
 * The open, structured scope carried through every face.
 *
 * Every member is optional and `{}` is the default view, so a new axis is an
 * added key rather than a changed signature. The three that are already spoken
 * for are named below; a fork may read keys of its own off the same object,
 * which is what "open" means here.
 */
export interface AuthorizationScope {
  /** #367's ownership input. Absent ⇒ the policy's own default. */
  ownership?: Ownership;
  /** #366's tier input — which admin tier is being asked about. */
  tier?: string;
  /** §106's org input. Absent ⇒ no org in context. */
  org?: string;
}

/**
 * Who is asking, and with what credential.
 *
 * Structurally compatible with `AuthSession['user']` on the fields it names, so
 * a guard builds one without a conversion layer — but deliberately its own
 * type, because the policy must also describe an **API-key** caller, which is
 * not a user session and whose standing comes from the key's scopes rather than
 * from the user's role.
 */
export interface AuthorizationPrincipal {
  /** The user the request acts as. */
  userId: string;
  /** The user's platform role as stored. See `lib/auth/roles.ts`. */
  role?: string | null;
  /**
   * How the request authenticated. A `'session'` is the full user; an
   * `'api-key'` is a credential deliberately narrower than its owner, and the
   * distinction is load-bearing — see `scopes`.
   */
  credential: 'session' | 'api-key';
  /**
   * Scopes the API key carries. Absent for a browser session.
   *
   * The default policy reads this rather than the owner's role for a key
   * caller, because that is what the guard has always done: an `admin`-scoped
   * key reaches admin routes whether or not its owner still holds the role.
   * That bypass is cross-tenant by construction, which is why the design record
   * pins the `admin` scope as **platform-only** (Q6) and why minting one
   * requires a platform admin with a browser session.
   */
  scopes?: readonly string[];
}

/**
 * What the request is acting on, when the route said.
 *
 * Every member is optional, and `null` (rather than an empty object) is what a
 * guard passes when no `resource` resolver was supplied — "this route did not
 * say" and "this route said nothing about it" are different answers, and a
 * fork's policy may reasonably refuse the first.
 *
 * Open, like {@link AuthorizationScope}: a fork's resolver may attach keys of
 * its own for its own policy to read.
 */
export interface AuthorizationResource {
  /** A stable kind name, e.g. `'agent'`. Fork-defined; core sets none. */
  kind?: string;
  /** The row id, when the route resolved one. */
  id?: string;
  /** The user who owns or created it — #367's ownership input. */
  ownerId?: string;
  /** The org it belongs to — §106's input. */
  orgId?: string;
}

/**
 * A Prisma `where` fragment naming the subjects a principal may see.
 *
 * `{ userId }` narrows to one; `{}` is every subject. The absent-key form is
 * what makes widening later a deletion rather than a rewrite of every caller
 * that `AND`s this into a query.
 */
export interface SubjectFilter {
  userId?: string;
}

/**
 * The policy. A fork registers a complete one — all three faces — from
 * `lib/app/authorization.ts`.
 *
 * **Complete, not partial, and that is the point.** `canRead` and
 * `subjectScope` are two shapes of one rule; a merge-over-the-default form
 * would make "override one, forget the other" a one-line mistake with no
 * symptom on the row-level path. Spread the default when you only mean to
 * change one face, so the copy is visible at your call site:
 *
 * ```ts
 * registerAuthorizationPolicy({
 *   ...DEFAULT_AUTHORIZATION_POLICY,
 *   canAdminister: async (viewer) => isOrgAdmin(viewer),
 * });
 * ```
 */
export interface AuthorizationPolicy {
  /**
   * May `viewer` use an admin surface? `resource` is `null` unless the route
   * supplied a `resource` resolver.
   *
   * Called on **every** guarded admin request and on every render of the admin
   * layout, so keep it cheap or cache what it looks up.
   */
  canAdminister(
    viewer: AuthorizationPrincipal,
    resource: AuthorizationResource | null,
    scope: AuthorizationScope
  ): Promise<boolean>;

  /**
   * May `viewer` read `subject`'s data? `subject` is a **user id**, or `null`
   * when the route declared no subject.
   *
   * The parity partner of {@link subjectScope}, and parity is defined over
   * concrete subject ids: `canRead(v, s)` must agree with
   * "`subjectScope(v)` selects `s`" for every `s`. The `null` case is outside
   * that relation — it is not a subject, it is the absence of one — so answer
   * it on its own terms. See {@link checkAuthorizationParity}.
   */
  canRead(
    viewer: AuthorizationPrincipal,
    subject: string | null,
    scope: AuthorizationScope
  ): Promise<boolean>;

  /** Which subjects may `viewer` see? The list face of {@link canRead}. */
  subjectScope(viewer: AuthorizationPrincipal, scope: AuthorizationScope): Promise<SubjectFilter>;
}

/**
 * Whether this principal administers the whole install.
 *
 * The one place the platform-admin question is answered, so the default
 * policy's three faces agree **by construction** rather than by three
 * independent bodies that happen to match today. The parity checker would catch
 * a divergence here; not writing one is better.
 */
function administersEverything(viewer: AuthorizationPrincipal): boolean {
  // An API-key caller's standing comes from the key, not from its owner's row.
  // `withAdminAuth` has always worked this way — the scope IS the capability
  // check — and Q6 makes that sound by keeping `admin` platform-only.
  if (viewer.credential === 'api-key') return hasScope([...(viewer.scopes ?? [])], 'admin');
  return isPlatformAdmin(viewer);
}

/**
 * Sunrise's own policy: what the guards did before this module existed.
 *
 * Platform admin administers everything and reads everyone; everyone else reads
 * themselves. Exported so a fork can spread it and replace one face — see
 * {@link AuthorizationPolicy}.
 */
export const DEFAULT_AUTHORIZATION_POLICY: AuthorizationPolicy = {
  canAdminister: (viewer) => Promise.resolve(administersEverything(viewer)),

  canRead: (viewer, subject) =>
    Promise.resolve(
      // A route that declared no subject is not making a claim this policy can
      // narrow. Sunrise has no `resource` resolvers, so this is the arm every
      // core `withAuth` route takes, and it is why wiring the seam changed no
      // behaviour.
      subject === null || subject === viewer.userId || administersEverything(viewer)
    ),

  subjectScope: (viewer) =>
    Promise.resolve(administersEverything(viewer) ? {} : { userId: viewer.userId }),
};

/**
 * What the install runs on when a fork's registration threw.
 *
 * The strictest coherent policy: nobody administers, every declared read is
 * self-only, and the two read faces still agree so the parity relation holds in
 * the failure state too. See the module header for why this is not a fallback
 * to {@link DEFAULT_AUTHORIZATION_POLICY}.
 */
export const SAFE_MODE_POLICY: AuthorizationPolicy = {
  canAdminister: () => Promise.resolve(false),
  canRead: (viewer, subject) => Promise.resolve(subject === null || subject === viewer.userId),
  subjectScope: (viewer) => Promise.resolve({ userId: viewer.userId }),
};

/** The fork's policy, once registered. */
let appPolicy: AuthorizationPolicy | null = null;

/**
 * Latched when the fork's registration threw. Separate from the gate's own
 * verdict because the gate rolls back to "no policy", which is indistinguishable
 * from "this fork registered none" — and those two must not be treated alike.
 */
let registrationFailed = false;

/**
 * Register the app's authorization policy. One policy, registered once.
 *
 * Re-registering the same object is a no-op; a different one throws rather than
 * silently replacing, because two policies in a tree means one of them is not
 * running and there is no way to tell which from the outside. Changing your
 * registration means restarting the dev server.
 *
 * @throws if a different policy is already registered.
 */
export function registerAuthorizationPolicy(policy: AuthorizationPolicy): void {
  if (appPolicy && appPolicy !== policy) {
    throw new Error(
      'registerAuthorizationPolicy: a different policy is already registered. ' +
        'Authorization is a single policy — compose your conditions inside one ' +
        'object rather than registering twice.'
    );
  }
  appPolicy = policy;
}

/**
 * Run `initAppAuthorizationPolicy()` once, lazily, before the first read.
 *
 * The gate rather than a hand-rolled latch, for the reasons in `lib/fork-init.ts`
 * — and lazily rather than at boot because the policy is read inside a request,
 * and a registration made in the boot realm fills a map the request realm never
 * sees. `getAuthorizationPolicy()` is called at the top of every guarded
 * request, which is exactly the before-first-read shape the gate is for.
 */
const appInit = createAppInitGate<AuthorizationPolicy | null>({
  label: 'authorization: initAppAuthorizationPolicy',
  subject: 'the app authorization policy',
  init: initAppAuthorizationPolicy,
  snapshot: () => appPolicy,
  restore: (before) => {
    appPolicy = before;
  },
  onFailure: () => {
    registrationFailed = true;
    // A second line, because the gate's own says "rolled back and disabled" and
    // for every other seam that means a feature is missing. Here it means the
    // admin console is refusing everyone until this is fixed, and an operator
    // reading 403s deserves to find that sentence in the log.
    logger.error('authorization: the app policy failed to register — running in SAFE MODE', {
      effect:
        'canAdminister denies every caller (the admin surface is closed) and every declared read narrows to the reader’s own rows.',
      fix: 'Fix lib/app/authorization.ts and redeploy. Sunrise deliberately does NOT fall back to its own default policy: a fork policy usually NARROWS the default, so falling back would widen access under a log line saying the feature is off.',
    });
  },
});

/**
 * The policy in force. Runs the fork's registration on first use.
 *
 * Prefer the {@link canAdminister} / {@link canRead} / {@link subjectScope}
 * wrappers below — they add the fail-closed handling. This is exported for a
 * fork's own tests and for {@link checkAuthorizationParity} call sites that want
 * to check the live policy rather than a candidate one.
 */
export function getAuthorizationPolicy(): AuthorizationPolicy {
  appInit.ensure();
  if (registrationFailed) return SAFE_MODE_POLICY;
  return appPolicy ?? DEFAULT_AUTHORIZATION_POLICY;
}

/** Whether a fork has registered a policy. **Tests only** — see the note below. */
export function hasAppAuthorizationPolicy(): boolean {
  // Deliberately does NOT run the gate, so it cannot answer "is this install
  // configured?" — before the first guarded request it says `false` on a fork
  // that has a policy. Fine for a test asserting what Sunrise ships; actively
  // misleading as a health check.
  return appPolicy !== null;
}

/** Test-only: drop the registered policy and re-arm the one-shot. */
export function __resetAuthorizationPolicyForTests(): void {
  appPolicy = null;
  registrationFailed = false;
  appInit.reset();
}

/**
 * Log a policy method that threw, and say what was denied instead.
 *
 * Every caller of this returns the *denying* answer. A throwing policy is a
 * policy that could not be evaluated, and an unevaluated restriction is not
 * permission — the same rule the provider-eligibility seam runs on.
 */
function denyAfterThrow(face: string, error: unknown, viewer: AuthorizationPrincipal): void {
  logger.error(`authorization: ${face} threw — denying`, {
    face,
    userId: viewer.userId,
    credential: viewer.credential,
    error: error instanceof Error ? error.message : String(error),
    fix: 'A policy that cannot answer must not be read as a yes. Fix the policy in lib/app/authorization.ts.',
  });
}

/**
 * May `viewer` use an admin surface? The question `withAdminAuth` and the admin
 * layout ask.
 *
 * @param resource what is being administered, or `null` when the route did not
 *   supply a `resource` resolver.
 */
export async function canAdminister(
  viewer: AuthorizationPrincipal,
  resource: AuthorizationResource | null = null,
  scope: AuthorizationScope = {}
): Promise<boolean> {
  try {
    return await getAuthorizationPolicy().canAdminister(viewer, resource, scope);
  } catch (error) {
    denyAfterThrow('canAdminister', error, viewer);
    return false;
  }
}

/**
 * May `viewer` read `subject`'s data? `subject` is a user id, or `null` when the
 * route declared none.
 */
export async function canRead(
  viewer: AuthorizationPrincipal,
  subject: string | null,
  scope: AuthorizationScope = {}
): Promise<boolean> {
  try {
    return await getAuthorizationPolicy().canRead(viewer, subject, scope);
  } catch (error) {
    denyAfterThrow('canRead', error, viewer);
    return false;
  }
}

/**
 * Which subjects may `viewer` see? `AND` this into a list query so the list and
 * the single-row read cannot disagree.
 *
 * On a throwing policy this narrows to the viewer's own rows rather than
 * returning `{}`: `{}` is the *widest* value this type can express, so the
 * fail-closed answer is the narrow one.
 */
export async function subjectScope(
  viewer: AuthorizationPrincipal,
  scope: AuthorizationScope = {}
): Promise<SubjectFilter> {
  try {
    return await getAuthorizationPolicy().subjectScope(viewer, scope);
  } catch (error) {
    denyAfterThrow('subjectScope', error, viewer);
    return { userId: viewer.userId };
  }
}

/** Does a `where` fragment from {@link subjectScope} select `subject`? */
export function subjectFilterSelects(filter: SubjectFilter, subject: string): boolean {
  // No `userId` key is "every subject" — which is why the check is for the key
  // being absent, not for it being falsy.
  return filter.userId === undefined || filter.userId === subject;
}

/** One principal, and the subjects to check the two read faces against. */
export interface AuthorizationParityCase {
  /** Names the case in a violation. Defaults to the principal's user id. */
  label?: string;
  viewer: AuthorizationPrincipal;
  /** Concrete subject ids. Include at least the viewer and one other. */
  subjects: readonly string[];
  scope?: AuthorizationScope;
}

/** One disagreement between `canRead` and `subjectScope`. */
export interface AuthorizationParityViolation {
  /** The case's `label`, or the viewer's user id. */
  case: string;
  /** The subject the two faces disagreed about, or `'(none)'` for a setup fault. */
  subject: string;
  /** What `canRead` said, when it was asked. */
  canRead?: boolean;
  /** Whether `subjectScope`'s fragment selects the subject, when it was asked. */
  inSubjectScope?: boolean;
  /** What is wrong, in a sentence an assertion message can print verbatim. */
  message: string;
}

/**
 * Check that a policy's two read faces agree, and report every disagreement.
 *
 * A pure function returning violations rather than an assertion helper, and no
 * vitest import — a fork's own harness (or a runtime health check) can call it,
 * and Sunrise's thin assertion lives in `tests/`.
 *
 * **It reports setup faults as violations too**, which is not padding: a parity
 * check run over zero cases, or over a case with no subjects, passes while
 * proving nothing. That is the failure mode this whole file is written against,
 * and a checker is not exempt from it.
 *
 * ```ts
 * const violations = await checkAuthorizationParity(myPolicy, [
 *   { label: 'a member', viewer: { userId: 'u1', credential: 'session' }, subjects: ['u1', 'u2'] },
 * ]);
 * expect(violations).toEqual([]);
 * ```
 */
export async function checkAuthorizationParity(
  policy: AuthorizationPolicy,
  cases: readonly AuthorizationParityCase[]
): Promise<AuthorizationParityViolation[]> {
  const violations: AuthorizationParityViolation[] = [];

  if (cases.length === 0) {
    return [
      {
        case: '(no cases)',
        subject: '(none)',
        message:
          'checkAuthorizationParity was called with no cases, so it could not have found a violation. Pass at least one principal with at least two subjects.',
      },
    ];
  }

  for (const testCase of cases) {
    const name = testCase.label ?? testCase.viewer.userId;
    const scope = testCase.scope ?? {};

    if (testCase.subjects.length === 0) {
      violations.push({
        case: name,
        subject: '(none)',
        message: `Case "${name}" names no subjects, so nothing was compared for it.`,
      });
      continue;
    }

    const filter = await policy.subjectScope(testCase.viewer, scope);

    for (const subject of testCase.subjects) {
      const readable = await policy.canRead(testCase.viewer, subject, scope);
      const selected = subjectFilterSelects(filter, subject);
      if (readable === selected) continue;

      violations.push({
        case: name,
        subject,
        canRead: readable,
        inSubjectScope: selected,
        message: readable
          ? `Case "${name}": canRead permits subject "${subject}" but subjectScope hides it — a single-row read succeeds where the list it belongs to comes back empty.`
          : `Case "${name}": subjectScope selects subject "${subject}" but canRead denies it — the list leaks a row the detail view refuses.`,
      });
    }
  }

  return violations;
}
