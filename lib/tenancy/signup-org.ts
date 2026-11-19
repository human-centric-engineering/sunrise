/**
 * Which org a self-serve signup lands in at `multi` (§134 t-1062, sunrise#1232).
 *
 * At `multi` the install org is the vendor's own and holds the control plane,
 * so a stranger who signs up must not become a member of it. **By default a
 * self-serve signup gets an org of their own, as its `OWNER`**, and their
 * first session starts in it. An app replaces that default by registering a
 * resolver in `lib/app/signup-org.ts`: join an existing org (matched on the
 * email domain, say), stay in the install org as before this shipped, or a
 * new org of their own under a name the app chooses.
 *
 * **Who is asked.** Only a self-serve signup at `multi`: someone with no
 * invitation, or one let in from the install org's own waitlist (that
 * invitation names no org). Never an invited signup (an org's own waitlist
 * invitation names that org), never platform staff (the first human on a
 * fresh database), and nobody at `single`, where nothing here changes.
 *
 * **Asked before anything is written.** `userCreateBeforeHook`
 * (`lib/auth/config.ts`) asks through {@link signupOrgMemberships} while it
 * decides the membership, so the decision lands on the user row
 * (`User.signupOrgId` / `signupOrgRole`) and the request state like any
 * other, the after hook writes exactly one membership, and the first session
 * starts in that org. Asking after the user exists (the user-created seam)
 * would leave a window, and a failure, in which they stay in the vendor's org.
 *
 * **A fault in app code never refuses a signup.** A resolver that throws, runs
 * past {@link SIGNUP_ORG_RESOLVER_TIMEOUT_MS}, answers nothing or something
 * malformed, or names an org that does not exist, falls back to the decision
 * as it was before this shipped (the install org), logged at `error`.
 *
 * **The org exists before the user does,** because the user row names it. So
 * a signup that fails after the org is made (the user INSERT refused) would
 * leave an org with no member. Such an org is marked: `createSignupOrg()`
 * writes `Org.settings.awaitingFounder`, and the transaction that writes the
 * founder's membership removes it. {@link sweepAbandonedSignupOrgs} deletes a
 * marked org with no member that no user's signup record names, once it is
 * older than {@link SIGNUP_ORG_ABANDONED_AFTER_MS}. The mark tells it from a
 * live org that has lost its members: that org had a founder, so its mark is
 * gone, and it is never deleted here.
 *
 * **Its setup waits for a founder who can act.** The app's org-created hooks
 * (which may provision paid resources) and the platform agents run once the
 * founder is a member and can act there: the install does not require a
 * verified address (`REQUIRE_EMAIL_VERIFICATION`), or theirs is verified, or
 * they have signed in. Until then the org keeps its mark, so an email signup
 * with an address nobody proves runs none of the app's setup (the
 * `platformAgents` job may still place agents). That setup runs after the
 * response, never on the signup request.
 *
 * @see lib/app/signup-org.ts — the fork-owned registration seam
 * @see lib/tenancy/lifecycle.ts — `createSignupOrg()`, `completeSignupOrg()`
 * @see .context/tenancy/identity.md — the guide
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { createAppInitGate } from '@/lib/fork-init';
import { initAppSignupOrgResolver } from '@/lib/app/signup-org';
import { withTimeout } from '@/lib/utils/with-timeout';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant } from '@/lib/tenancy/context';
import { createSignupOrg } from '@/lib/tenancy/lifecycle';
import { refuseOverSeatsLimit } from '@/lib/tenancy/meters';
import { ORG_AWAITING_FOUNDER_KEY } from '@/lib/tenancy/org-settings';
import {
  invitedOrgId,
  isPlatformStaff,
  type AcceptedInvitation,
  type NewUserMemberships,
  type NewUserShape,
} from '@/lib/tenancy/membership';
import { DEFAULT_ORG_ROLE, ORG_OWNER_ROLE, ORG_ROLES, type OrgRole } from '@/lib/tenancy/roles';

/** The person signing up, as a resolver is told them. */
export interface SignupOrgRequest {
  /** The address they signed up with. */
  email: string;
  /**
   * Whether the address is proven yet: false on an email signup, whose
   * verification comes after this; on an OAuth signup, whatever the provider
   * says, which can be false. Never infer it from `signupMethod`. Where the install
   * requires verification before sign-in (`REQUIRE_EMAIL_VERIFICATION`, the
   * production default), an unproven address can never use the account; where
   * it does not, anyone can sign up as any address.
   */
  emailVerified: boolean;
  /** The name they gave, or the OAuth provider's. May be empty. */
  name: string;
  /** `oauth` for a social sign-in, `email` for email and password. */
  signupMethod: 'email' | 'oauth';
  /** The install waitlist entry whose invitation let them in, or `null` for a public signup. */
  waitlistEntryId: string | null;
}

/**
 * Where a resolver sends a self-serve signup.
 *
 * - `own`: a new org of their own, as its `OWNER` (the default). `name` is the
 *   org's display name; absent, the platform's ("Ada's organisation").
 * - `join`: an org that exists, with `role` (default `MEMBER`). The role is
 *   taken as given, `OWNER` included, so name one only when the match proves
 *   the person should hold it.
 * - `install`: the install org, with the role its rule gives (as before this
 *   shipped).
 */
export type SignupOrgAnswer =
  | { kind: 'own'; name?: string }
  | { kind: 'join'; orgId: string; role?: OrgRole }
  | { kind: 'install' };

/**
 * An app's signup-org resolver. Return `null` or `undefined` only when
 * something is wrong: that is logged at `error` and treated as `install`. To
 * keep the default, return `{ kind: 'own' }`.
 */
export type SignupOrgResolver = (
  request: SignupOrgRequest
) => SignupOrgAnswer | null | undefined | Promise<SignupOrgAnswer | null | undefined>;

/** How long a resolver may take before the signup stops waiting and falls back. */
export const SIGNUP_ORG_RESOLVER_TIMEOUT_MS = 5_000;

/**
 * How old a marked org with no member must be before
 * {@link sweepAbandonedSignupOrgs} deletes it. The founder's user row, which
 * then protects it, is written milliseconds after the org; an hour leaves a
 * signup still in flight alone by a wide margin.
 */
export const SIGNUP_ORG_ABANDONED_AFTER_MS = 60 * 60 * 1000;

/** The most abandoned orgs one maintenance tick deletes. */
export const SIGNUP_ORG_SWEEP_BATCH = 100;

const ORG_NAME_MAX = 100;

/** A resolver's answer is app code's output: validated, not trusted. */
const answerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('own'), name: z.string().trim().min(1).max(ORG_NAME_MAX).optional() }),
  z.object({
    kind: z.literal('join'),
    orgId: z.string().min(1),
    role: z.enum(ORG_ROLES).optional(),
  }),
  z.object({ kind: z.literal('install') }),
]);

let resolver: SignupOrgResolver | null = null;

/**
 * Register the install's signup-org resolver. Call it inside
 * `initAppSignupOrgResolver()` in `lib/app/signup-org.ts`; registering twice
 * replaces the first.
 */
export function registerSignupOrgResolver(next: SignupOrgResolver): void {
  resolver = next;
}

/**
 * Run the fork's init once, lazily, before the first signup asks — see
 * `lib/fork-init.ts`. Rolled back on a throw, so a resolver left by a partial
 * init does not decide signups under a log line that says it did not load.
 */
const appInit = createAppInitGate({
  label: 'signup-org: initAppSignupOrgResolver',
  subject: 'app resolver',
  init: initAppSignupOrgResolver,
  snapshot: () => resolver,
  restore: (before) => {
    resolver = before;
  },
});

/** True when the app has registered a resolver. Runs the fork's init first. */
export function hasSignupOrgResolver(): boolean {
  appInit.ensure();
  return resolver !== null;
}

/** Test-only: forget the registered resolver and re-arm the one-shot init. */
export function __resetSignupOrgResolverForTests(): void {
  resolver = null;
  appInit.reset();
}

/**
 * Is this signup asked where it lands? Only at `multi`, only for someone who
 * is not platform staff (judged on the role an invitation grants, as the
 * membership rule is), and only when no invitation admitted them or the one
 * that did came from the install org's waitlist. `viaInvitation` is whether a
 * token was redeemed: an OAuth signup whose token had no readable record is
 * invited even though `invitation` is `null`, and is not asked.
 */
export function asksSignupOrg(
  user: NewUserShape,
  invitation: (AcceptedInvitation & { waitlistEntryId?: string | null }) | null,
  viaInvitation: boolean
): boolean {
  if (!isMultiTenant()) return false;
  if (isPlatformStaff({ ...user, role: invitation?.role ?? user.role })) return false;
  if (!viaInvitation) return true;
  return (
    invitation !== null &&
    invitedOrgId(invitation) === INSTALL_ORG_ID &&
    Boolean(invitation.waitlistEntryId)
  );
}

/**
 * The membership a self-serve signup gets, or `null` for the decision as it
 * was before this shipped (the install org). Asked only when
 * {@link asksSignupOrg} says so. Never throws: every failure is logged at
 * `error` and answers `null`, because the signup hooks never refuse a signup
 * over a fault.
 *
 * For `own` (and the default, with no resolver registered) this creates the
 * org, through `createSignupOrg()`.
 */
export async function signupOrgMemberships(
  user: NewUserShape & { email: string; name: string; emailVerified: boolean },
  request: Omit<SignupOrgRequest, 'email' | 'name' | 'emailVerified'>
): Promise<NewUserMemberships | null> {
  const log = { email: user.email, signupMethod: request.signupMethod };
  try {
    appInit.ensure();
    const answer: SignupOrgAnswer | null = resolver
      ? await askResolver(resolver, {
          email: user.email,
          name: user.name,
          emailVerified: user.emailVerified,
          ...request,
        })
      : { kind: 'own' };
    if (!answer) return null;

    if (answer.kind === 'install') return null;
    if (answer.kind === 'join') {
      if (answer.orgId === INSTALL_ORG_ID) return null;
      const org = await prisma.org.findUnique({
        where: { id: answer.orgId },
        select: { id: true, status: true, settings: true },
      });
      // A suspended org would refuse their every request from the first, and
      // one still awaiting its own founder is another signup's. Both are a
      // resolver bug, not a place to put someone.
      const unusable = !org
        ? 'does not exist'
        : org.status !== 'ACTIVE'
          ? 'is not active'
          : isAwaitingFounder(org.settings)
            ? 'is still awaiting its own founder'
            : null;
      if (!org || unusable) {
        logger.error(`Signup-org resolver named an org that ${unusable}; using the install org`, {
          ...log,
          orgId: answer.orgId,
        });
        return null;
      }
      // The seat it takes is counted as `addMember()` counts one; a full org
      // is a fallback like the rest, not a refusal of the signup.
      const full = await refuseOverSeatsLimit(org.id, { platformAdmin: false }).then(
        () => false,
        (error: unknown) => {
          logger.error(
            'Signup-org resolver named an org at its seats limit; using the install org',
            error,
            { ...log, orgId: org.id }
          );
          return true;
        }
      );
      if (full) return null;
      return { membership: { orgId: org.id, role: answer.role ?? DEFAULT_ORG_ROLE } };
    }

    const name = answer.name ?? defaultOrgName(user);
    const org = await createSignupOrg({ name, slug: signupOrgSlug(name) });
    return { membership: { orgId: org.id, role: ORG_OWNER_ROLE } };
  } catch (error) {
    logger.error('Failed to decide a signup’s own org; using the install org', error, log);
    return null;
  }
}

/** Ask the resolver, bounded, and validate what it says. `null` means fall back (logged here). */
async function askResolver(
  ask: SignupOrgResolver,
  request: SignupOrgRequest
): Promise<SignupOrgAnswer | null> {
  const log = { email: request.email, signupMethod: request.signupMethod };
  let raw: unknown;
  try {
    raw = await withTimeout(SIGNUP_ORG_RESOLVER_TIMEOUT_MS, 'signup-org resolver', () =>
      Promise.resolve(ask(request))
    );
  } catch (error) {
    logger.error('Signup-org resolver failed; using the install org', error, log);
    return null;
  }
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) {
    logger.error('Signup-org resolver gave no usable answer; using the install org', {
      ...log,
      answered: raw === null || raw === undefined ? String(raw) : typeof raw,
      issues: parsed.error.issues.map((issue) => issue.message),
    });
    return null;
  }
  return parsed.data;
}

/** "Ada Lovelace's organisation", from the name they gave, else their address's local part. */
function defaultOrgName(user: { email: string; name: string }): string {
  const who = user.name.trim() || user.email.split('@')[0].trim();
  if (!who) return 'New organisation';
  const suffix = '’s organisation';
  // By code point, so a cut never splits a surrogate pair (an emoji).
  return `${Array.from(who)
    .slice(0, ORG_NAME_MAX - suffix.length)
    .join('')}${suffix}`;
}

/** Whether an org's settings still carry the awaiting-founder mark. */
function isAwaitingFounder(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    ORG_AWAITING_FOUNDER_KEY in settings
  );
}

/**
 * A slug for a new signup org: the name in slug form, cut short, and a random
 * suffix so two people with the same name never collide. Not the address: a
 * slug can appear in URLs.
 */
function signupOrgSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    // Drop the accents NFKD split off, so "Renée" is "renee", not "rene-e".
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const suffix = randomBytes(4).toString('hex');
  return base ? `${base}-${suffix}` : `org-${suffix}`;
}

/** What one sweep did. */
export interface SignupOrgSweepResult {
  deleted: number;
}

/**
 * The `abandonedSignupOrgs` maintenance job: delete the orgs a self-serve
 * signup made whose signup then failed.
 *
 * An org is abandoned when it **still carries the awaiting-founder mark**
 * (never had a founder), **has no member**, **no user's signup record names
 * it** (a founder whose membership write failed is healed into it at their
 * next sign-in), and is **older than {@link SIGNUP_ORG_ABANDONED_AFTER_MS}**
 * (a signup in flight is left alone). All four are tested in the one DELETE,
 * so nothing that changes between a read and the write can be lost. The
 * install org is never one. What the org's row cascades to goes with it;
 * nothing else can be in it, since nobody could act there.
 *
 * Runs in the system scope (the org table has no row policy). At `single` no
 * signup org is made, so it returns without a query.
 */
export async function sweepAbandonedSignupOrgs(): Promise<SignupOrgSweepResult> {
  if (!isMultiTenant()) return { deleted: 0 };
  const deleted = await prisma.$queryRaw<Array<{ id: string }>>`
    DELETE FROM org
     WHERE id IN (
       SELECT o.id FROM org o
        WHERE o.settings ? ${ORG_AWAITING_FOUNDER_KEY}
          AND o.id <> ${INSTALL_ORG_ID}
          AND o."createdAt" < now() - ${SIGNUP_ORG_ABANDONED_AFTER_MS} * interval '1 millisecond'
          AND NOT EXISTS (SELECT 1 FROM org_membership m WHERE m."orgId" = o.id)
          AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u."signupOrgId" = o.id)
        LIMIT ${SIGNUP_ORG_SWEEP_BATCH}
     )
       AND settings ? ${ORG_AWAITING_FOUNDER_KEY}
       AND NOT EXISTS (SELECT 1 FROM org_membership m WHERE m."orgId" = org.id)
       AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u."signupOrgId" = org.id)
 RETURNING id`;
  if (deleted.length > 0) {
    logger.warn('Deleted orgs left by signups that failed', {
      orgIds: deleted.map((row) => row.id),
    });
  }
  return { deleted: deleted.length };
}
