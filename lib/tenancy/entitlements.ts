/**
 * Entitlement switches: what an org can have (§135 t-1033).
 *
 * Sunrise could limit and measure an org (§110's caps and usage) but had no
 * way for an app to say what an org has bought. An app that sells parts of
 * itself kept that in its own `Org.settings` key under names it had to guess,
 * and billing later renamed them. This is the one place it lives instead: an
 * app registers its switches from `lib/app/entitlements.ts`, platform staff set
 * them per org (`PUT /api/v1/admin/orgs/[id]/entitlements`), and the app reads
 * them here. When billing arrives it becomes a second writer of the same
 * slice; nothing that reads a switch changes.
 *
 * **Two states, never collapsed.** An org nobody has set anything on answers
 * each switch's `whenNothingSet`, so an app can leave every org that exists
 * today as it is while a new area fails closed. An org that has been set
 * answers exactly what was set. `{ switches: [] }` is "set, with nothing on",
 * and is not the same as no slice at all.
 *
 * **What it does not do.** Nothing here refuses a request. Requiring a switch
 * on a page, route or menu item is the admin-tier declaration's job (§135
 * t-1034), read by the authorization policy so menus and routes agree. A
 * platform admin is not limited by switches.
 *
 * **Registration is synchronous and runs lazily** before the first read, in
 * whichever realm reads first (`platform.seam-realm`), through the shared
 * init gate: a throwing init rolls back every switch it registered.
 *
 * @see lib/app/entitlements.ts — the fork's scaffold
 * @see lib/tenancy/org-settings.ts — the stored slice, read and written
 * @see .context/tenancy/entitlements.md
 */

import type { PrismaClient } from '@prisma/client';

import { initAppEntitlements } from '@/lib/app/entitlements';
import { prisma } from '@/lib/db/client';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { loadOrgEntitlements, type OrgEntitlementsRead } from '@/lib/tenancy/org-settings';
import { ENTITLEMENT_KEY_PATTERN } from '@/lib/validations/tenancy';

/** A switch as an app registers it. */
export interface EntitlementSwitch {
  /**
   * What is stored on an org, and what a surface names to require it:
   * lower-case letters, digits and underscores, starting with a letter. Do not
   * rename one that orgs already hold; register a new key instead.
   */
  key: string;
  /** What platform staff see beside it, in plain words. */
  label: string;
  /** One line saying what it opens, shown with the label. */
  description: string;
  /**
   * What an org nobody has set anything on gets. Off by default, so a new
   * area opens only where someone switches it on.
   */
  whenNothingSet?: boolean;
}

/** A registered switch, with `whenNothingSet` filled in. */
export type RegisteredEntitlementSwitch = Readonly<Required<EntitlementSwitch>>;

/**
 * One org's switches as an app reads them.
 *
 * `on` lists the registered switches the org has, in registration order.
 * `unregistered` lists keys stored on the org that no app registers (an app
 * stopped registering one, or a process running older code); they read as off
 * and a save from the admin keeps them.
 */
export interface OrgSwitches {
  nothingSet: boolean;
  unreadable: boolean;
  on: readonly string[];
  unregistered: readonly string[];
}

const switches = new Map<string, RegisteredEntitlementSwitch>();

/**
 * Register a switch. Call from `initAppEntitlements()` in
 * `lib/app/entitlements.ts`. Re-registering a key replaces it, as the other
 * registries do. A key that is not a key, or an empty label, throws, which
 * rolls back every switch the init registered and logs why.
 */
export function registerEntitlementSwitch(definition: EntitlementSwitch): void {
  if (!ENTITLEMENT_KEY_PATTERN.test(definition.key)) {
    throw new Error(
      `Entitlement switch key "${definition.key}" must be lower-case letters, digits and underscores, starting with a letter, at most 48 characters`
    );
  }
  const label = definition.label.trim();
  if (label.length === 0) {
    throw new Error(`Entitlement switch "${definition.key}" needs a label`);
  }
  switches.set(
    definition.key,
    Object.freeze({
      key: definition.key,
      label,
      description: definition.description.trim(),
      whenNothingSet: definition.whenNothingSet ?? false,
    })
  );
}

const appInit = createAppInitGate({
  label: 'entitlements: initAppEntitlements',
  // Half an app's switches registered would give some orgs some of what they
  // bought, which is harder to notice than none.
  subject: 'app entitlement switches',
  init: initAppEntitlements,
  snapshot: () => new Map(switches),
  restore: (before) => restoreMap(switches, before),
});

/** Every registered switch, in registration order. Empty on vanilla Sunrise. */
export function registeredEntitlementSwitches(): readonly RegisteredEntitlementSwitch[] {
  appInit.ensure();
  return [...switches.values()];
}

/** One registered switch, or `undefined` when no app registers that key. */
export function registeredEntitlementSwitch(key: string): RegisteredEntitlementSwitch | undefined {
  appInit.ensure();
  return switches.get(key);
}

/**
 * What an org's stored switches mean, against the switches registered now.
 *
 * Pure, so a caller that already holds the org's `settings` (a list page
 * reading many orgs at once) resolves each without another query: pass it
 * `readOrgEntitlements(org.settings)`.
 */
export function resolveOrgSwitches(read: OrgEntitlementsRead): OrgSwitches {
  const registered = registeredEntitlementSwitches();
  if (!read.set) {
    return {
      nothingSet: true,
      unreadable: false,
      on: registered.filter((s) => s.whenNothingSet).map((s) => s.key),
      unregistered: [],
    };
  }
  const stored = new Set(read.switches);
  const known = new Set(registered.map((s) => s.key));
  return {
    nothingSet: false,
    unreadable: read.unreadable,
    on: registered.filter((s) => stored.has(s.key)).map((s) => s.key),
    unregistered: read.switches.filter((key) => !known.has(key)),
  };
}

/** One org's switches, or `null` when there is no such org. */
export async function loadOrgSwitches(
  orgId: string,
  db: Pick<PrismaClient, 'org'> = prisma
): Promise<OrgSwitches | null> {
  const read = await loadOrgEntitlements(orgId, db);
  return read ? resolveOrgSwitches(read) : null;
}

/**
 * Whether an org has one switch. `false` for an org that does not exist and
 * for a key no app registers, so a typo fails closed.
 */
export async function orgHasSwitch(
  orgId: string,
  key: string,
  db: Pick<PrismaClient, 'org'> = prisma
): Promise<boolean> {
  const org = await loadOrgSwitches(orgId, db);
  return org !== null && org.on.includes(key);
}

/** Test-only: clear the registry and re-arm the one-shot app init. */
export function __resetEntitlementRegistryForTests(): void {
  switches.clear();
  appInit.reset();
}
