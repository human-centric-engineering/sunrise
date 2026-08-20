/**
 * Account-section registry (fork-readiness seam).
 *
 * Lets an app built on Sunrise add its own section to the authenticated
 * account surface — `/profile` and `/settings` — without editing either page.
 * The account-surface analogue of `lib/admin-nav/registry.ts`, which has let a
 * fork add admin-sidebar sections since v0.0.1; the account pages simply never
 * had the equivalent, so a fork adding "Connect your GitHub account" or a
 * billing panel edited a Sunrise-owned page and took a conflict on every sync
 * (#595).
 *
 * **Registration must be synchronous and module-import-time.** The consumer
 * (`components/account/account-sections.tsx`) reads this registry during
 * render. An app registers from `lib/app/account-sections.ts`, which
 * `getRegisteredAccountSections()` runs once, lazily, before its first read —
 * so the registry is populated whichever page renders first. Do NOT make
 * registration async or DB-driven.
 *
 * Empty registry renders nothing, so vanilla Sunrise is visually unchanged.
 *
 * @see components/account/account-sections.tsx — the consumer that renders these
 * @see lib/app/account-sections.ts — the fork-owned scaffold
 */

import type { ComponentType } from 'react';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { initAppAccountSections } from '@/lib/app/account-sections';

/** The two pages that render account sections. */
export const ACCOUNT_SURFACES = ['profile', 'settings'] as const;
export type AccountSurface = (typeof ACCOUNT_SURFACES)[number];

/** Props every registered section receives. */
export interface AccountSectionProps {
  /** The signed-in user the page is rendering for. */
  userId: string;
}

/** A section rendered at the foot of `/profile` and/or `/settings`. */
export interface AccountSection {
  /** Stable key. Also the registry's dedupe key and the React key. */
  id: string;
  /**
   * Which pages this section appears on. Defaults to **both** — the driving
   * case (an account connection) belongs on both, and a section that only
   * makes sense on one would otherwise have to work that out from props it is
   * not given.
   */
  surfaces?: readonly AccountSurface[];
  /** Ascending. Equal values keep first-registration order. Defaults to 0. */
  order?: number;
  /** Rendered as `<Component userId={…} />`. May be a server or client component. */
  Component: ComponentType<AccountSectionProps>;
}

const sections = new Map<string, AccountSection>();

/**
 * Register an account section. Call at module-import time from
 * `lib/app/account-sections.ts`. Idempotent by `id` — re-registering the same
 * id replaces the prior section (safe under HMR / repeated module imports),
 * mirroring the nav and capability registries.
 */
export function registerAccountSection(section: AccountSection): void {
  sections.set(section.id, section);
}

/**
 * Run the fork's auto-wired init exactly once, lazily, rolling a partial init
 * back — see `lib/fork-init.ts` for the shared contract.
 *
 * **This covers registration, not render.** A section that throws while
 * rendering still fails the page, which then falls to
 * `app/(protected)/error.tsx` rather than a blank 500 — but the user is off the
 * page they came to change a password or delete an account on. Sunrise does not
 * wrap each section in a boundary of its own, because a React error boundary is
 * a client component and cannot catch a throw inside an async server section,
 * so it would guard some sections and not others. If your section can fail on
 * data (a missing subscription row is the usual one), handle that inside it.
 */
const appInit = createAppInitGate({
  label: 'account-sections: initAppAccountSections',
  // Half a fork's account surface rendering on /profile and /settings, while
  // the log says none of it did, is worse than none of it rendering.
  subject: 'app sections',
  init: initAppAccountSections,
  snapshot: () => new Map(sections),
  restore: (before) => restoreMap(sections, before),
});

/**
 * Sections for one surface, in `order` then first-registration order.
 *
 * `Array.prototype.sort` is specified as stable, so equal `order` values keep
 * insertion order without a tiebreaker.
 */
export function getRegisteredAccountSections(surface: AccountSurface): AccountSection[] {
  appInit.ensure();
  return [...sections.values()]
    .filter((s) => (s.surfaces ?? ACCOUNT_SURFACES).includes(surface))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Test-only: clear the registry and re-arm the one-shot app init. */
export function __resetAccountSectionRegistryForTests(): void {
  sections.clear();
  appInit.reset();
}
