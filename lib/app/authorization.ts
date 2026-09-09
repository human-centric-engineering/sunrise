/**
 * App authorization policy registration.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * Auto-wired: `getAuthorizationPolicy()` in `lib/auth/authorization.ts` runs
 * this once, lazily, before the first read — which happens at the top of every
 * guarded request. You register; you wire nothing.
 *
 * Register a policy and you replace the **administer** decision at all three
 * places Sunrise makes one: `withAdminAuth`, the admin layout, and the
 * maintenance-mode bypass. There are 262 `withAdminAuth` handlers behind the
 * first of those — 257 of them under `/api/v1/admin` — and none of them
 * changes.
 *
 * `withAuth` is the fourth place the policy is consulted, but it asks
 * `canRead`, not `canAdminister`: overriding the administer face alone does
 * nothing to its 23 handlers.
 *
 * **The read decision is not yet fully behind the seam**, and you need to know
 * that before trusting a narrowing `canRead`: `app/api/v1/users/[id]` (GET)
 * still decides from the platform role inline, so a platform `ADMIN` reads
 * every user row through it whatever your policy says.
 * `lib/auth/authorization.ts`'s module header carries the detail; #738 tracks it.
 *
 * The two cases this exists for:
 *
 *  - **A second admin tier** (#366). "Admin of this org" is not "staff of the
 *    platform". Sunrise's global `ADMIN` is the second one; give the first its
 *    own answer in `canAdminister` rather than handing a customer the whole
 *    install.
 *  - **Ownership within one tenant** (#367). Each leader sees the questionnaires
 *    they created, not everyone's — `canRead` for the single row and
 *    `subjectScope` for the list.
 *
 * @example An org-scoped admin tier, with reads still self-or-staff.
 * ```ts
 * import {
 *   registerAuthorizationPolicy,
 *   DEFAULT_AUTHORIZATION_POLICY,
 * } from '@/lib/auth/authorization';
 * import { orgRoleOf } from '@/lib/app/orgs';
 *
 * export function initAppAuthorizationPolicy(): void {
 *   registerAuthorizationPolicy({
 *     ...DEFAULT_AUTHORIZATION_POLICY,
 *     canAdminister: async (viewer, resource, scope) => {
 *       if (await DEFAULT_AUTHORIZATION_POLICY.canAdminister(viewer, resource, scope)) return true;
 *       const org = resource?.orgId ?? scope.org;
 *       return org ? (await orgRoleOf(viewer.userId, org)) === 'ADMIN' : false;
 *     },
 *   });
 * }
 * ```
 *
 * @example Owner-scoped reads. Both faces, together — see the warning below.
 * ```ts
 * export function initAppAuthorizationPolicy(): void {
 *   registerAuthorizationPolicy({
 *     ...DEFAULT_AUTHORIZATION_POLICY,
 *     canRead: async (viewer, target) => {
 *       switch (target.kind) {
 *         case 'nothing':      return true;   // the route named no resource
 *         case 'unattributed': return false;  // named a row with no owner
 *         case 'subject':
 *           return (
 *             target.userId === viewer.userId ||
 *             (await isTeamMate(viewer.userId, target.userId))
 *           );
 *       }
 *     },
 *     subjectScope: async (viewer) => ({ userId: viewer.userId }),
 *   });
 * }
 * ```
 *
 * You must answer all three arms and the compiler holds you to it: a `switch`
 * that misses one returns `undefined`, which does not satisfy `Promise<boolean>`,
 * so your build fails rather than your install quietly permitting something.
 * That is not defensiveness for its own sake — the previous signature took a
 * `subject: string | null`, and the natural line to write against it,
 * `subject === null || subject === viewer.userId`, permitted every caller for
 * any row without an owner while reading exactly like a check.
 *
 * Before you write one:
 *
 *  - **`canRead` and `subjectScope` are one rule in two shapes, and nothing
 *    makes them agree but you.** The pair above is deliberately WRONG as
 *    written: `canRead` permits a teammate's row that `subjectScope` hides, so a
 *    detail page opens a record its own list does not contain. Run
 *    `checkAuthorizationParity(yourPolicy, cases)` — exported from
 *    `lib/auth/authorization.ts` with no test-framework dependency — in your own
 *    test suite, and it names the subject the two faces disagree about. **Give
 *    each case a subject the viewer is not**: a self-only case is clean under
 *    every self-inclusive policy, correct or not, and the checker now reports
 *    that as a fault rather than passing it.
 *  - **`'unattributed'` is the arm to think hardest about.** It is a row your
 *    resolver named and could not attribute: an org-owned row, or a nullable
 *    `createdBy` on a `SetNull` model, which `CLAUDE.md` mandates for retained
 *    config and audit models. Sunrise's default narrows it to platform staff
 *    and logs once per kind; if you spread the default and do not answer it
 *    yourself, your org members are denied rather than silently permitted.
 *  - **A resolver that returns `null`, or throws, denies the request** before
 *    your policy is consulted — it is not a state you can widen, and it never
 *    reaches `canRead`. `'nothing'` means the route declared no resolver at
 *    all, which is a decision visible in that route's source.
 *  - **Register the whole policy, not a patch.** Spread
 *    `DEFAULT_AUTHORIZATION_POLICY` when you mean to change one face, as above.
 *    The copy is then visible at your call site rather than merged behind your
 *    back, which is what keeps "I overrode `canRead` and forgot `subjectScope`"
 *    a thing you can see in your own diff.
 *  - **`subjectScope` returns `{}` for "everyone", not a wildcard.** No `userId`
 *    key means no narrowing, so widening later is deleting a key rather than
 *    editing every query that `AND`s the fragment in.
 *  - **It runs on the request hot path** — every guarded API request and every
 *    render of the admin layout. Cache what you look up; do not query per call.
 *  - **Throwing denies, it never permits**, and is logged. A restriction that
 *    cannot be evaluated is not permission.
 *  - **Throwing HERE, while registering, puts the install in safe mode** for the
 *    life of the process: `canAdminister` denies everyone, so the admin console
 *    closes. Sunrise deliberately does not fall back to its own default policy —
 *    yours usually narrows it, so falling back would widen access under a log
 *    line saying the feature was disabled. Register synchronously and do your
 *    loading elsewhere.
 *  - **This seam must be synchronous, and here that is a security property.**
 *    Making it `async` means the gate sees the promise rather than the work, so
 *    it latches success immediately: your policy is not registered yet, and
 *    every read in that window — and every read forever, if your promise
 *    rejects — gets Sunrise's DEFAULT policy, the widest one, while the
 *    safe-mode machinery above reports nothing wrong. Lint catches it
 *    (`@typescript-eslint/no-misused-promises`) and #739 tracks making the gate
 *    itself refuse. Do your loading elsewhere and register synchronously.
 *  - **An `admin`-scoped API key bypasses the role check** and always has: the
 *    scope is the capability. The design record pins that scope as
 *    platform-only (Q6), and minting one already requires a platform admin with
 *    a browser session. Keys do not carry an org yet, so "an org-bound key can
 *    never hold `admin`" is not something this seam can enforce today — that
 *    arrives with the org axis.
 *
 * Full guide: .context/auth/authorization.md · CUSTOMIZATION.md §4 ·
 * lib/auth/authorization.ts
 */
export function initAppAuthorizationPolicy(): void {
  // No app authorization policy by default: platform admin administers
  // everything and reads everyone, and everyone else reads themselves — which
  // is Sunrise's single-tenant behaviour.
}
