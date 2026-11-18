/**
 * Entitlement switches: what an org can have (§135 t-1033).
 *
 * Sunrise could limit and measure an org (§110's caps and usage) but had no
 * way for an app to say what an org has bought. An app that sells parts of
 * itself kept that in its own `Org.settings` key under names it had to guess,
 * and billing later renamed them. This is the one place it lives instead: an
 * app registers its switches from `lib/app/entitlements.ts`, platform staff set
 * them per org (`PATCH /api/v1/admin/orgs/[id]/entitlements`, or
 * `setOrgSwitches()` from the app's own code), and the app reads
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
 * t-1034): `requires` beside `tier`, handed to the authorization policy as
 * `scope.requires`, so menus, pages and routes agree. A platform admin is not
 * limited by switches. What a refusal says is here
 * ({@link switchRequiredMessage}, {@link switchUnverifiedMessage}), so every
 * surface says it the same way.
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
import { logger } from '@/lib/logging';
import {
  loadOrgEntitlements,
  writeOrgEntitlements,
  type OrgEntitlementsRead,
} from '@/lib/tenancy/org-settings';
import { ENTITLEMENT_KEY_PATTERN, MAX_ORG_ENTITLEMENT_SWITCHES } from '@/lib/validations/tenancy';

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
 * registries do. A key that is not a key, a missing or empty label, a
 * `whenNothingSet` that is not `true` or `false`, or a switch past the
 * {@link MAX_ORG_ENTITLEMENT_SWITCHES}th throws, which rolls back every switch
 * the init registered and logs why. A missing description reads as none; it
 * only explains the label.
 */
export function registerEntitlementSwitch(definition: EntitlementSwitch): void {
  if (typeof definition.key !== 'string' || !ENTITLEMENT_KEY_PATTERN.test(definition.key)) {
    throw new Error(
      `Entitlement switch key "${String(definition.key)}" must be lower-case letters, digits and underscores, starting with a letter, at most 48 characters`
    );
  }
  // Checked rather than trusted: an init written in JavaScript, or built from
  // config, can pass anything.
  const label = typeof definition.label === 'string' ? definition.label.trim() : '';
  if (label.length === 0) {
    throw new Error(`Entitlement switch "${definition.key}" needs a label`);
  }
  const whenNothingSet: unknown = definition.whenNothingSet ?? false;
  if (typeof whenNothingSet !== 'boolean') {
    // The string "false" is truthy: read loosely, it would open the switch
    // for every org.
    throw new Error(
      `Entitlement switch "${definition.key}" has whenNothingSet ${JSON.stringify(whenNothingSet)}; it must be true or false`
    );
  }
  if (!switches.has(definition.key) && switches.size >= MAX_ORG_ENTITLEMENT_SWITCHES) {
    throw new Error(
      `At most ${MAX_ORG_ENTITLEMENT_SWITCHES} entitlement switches can be registered; "${definition.key}" is one too many`
    );
  }
  const description =
    typeof definition.description === 'string' ? definition.description.trim() : '';
  switches.set(
    definition.key,
    Object.freeze({ key: definition.key, label, description, whenNothingSet })
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
 * Whether the app's `initAppEntitlements()` threw, so its switches were rolled
 * back and every org reads as having none of them, defaults included. A
 * surface asks so it can say so, rather than look like an install that
 * registers no switch.
 */
export function entitlementSwitchesFailed(): boolean {
  return appInit.ensure() === 'failed';
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

/**
 * Set the named switches on an org, on or off, leaving every other stored
 * value as it is; or, given `null`, put every registered switch back to its
 * default, keeping values stored for keys nothing registers.
 *
 * The one writer for the admin route and an app's own code (billing, later)
 * alike. Naming only what it decides is what stops a writer turning off a
 * switch it did not know about: one registered after its form loaded, or by a
 * newer build during a deploy. A plan that decides every switch names every
 * switch.
 *
 * **Over a slice that could not be read**, which gave the org nothing, nothing
 * comes back on that this change does not set on: every key the slice held is
 * kept, but off, and so is every registered switch the change does not name,
 * rather than falling to its default. The slice may have set it off, and nobody
 * chose to grant it. (`null` still puts the registered switches back to their
 * defaults, since that is what it asks for.)
 *
 * A change naming nothing writes nothing, over any slice. Keys are not checked
 * against the registry here: a caller taking them from a request refuses
 * unregistered ones first, as the route does. A key in both lists, or one that
 * is not a key, throws a `ZodError` and nothing is written. While the app's
 * registration has failed it throws and writes nothing, since there is then no
 * telling which switches exist. **It decides nothing about who may**: ask
 * `mayChangeOrgCommercialSettings()` (`lib/tenancy/shared-settings.ts`) after
 * a platform-admin check. A clash with a concurrent settings write throws
 * `P2034` (`isSettingsWriteConflict`).
 *
 * @returns what was stored before (read, and `previousStored` exactly as
 *   stored), what is stored now and whether this changed it, or `null` when
 *   the org does not exist.
 */
export async function setOrgSwitches(
  orgId: string,
  change: { on: readonly string[]; off: readonly string[] } | null,
  db: Pick<PrismaClient, '$transaction'> = prisma
): Promise<{
  previous: OrgEntitlementsRead;
  previousStored: unknown;
  stored: OrgEntitlementsRead;
  changed: boolean;
} | null> {
  const registered = new Set(registeredEntitlementSwitches().map((s) => s.key));
  if (entitlementSwitchesFailed()) {
    throw new Error(
      "The app's entitlement switches failed to register, so no switch can be set until they do. The server log says why."
    );
  }
  const named = change === null ? registered : new Set([...change.on, ...change.off]);
  const setOn = change?.on ?? [];
  const setOff = change?.off ?? [];
  return writeOrgEntitlements(
    orgId,
    (previous) => {
      if (named.size === 0) return undefined;
      if (previous.unreadable) {
        const held = [...previous.on, ...previous.off].filter((key) => !named.has(key));
        const closed = change === null ? [] : [...registered].filter((key) => !named.has(key));
        return { on: [...setOn], off: [...held, ...setOff, ...closed] };
      }
      const kept = (keys: readonly string[]) => keys.filter((key) => !named.has(key));
      return { on: [...kept(previous.on), ...setOn], off: [...kept(previous.off), ...setOff] };
    },
    db
  );
}

/**
 * `details.reason` on the 403 a route answers when the caller's org lacks the
 * switch it requires (t-1034), so a client can tell it from any other refusal.
 */
export const SWITCH_REQUIRED_REASON = 'entitlement_required';

/**
 * What a refusal for a missing switch says: the switch by its label, and who
 * can change it (`HB10`). A key no app registers is named as itself, since it
 * has no label; no org has it, so the refusal is still true.
 */
export function switchRequiredMessage(key: string): string {
  return `Your organisation does not have ${switchLabel(key)}. Ask whoever manages your organisation's account to switch it on.`;
}

/**
 * `details.reason` on the 403 a route answers when it could not tell whether
 * the caller's org has the switch it requires (t-1034): the org's switches
 * could not be read, so access was refused without saying the switch is off.
 */
export const SWITCH_UNVERIFIED_REASON = 'entitlement_unverified';

/** What a refusal says when the org's switches could not be read (t-1034). */
export function switchUnverifiedMessage(key: string): string {
  return `We could not check whether your organisation has ${switchLabel(key)}, so this was refused. Try again in a moment.`;
}

function switchLabel(key: string): string {
  return registeredEntitlementSwitches().find((s) => s.key === key)?.label ?? key;
}

/**
 * Whether an org has one switch, with "could not tell" kept apart from "off"
 * (t-1034), for a refusal that has to say which. `'unknown'` when the read
 * throws, when the stored slice could not be read, or when the app's
 * `initAppEntitlements()` failed: each reads as off for access, but saying
 * the org lacks the switch would not be true. An org that does not exist, or
 * a key no app registers, is `'off'`, as {@link orgHasSwitch} answers false.
 * Never throws; a failed read is logged.
 */
export async function orgSwitchState(
  orgId: string,
  key: string,
  db: Pick<PrismaClient, 'org'> = prisma
): Promise<'on' | 'off' | 'unknown'> {
  try {
    if (entitlementSwitchesFailed()) return 'unknown';
    const org = await loadOrgSwitches(orgId, db);
    if (org === null) return 'off';
    if (org.unreadable) return 'unknown';
    return org.on.includes(key) ? 'on' : 'off';
  } catch (error) {
    logger.error("entitlements: could not read an org's switches", {
      orgId,
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'unknown';
  }
}

/** Test-only: clear the registry and re-arm the one-shot app init. */
export function __resetEntitlementRegistryForTests(): void {
  switches.clear();
  appInit.reset();
}
