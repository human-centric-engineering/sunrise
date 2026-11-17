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
 * **Set or not set, per switch, never collapsed.** A switch nobody has set on
 * an org answers its `whenNothingSet`, so an app can leave every org that
 * exists today as it is while a new area fails closed. A switch that has been
 * set answers what was set: set off is not the same as not set. Because it is
 * per switch, a switch registered later reaches an org that was saved before
 * it existed with its default, rather than reading as off there.
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
   * What an org gets while nobody has set this switch on it. Off by default,
   * so a new area opens only where someone switches it on.
   */
  whenNothingSet?: boolean;
}

/** A registered switch, with `whenNothingSet` filled in. */
export type RegisteredEntitlementSwitch = Readonly<Required<EntitlementSwitch>>;

/**
 * One org's switches as an app reads them.
 *
 * `on` lists the registered switches the org has, in registration order.
 * `atDefault` lists the registered switches nobody has set on the org, which
 * follow their `whenNothingSet`; `nothingSet` says that is all of them.
 * `unregistered` lists keys stored on that no app registers (an app stopped
 * registering one, or a process running older code); they read as off, and a
 * save from the admin keeps them, as it keeps any such key stored off.
 * `unreadable` says the stored slice could not be read, so the org has none.
 */
export interface OrgSwitches {
  nothingSet: boolean;
  unreadable: boolean;
  on: readonly string[];
  atDefault: readonly string[];
  unregistered: readonly string[];
}

const switches = new Map<string, RegisteredEntitlementSwitch>();

/**
 * Register a switch. Call from `initAppEntitlements()` in
 * `lib/app/entitlements.ts`. Re-registering a key replaces it, as the other
 * registries do. A key that is not a key, or a missing or empty label,
 * throws, which rolls back every switch the init registered and logs why. A
 * missing description reads as none; it only explains the label.
 */
export function registerEntitlementSwitch(definition: EntitlementSwitch): void {
  if (typeof definition.key !== 'string' || !ENTITLEMENT_KEY_PATTERN.test(definition.key)) {
    throw new Error(
      `Entitlement switch key "${String(definition.key)}" must be lower-case letters, digits and underscores, starting with a letter, at most 48 characters`
    );
  }
  // Checked rather than trusted: an init written in JavaScript, or built from
  // config, can leave either out.
  const label = typeof definition.label === 'string' ? definition.label.trim() : '';
  if (label.length === 0) {
    throw new Error(`Entitlement switch "${definition.key}" needs a label`);
  }
  const description =
    typeof definition.description === 'string' ? definition.description.trim() : '';
  switches.set(
    definition.key,
    Object.freeze({
      key: definition.key,
      label,
      description,
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

/**
 * What an org's stored switches mean, against the switches registered now.
 *
 * No query, so a caller that already holds the org's `settings` (a list page
 * reading many orgs at once) resolves each without another: pass it
 * `readOrgEntitlements(org.settings)`. It reads the registry, so its first
 * call in a process runs the app's `initAppEntitlements()`, as any read does.
 */
export function resolveOrgSwitches(read: OrgEntitlementsRead): OrgSwitches {
  const registered = registeredEntitlementSwitches();
  const known = new Set(registered.map((s) => s.key));
  const unregistered = read.on.filter((key) => !known.has(key));
  if (read.unreadable) {
    // Not even the defaults: the slice that could not be read may have set them off.
    return { nothingSet: false, unreadable: true, on: [], atDefault: [], unregistered };
  }
  const on = new Set(read.on);
  const off = new Set(read.off);
  const atDefault = registered.filter((s) => !on.has(s.key) && !off.has(s.key));
  const defaultOn = new Set(atDefault.filter((s) => s.whenNothingSet).map((s) => s.key));
  return {
    nothingSet: atDefault.length === registered.length,
    unreadable: false,
    on: registered.filter((s) => on.has(s.key) || defaultOn.has(s.key)).map((s) => s.key),
    atDefault: atDefault.map((s) => s.key),
    unregistered,
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
