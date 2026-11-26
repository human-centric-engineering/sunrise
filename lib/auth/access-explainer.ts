/**
 * Roles and access in the admin console, in plain words (§143).
 *
 * Built from the registrations that decide access, never written out by hand:
 * the org roles, the fork's named tiers (`namedAdminTier()`), its entitlement
 * switches (`registeredEntitlementSwitches()`) and every org-tier page
 * (`orgTierAdminPages()`, less the core sections the fork closed, with
 * `namedTierAdminPages()` and `adminPageRequirements()` saying which tier and
 * switch each needs). Add a registration and the explainer shows it; the
 * access-explainer test fails if it does not.
 *
 * **Each viewer sees their own slice** ({@link AccessAudience}). A platform
 * admin sees every registration. An org's OWNER/ADMIN sees their org's view:
 * every org-tier and named-tier page, the switches the org holds, those it
 * lacks that a page requires and the app shows locked, and every switch the
 * org sets itself — never a platform switch the app hides. A holder of a
 * named tier sees their tiers and the pages those open, and the switches
 * those pages need. The narrowing is done here, on the server, so a response
 * never carries what its reader may not know.
 *
 * **The words** are the platform catalogue's (`admin.access`) for Sunrise's
 * own, so a fork rewords them with `overridePlatformMessages()`, and the
 * fork's for its own: tier labels on `registerAdminTier()`, and areas,
 * platform-only surfaces and sections from `lib/app/access-explainer.ts`
 * (`lib/auth/access-explainer-registry.ts`). They are resolved here, into the
 * viewer's language.
 *
 * **It decides nothing.** Every "opens" in it is `reachesTier()` over the reach
 * the policy gave (`lib/auth/admin-reach.ts`), the same answer the admin
 * layout and the guards act on.
 *
 * @see lib/auth/access-explainer-registry.ts — what an app adds
 * @see app/api/v1/admin/access/route.ts — the endpoint
 * @see .context/auth/access-explainer.md
 */

import { initAppAccessExplainer } from '@/lib/app/access-explainer';
import { createAppInitGate } from '@/lib/fork-init';
import {
  ACCESS_AUDIENCES,
  ACCESS_EXPLAINER_SECTIONS,
  ACCESS_PERMISSION_ROLES,
  CORE_ACCESS_AREAS,
  CORE_ACCESS_PERMISSIONS,
  restoreAccessExplainerRegistry,
  snapshotAccessExplainerRegistry,
  EMPTY_ACCESS_EXPLAINER_REGISTRY,
  type AccessAudience,
  type AccessExplainerRegistrations,
  type AccessExplainerSection,
  type AccessPermissionCells,
  type AccessPermissionRole,
} from '@/lib/auth/access-explainer-registry';
import {
  ADMIN_INDEX_PATH,
  lockedSwitchFor,
  reachesTier,
  type AdminReach,
  type AdminText,
  type DeclaredAdminTier,
  type LockedAdminSwitch,
} from '@/lib/auth/admin-tier';
import {
  adminPageRequirements,
  closedCoreOrgTierSections,
  namedAdminTier,
  namedAdminTiers,
  namedTierAdminPages,
  orgTierAdminPages,
} from '@/lib/auth/org-tier-admin-pages';
import { registeredEntitlementSwitches } from '@/lib/tenancy/entitlements';
import { ORG_ROLES } from '@/lib/tenancy/roles';
import { logger } from '@/lib/logging';

const appInit = createAppInitGate({
  label: 'access-explainer: initAppAccessExplainer',
  // With the init rolled back the explainer still shows every registration
  // that decides access, in Sunrise's own words and grouping. The permission
  // table is the exception: the app's restatements are gone with the rest,
  // and core's cells may not be what its policy does, so it is not sent.
  subject:
    "the app's access-explainer areas, platform-only surfaces, section audiences, sections and permission rows",
  init: initAppAccessExplainer,
  snapshot: snapshotAccessExplainerRegistry,
  restore: restoreAccessExplainerRegistry,
});

/** What the app registered for the explainer, after its init has run once. */
export function accessExplainerRegistrations(): AccessExplainerRegistrations {
  appInit.ensure();
  return snapshotAccessExplainerRegistry();
}

/** Whether the app's explainer init threw and was rolled back. */
function appInitFailed(): boolean {
  return appInit.ensure() === 'failed';
}

/** Test-only: clear the app's registrations and re-arm the one-shot init. */
export function __resetAccessExplainerForTests(): void {
  restoreAccessExplainerRegistry(EMPTY_ACCESS_EXPLAINER_REGISTRY);
  appInit.reset();
  warnedMissingKeys.clear();
}

/**
 * Catalogue keys the app named that were found missing, each warned once:
 * the explainer is built per request, and the same missing key is one fix.
 */
const warnedMissingKeys = new Set<string>();

/**
 * Turns a catalogue key into the viewer's words. The route passes next-intl's
 * root translator; a test passes one over its own messages.
 */
export interface AccessTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/** Who is reading, and what the policy and the org said about them. */
export interface AccessExplainerViewer {
  /** What the policy admits them to (`adminReachOf()`). */
  readonly reach: AdminReach;
  /** Their role in the org they entered, or `null` outside one. */
  readonly orgRole: string | null;
  /**
   * The switches the org they entered has (`loadOrgSwitches()`'s `on`), or
   * `null` when they entered none or the org's switches could not be read.
   */
  readonly switchesOn: readonly string[] | null;
  /** What `lockedSwitchesOf()` (or `lockedSwitchesIn()`) returned for them. */
  readonly locked: readonly LockedAdminSwitch[];
  /** Whether they entered the org under a support grant (§121 t-824). */
  readonly supportEntry: boolean;
  /** Whether the install runs at `multi`. */
  readonly multiTenant: boolean;
}

/** One role or tier, as the explainer shows it. */
export interface AccessRoleView {
  /** `platform_admin`, `support`, `owner`, `admin`, `member`, or a named tier's name. */
  readonly key: string;
  readonly kind: 'platform' | 'support' | 'org-role' | 'named-tier';
  readonly label: string;
  readonly description: string;
  /**
   * Whether the viewer holds it where they are now. For a named tier, whether
   * the policy admits them to it: the default policy admits an org's
   * OWNER/ADMIN to every named tier, and every policy a platform admin, so
   * for them each one is held. Under a
   * support grant only `support` is held, never an org role.
   */
  readonly held: boolean;
}

/** One role in the role model's tables. */
export interface AccessModelRoleView {
  /** `user`, `platform_admin` or `support`; or `owner`, `admin` or `member`. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Whether the viewer holds it where they are now. */
  readonly held: boolean;
}

/** One row of the permission table. */
export interface AccessPermissionView {
  readonly key: string;
  readonly label: string;
  /** Whether each role may do it, as Sunrise's model says or the app restated it. */
  readonly allowed: AccessPermissionCells;
  /** `'core'` for one of Sunrise's rows (restated or not), `'app'` for one the app added. */
  readonly source: 'core' | 'app';
}

/**
 * Sunrise's role model (RBAC), whatever the tenancy mode: it describes the
 * model, and `tenancy` says whether the org roles are in force. Sent with the
 * `roles` section to every audience but a named-tier holder, who is told about
 * their own tiers only.
 */
export interface AccessRoleModelView {
  /** User, Platform admin, Support access. */
  readonly platformRoles: readonly AccessModelRoleView[];
  /** Owner, Admin, Member. */
  readonly orgRoles: readonly AccessModelRoleView[];
  /** The permission table's columns, in order, with each role's name. */
  readonly columns: readonly { readonly key: AccessPermissionRole; readonly label: string }[];
  /**
   * Core's rows (less any the app left out), then the app's. `null` when the
   * app's explainer init failed and was rolled back: its restatements went
   * with it, so core's cells may claim what its policy does not do.
   */
  readonly permissions: readonly AccessPermissionView[] | null;
}

/** One entitlement switch, as the explainer shows it. */
export interface AccessSwitchView {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** How the pages needing it look to an org that lacks it. */
  readonly whenLacking: 'hide' | 'lock';
  /** Who may set it on an org. */
  readonly setBy: 'platform' | 'org';
  /**
   * Whether the viewer's org has it; `null` for a platform admin, whom
   * switches do not limit, and when the org's switches could not be read.
   */
  readonly held: boolean | null;
  /** What a refusal for it says; `null` while the org has it. */
  readonly refusal: string | null;
  /** Where an org can get it; `null` when the app gave none, or the org has it. */
  readonly upgradeUrl: string | null;
}

/** One admin page, as the explainer shows it. */
export interface AccessPageView {
  /** The route pattern (`/admin/orchestration/agents/[id]`). */
  readonly pattern: string;
  /** A link to it, or `null` for a pattern with a `[x]` segment. */
  readonly href: string | null;
  /** The tier it is in: `'org'` or a named tier. */
  readonly tier: DeclaredAdminTier;
  /** The tier's name, in the viewer's words. */
  readonly tierLabel: string;
  /** The switch it needs, or `null`. */
  readonly requires: string | null;
  /** That switch's label, or `null` when it needs none. */
  readonly requiresLabel: string | null;
  /** Whether the viewer opens it. */
  readonly opens: boolean;
  /**
   * Why it is closed to them: `'tier'` when they do not hold its tier,
   * `'switch'` when they do and the org lacks its switch, `'unread'` when
   * they do and the org's switches could not be read, `'policy'` when they
   * hold the tier and the org has the switch (or the page needs none) and
   * the app's access policy still keeps it closed. `null` when it opens.
   */
  readonly closedBy: 'tier' | 'switch' | 'unread' | 'policy' | null;
  /** Why it is closed to them when only a switch is missing; `null` otherwise. */
  readonly locked: {
    readonly label: string;
    readonly message: string;
    readonly upgradeUrl: string | null;
  } | null;
}

/** A group of pages, as the explainer shows it. */
export interface AccessAreaView {
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  /** `'core'`, `'app'` (the app registered it), or `'section'` (no area claimed these pages). */
  readonly source: 'core' | 'app' | 'section';
  readonly pages: readonly AccessPageView[];
}

/** Something the install keeps for the platform. */
export interface PlatformOnlyView {
  readonly key: string;
  readonly label: string;
  readonly reason: string;
  /** A link for a platform admin; `null` for anyone else, or when none was given. */
  readonly href: string | null;
}

/** A section the app added. */
export interface AccessAppSectionView {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

/** The viewer's own access, in the org they entered. */
export interface YourAccessView {
  readonly audience: AccessAudience;
  /** Their org role, or `null` outside an org. */
  readonly orgRole: string | null;
  /** `'platform'`, or the tiers the policy admitted them to. */
  readonly tiers: 'platform' | readonly DeclaredAdminTier[];
  /** Their org's switches, as {@link AccessExplainerViewer.switchesOn}, narrowed to those this viewer may see. */
  readonly switchesOn: readonly string[] | null;
  /** True when the org's switches could not be read, so locked pages cannot be explained. */
  readonly switchesUnreadable: boolean;
  /** Whether they entered the org under a support grant, not as a member. */
  readonly supportEntry: boolean;
  /** The name of each tier in `tiers`, in the viewer's words. */
  readonly tierLabels: Readonly<Record<string, string>>;
  /** The label of each switch in `switchesOn`. */
  readonly switchLabels: Readonly<Record<string, string>>;
  /** Whether this viewer may know of any switch at all; with none, "none on" says nothing. */
  readonly anySwitches: boolean;
}

/** What `GET /api/v1/admin/access` returns. Each section is present only for its audience. */
export interface AccessExplainer {
  readonly audience: AccessAudience;
  readonly tenancy: 'single' | 'multi';
  /** The explainer's own sections this viewer sees, in order. */
  readonly sections: readonly AccessExplainerSection[];
  readonly you?: YourAccessView;
  readonly roles?: readonly AccessRoleView[];
  /** The role model's tables; with `roles`, for every audience but `'holder'`. */
  readonly model?: AccessRoleModelView;
  readonly areas?: readonly AccessAreaView[];
  readonly switches?: readonly AccessSwitchView[];
  readonly platformOnly?: readonly PlatformOnlyView[];
  /** The app's own sections this viewer sees, in registration order. */
  readonly appSections: readonly AccessAppSectionView[];
}

/**
 * Where the policy placed a viewer: `null` for someone the console admits to
 * nothing, who is refused the explainer.
 */
export function accessAudienceOf(reach: AdminReach): AccessAudience | null {
  if (reach === 'platform') return 'platform';
  if (reach.tiers.includes('org')) return 'org';
  return reach.tiers.length > 0 ? 'holder' : null;
}

/**
 * The explainer for one viewer. `null` when the console admits them to
 * nothing ({@link accessAudienceOf}), which the route answers with a 403.
 */
export function buildAccessExplainer(
  viewer: AccessExplainerViewer,
  t: AccessTranslator
): AccessExplainer | null {
  const audience = accessAudienceOf(viewer.reach);
  if (audience === null) return null;
  const registrations = accessExplainerRegistrations();
  const text = textResolver(t);

  const visible = ACCESS_EXPLAINER_SECTIONS.filter(
    (section) =>
      (registrations.audiences.get(section) ?? ACCESS_AUDIENCES).includes(audience) &&
      // At `single` the console is the platform admin's alone and every page
      // opens to them, so a page list would tell them apart from no one.
      // Their sidebar already lists every page.
      (section !== 'areas' || viewer.multiTenant)
  );
  const shows = (section: AccessExplainerSection) => visible.includes(section);

  const switchesUnreadable = audience !== 'platform' && viewer.switchesOn === null;
  const visibleSwitchKeys = switchKeysFor(audience, viewer);

  const tierLabel = tierLabelResolver(text, t);
  const switchLabel = switchLabelResolver();
  const areas = areasFor(
    audience,
    viewer,
    registrations,
    text,
    visibleSwitchKeys,
    tierLabel,
    switchLabel
  );
  const youTiers = viewer.reach === 'platform' ? 'platform' : viewer.reach.tiers;
  const youSwitches =
    viewer.switchesOn === null
      ? null
      : viewer.switchesOn.filter((key) => visibleSwitchKeys.has(key));
  return {
    audience,
    tenancy: viewer.multiTenant ? 'multi' : 'single',
    sections: visible,
    ...(shows('your-access')
      ? {
          you: {
            audience,
            // A support entry carries a role for the policy, not a membership.
            orgRole: viewer.supportEntry ? null : viewer.orgRole,
            tiers: youTiers,
            switchesOn: youSwitches,
            switchesUnreadable,
            supportEntry: viewer.supportEntry,
            tierLabels: Object.fromEntries(
              (youTiers === 'platform' ? [] : youTiers).map((tier) => [tier, tierLabel(tier)])
            ),
            switchLabels: Object.fromEntries(
              (youSwitches ?? []).map((key) => [key, switchLabel(key)])
            ),
            anySwitches: visibleSwitchKeys.size > 0,
          },
        }
      : {}),
    ...(shows('roles') ? { roles: rolesFor(audience, viewer, text, t) } : {}),
    // A holder is told about their own tiers, not who else may do what here.
    ...(shows('roles') && audience !== 'holder'
      ? { model: roleModelFor(audience, viewer, registrations, text, t) }
      : {}),
    ...(shows('areas') ? { areas } : {}),
    ...(shows('switches') ? { switches: switchesFor(audience, viewer, visibleSwitchKeys) } : {}),
    ...(shows('platform-only')
      ? { platformOnly: platformOnlyFor(audience, registrations, text, t) }
      : {}),
    appSections: [...registrations.sections.values()]
      .filter((section) => section.audience.includes(audience))
      .map((section) => ({
        key: section.key,
        title: text(section.title),
        body: text(section.body),
      })),
  };
}

/** Resolves an {@link AdminText}: plain text as it is, a key through the catalogue. */
function textResolver(t: AccessTranslator): (value: AdminText) => string {
  return (value) => {
    if (typeof value === 'string') return value;
    if (t.has(value.message)) return t(value.message);
    // Shown as the key rather than failing the page: the fork named a string
    // its catalogue does not have, and the key is what to go and add.
    if (!warnedMissingKeys.has(value.message)) {
      warnedMissingKeys.add(value.message);
      logger.warn('access-explainer: a catalogue key is missing', {
        key: value.message,
      });
    }
    return value.message;
  };
}

/** A tier's name: the catalogue's for `'org'`, a named tier's label or its humanised name. */
function tierLabelResolver(
  text: (value: AdminText) => string,
  t: AccessTranslator
): (tier: string) => string {
  return (tier) => {
    if (tier === 'org') return t('admin.access.page.tierOrg');
    const label = namedAdminTier(tier)?.label;
    return label === undefined ? humanise(tier) : text(label);
  };
}

/** A switch's label as the app registered it, or its key for one it did not. */
function switchLabelResolver(): (key: string) => string {
  const labels = new Map(registeredEntitlementSwitches().map((s) => [s.key, s.label]));
  return (key) => labels.get(key) ?? key;
}

/** `page_designs` → `Page designs`: a name to show when the app gave no label. */
function humanise(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Each core role's catalogue name, by its key: `admin.access.roles.<name>`. */
const ROLE_CATALOGUE: Readonly<Record<AccessPermissionRole | 'user' | 'support', string>> = {
  user: 'user',
  platform_admin: 'platformAdmin',
  support: 'support',
  owner: 'owner',
  admin: 'admin',
  member: 'member',
};

/** Each org role's model key. A Record over `OrgRole`, so a new role fails type-check here. */
const ORG_ROLE_KEYS: Readonly<Record<(typeof ORG_ROLES)[number], 'owner' | 'admin' | 'member'>> = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
};

function roleModelFor(
  audience: AccessAudience,
  viewer: AccessExplainerViewer,
  registrations: AccessExplainerRegistrations,
  text: (value: AdminText) => string,
  t: AccessTranslator
): AccessRoleModelView {
  const role = (key: keyof typeof ROLE_CATALOGUE, held: boolean): AccessModelRoleView => ({
    key,
    label: t(`admin.access.roles.${ROLE_CATALOGUE[key]}.label`),
    description: t(`admin.access.roles.${ROLE_CATALOGUE[key]}.description`),
    held,
  });
  const platformAdmin = audience === 'platform';
  // At `single` no org role is in force, so none is the viewer's; and a
  // support entry carries a role for the policy, not a membership.
  const orgRoleHeld = (orgRole: string) =>
    viewer.multiTenant && !viewer.supportEntry && viewer.orgRole === orgRole;
  const core = CORE_ACCESS_PERMISSIONS.flatMap((row): AccessPermissionView[] => {
    const restated = registrations.permissionOverrides.get(row.key);
    if (restated === null) return [];
    return [
      {
        key: row.key,
        label: t(`admin.access.permissions.${row.key}`),
        allowed: restated ?? row.allowed,
        source: 'core',
      },
    ];
  });
  const app = [...registrations.permissions.values()].map((row): AccessPermissionView => ({
    key: row.key,
    label: text(row.label),
    allowed: row.allowed,
    source: 'app',
  }));
  return {
    platformRoles: [
      role('user', !platformAdmin && !viewer.supportEntry),
      role('platform_admin', platformAdmin),
      role('support', viewer.supportEntry),
    ],
    orgRoles: ORG_ROLES.map((orgRole) => role(ORG_ROLE_KEYS[orgRole], orgRoleHeld(orgRole))),
    columns: ACCESS_PERMISSION_ROLES.map((key) => ({
      key,
      label: t(`admin.access.roles.${ROLE_CATALOGUE[key]}.label`),
    })),
    permissions: appInitFailed() ? null : [...core, ...app],
  };
}

function rolesFor(
  audience: AccessAudience,
  viewer: AccessExplainerViewer,
  text: (value: AdminText) => string,
  t: AccessTranslator
): AccessRoleView[] {
  const heldTiers = viewer.reach === 'platform' ? [] : viewer.reach.tiers;
  const named: AccessRoleView[] = namedAdminTiers()
    .filter((name) => audience !== 'holder' || heldTiers.includes(name))
    .map((name) => {
      const definition = namedAdminTier(name);
      return {
        key: name,
        kind: 'named-tier',
        label: tierLabelResolver(text, t)(name),
        description:
          definition?.description === undefined
            ? t('admin.access.roles.namedTier.description')
            : text(definition.description),
        // The policy admits a platform admin to every tier.
        held: viewer.reach === 'platform' || heldTiers.includes(name),
      };
    });
  // A holder sees the tiers they hold: who else may do what in the org is
  // its OWNER/ADMIN's to know.
  if (audience === 'holder') return named;

  const role = (
    key: string,
    kind: AccessRoleView['kind'],
    catalogue: string,
    held: boolean
  ): AccessRoleView => ({
    key,
    kind,
    label: t(`admin.access.roles.${catalogue}.label`),
    description: t(`admin.access.roles.${catalogue}.description`),
    held,
  });
  const platform = role('platform_admin', 'platform', 'platformAdmin', audience === 'platform');
  // At `single` the console is the platform's alone: no org role opens it.
  if (!viewer.multiTenant) return [platform];
  return [
    platform,
    role('support', 'support', 'support', viewer.supportEntry),
    // Each org role's words are `admin.access.roles.<role, lower case>`.
    ...ORG_ROLES.map((orgRole) =>
      role(
        orgRole.toLowerCase(),
        'org-role',
        orgRole.toLowerCase(),
        // A support entry carries a role for the policy, not a membership.
        !viewer.supportEntry && viewer.orgRole === orgRole
      )
    ),
    ...named,
  ];
}

/**
 * The switches this viewer may know about. A platform admin: every one. An
 * org admin: those the org holds, and those it lacks that the app shows
 * locked, and every switch the org sets itself (`setBy: 'org'`). A holder:
 * those the org holds or is shown locked, narrowed to the switches their
 * tiers' pages require. A platform switch the app hides stays hidden from an
 * org that lacks it.
 */
function switchKeysFor(audience: AccessAudience, viewer: AccessExplainerViewer): Set<string> {
  const registered = registeredEntitlementSwitches();
  if (audience === 'platform') return new Set(registered.map((s) => s.key));
  const on = new Set(viewer.switchesOn ?? []);
  const lockedKeys = new Set(viewer.locked.map((l) => l.requires));
  const keys = registered
    .filter(
      (s) =>
        on.has(s.key) ||
        (s.whenLacking === 'lock' && lockedKeys.has(s.key)) ||
        // Hiding keeps what the platform sells out of sight. It does not hide
        // a switch from the org admin who turns it on.
        (audience === 'org' && s.setBy === 'org')
    )
    .map((s) => s.key);
  if (audience === 'org') return new Set(keys);
  const tiers = viewer.reach === 'platform' ? [] : viewer.reach.tiers;
  const tierOf = new Map(namedTierAdminPages().map((p) => [p.pattern, p.tier]));
  const needed = new Set(
    adminPageRequirements()
      .filter((r) => tiers.includes(tierOf.get(r.pattern) ?? 'org'))
      .map((r) => r.requires)
  );
  return new Set(keys.filter((key) => needed.has(key)));
}

function switchesFor(
  audience: AccessAudience,
  viewer: AccessExplainerViewer,
  visible: Set<string>
): AccessSwitchView[] {
  const unread = viewer.switchesOn === null;
  const on = new Set(viewer.switchesOn ?? []);
  const locked = new Map(viewer.locked.map((l) => [l.requires, l]));
  return registeredEntitlementSwitches()
    .filter((s) => visible.has(s.key))
    .map((s) => {
      // An unread switch is said to be unknown, not guessed off.
      const held = audience === 'platform' || unread ? null : on.has(s.key);
      const lock = held === false ? locked.get(s.key) : undefined;
      return {
        key: s.key,
        label: s.label,
        description: s.description,
        whenLacking: s.whenLacking,
        setBy: s.setBy,
        held,
        refusal: lock?.message ?? null,
        upgradeUrl: lock?.upgradeUrl ?? null,
      };
    });
}

/** Does `prefix` claim `pattern`: the same page, or one below it? */
function claims(prefix: string, pattern: string): boolean {
  return pattern === prefix || pattern.startsWith(`${prefix}/`);
}

interface AreaCandidate {
  key: string;
  source: 'core' | 'app';
  label: () => string;
  description: () => string | null;
  pages: readonly string[];
}

function areasFor(
  audience: AccessAudience,
  viewer: AccessExplainerViewer,
  registrations: AccessExplainerRegistrations,
  text: (value: AdminText) => string,
  visibleSwitches: ReadonlySet<string>,
  tierLabel: (tier: string) => string,
  switchLabel: (key: string) => string
): AccessAreaView[] {
  // At `single` there is no areas section: see `buildAccessExplainer()`.
  if (!viewer.multiTenant) return [];
  const tiers = viewer.reach === 'platform' ? null : viewer.reach.tiers;
  const tierOf = new Map(namedTierAdminPages().map((p) => [p.pattern, p.tier]));
  const requiresOf = new Map(adminPageRequirements().map((r) => [r.pattern, r.requires]));
  const candidates: AreaCandidate[] = [
    // The app's first: on a tie of equal length its area wins.
    ...[...registrations.areas.values()].map((area): AreaCandidate => ({
      key: area.key,
      source: 'app',
      label: () => text(area.label),
      description: () => (area.description === null ? null : text(area.description)),
      pages: area.pages,
    })),
    ...CORE_ACCESS_AREAS.map((area): AreaCandidate => ({
      key: area.key,
      source: 'core',
      label: () => text({ message: `admin.access.areas.${area.key}.label` }),
      description: () => text({ message: `admin.access.areas.${area.key}.description` }),
      pages: area.pages,
    })),
  ];

  const grouped = new Map<string, { candidate: AreaCandidate | null; pages: AccessPageView[] }>();
  for (const pattern of orgTierAdminPages()) {
    // `/admin` sends each viewer on and shows nothing itself.
    if (pattern === ADMIN_INDEX_PATH) continue;
    const tier: DeclaredAdminTier = tierOf.get(pattern) ?? 'org';
    const requires = requiresOf.get(pattern) ?? null;
    // A holder sees their tiers' pages, not the org admin's.
    if (tiers !== null && audience === 'holder' && !tiers.includes(tier)) continue;
    const opens = reachesTier(viewer.reach, tier, requires);
    // A page whose switch the app hides from an org lacking it stays hidden,
    // unless the policy opens it: a page the viewer opens is always shown,
    // however the switch read went.
    if (requires !== null && !opens && audience !== 'platform' && !visibleSwitches.has(requires)) {
      continue;
    }
    const lock = opens ? null : lockedSwitchFor(viewer.reach, tier, requires, viewer.locked);
    const page: AccessPageView = {
      pattern,
      href: pattern.includes('[') ? null : pattern,
      tier,
      tierLabel: tierLabel(tier),
      requires,
      requiresLabel: requires === null ? null : switchLabel(requires),
      opens,
      closedBy: closedByOf(viewer, tier, requires, opens),
      locked: lock
        ? { label: lock.label, message: lock.message, upgradeUrl: lock.upgradeUrl }
        : null,
    };

    let best: { candidate: AreaCandidate; length: number } | null = null;
    for (const candidate of candidates) {
      for (const prefix of candidate.pages) {
        if (claims(prefix, pattern) && (best === null || prefix.length > best.length)) {
          best = { candidate, length: prefix.length };
        }
      }
    }
    // An unclaimed page whose section shares a key with an area joins that
    // area, so no two areas in one response have the same key.
    const owner =
      best?.candidate ?? candidates.find((c) => c.key === firstSegment(pattern)) ?? null;
    const key = owner ? `${owner.source}:${owner.key}` : `section:${firstSegment(pattern)}`;
    const group = grouped.get(key) ?? { candidate: owner, pages: [] };
    group.pages.push(page);
    grouped.set(key, group);
  }

  return [...grouped.entries()].map(([groupKey, { candidate, pages }]) =>
    candidate
      ? {
          key: candidate.key,
          label: candidate.label(),
          description: candidate.description(),
          source: candidate.source,
          pages,
        }
      : {
          key: groupKey.slice('section:'.length),
          label: humanise(groupKey.slice('section:'.length)),
          description: null,
          source: 'section',
          pages,
        }
  );
}

/**
 * Why a page is closed to this viewer. Holding the tier leaves the switch:
 * unknown when it could not be read, missing only when the org lacks it. A
 * page closed with the tier held and the switch on (or none needed) is the
 * policy's own refusal, which is not put down to a switch the org has.
 */
function closedByOf(
  viewer: AccessExplainerViewer,
  tier: DeclaredAdminTier,
  requires: string | null,
  opens: boolean
): AccessPageView['closedBy'] {
  if (opens) return null;
  if (viewer.reach === 'platform' || !viewer.reach.tiers.includes(tier)) return 'tier';
  if (requires === null) return 'policy';
  if (viewer.switchesOn === null) return 'unread';
  return viewer.switchesOn.includes(requires) ? 'policy' : 'switch';
}

/** `/admin/reports/[id]` → `reports`. */
function firstSegment(pattern: string): string {
  return pattern.split('/')[2] ?? pattern;
}

function platformOnlyFor(
  audience: AccessAudience,
  registrations: AccessExplainerRegistrations,
  text: (value: AdminText) => string,
  t: AccessTranslator
): PlatformOnlyView[] {
  const closed: PlatformOnlyView[] = closedCoreOrgTierSections().map((section) => ({
    key: section,
    label: t(`admin.access.closedSections.${section}.label`),
    reason: t(`admin.access.closedSections.${section}.reason`),
    href: audience === 'platform' ? `/admin/${section}` : null,
  }));
  const app: PlatformOnlyView[] = [...registrations.platformOnly.values()].map((surface) => ({
    key: surface.key,
    label: text(surface.label),
    reason: text(surface.reason),
    // Only a platform admin can follow it; anyone else would be sent away.
    href: audience === 'platform' ? surface.href : null,
  }));
  return [...closed, ...app];
}
