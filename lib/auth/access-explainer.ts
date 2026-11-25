/**
 * Who can do what in the admin console, in plain words (§143).
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
 * every org-tier and named-tier page, the switches the org holds, and those
 * it lacks that the app shows locked — never one the app hides. A holder of a
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
  CORE_ACCESS_AREAS,
  restoreAccessExplainerRegistry,
  snapshotAccessExplainerRegistry,
  EMPTY_ACCESS_EXPLAINER_REGISTRY,
  type AccessAudience,
  type AccessExplainerRegistrations,
  type AccessExplainerSection,
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
  // that decides access, in Sunrise's own words and grouping.
  subject:
    "the app's access-explainer areas, platform-only surfaces, section audiences and sections",
  init: initAppAccessExplainer,
  snapshot: snapshotAccessExplainerRegistry,
  restore: restoreAccessExplainerRegistry,
});

/** What the app registered for the explainer, after its init has run once. */
export function accessExplainerRegistrations(): AccessExplainerRegistrations {
  appInit.ensure();
  return snapshotAccessExplainerRegistry();
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
  /** Whether the viewer holds it where they are now. */
  readonly held: boolean;
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
  /** Whether the viewer's org has it; `null` for a platform admin, whom switches do not limit. */
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
  /** The switch it needs, or `null`. */
  readonly requires: string | null;
  /** Whether the viewer opens it. */
  readonly opens: boolean;
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
}

/** What `GET /api/v1/admin/access` returns. Each section is present only for its audience. */
export interface AccessExplainer {
  readonly audience: AccessAudience;
  readonly tenancy: 'single' | 'multi';
  /** The explainer's own sections this viewer sees, in order. */
  readonly sections: readonly AccessExplainerSection[];
  readonly you?: YourAccessView;
  readonly roles?: readonly AccessRoleView[];
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

  const visible = ACCESS_EXPLAINER_SECTIONS.filter((section) =>
    (registrations.audiences.get(section) ?? ACCESS_AUDIENCES).includes(audience)
  );
  const shows = (section: AccessExplainerSection) => visible.includes(section);

  const switchesUnreadable = audience !== 'platform' && viewer.switchesOn === null;
  const visibleSwitchKeys = switchKeysFor(audience, viewer);

  const areas = areasFor(audience, viewer, registrations, text, visibleSwitchKeys);
  return {
    audience,
    tenancy: viewer.multiTenant ? 'multi' : 'single',
    sections: visible,
    ...(shows('your-access')
      ? {
          you: {
            audience,
            orgRole: viewer.orgRole,
            tiers: viewer.reach === 'platform' ? 'platform' : viewer.reach.tiers,
            switchesOn:
              viewer.switchesOn === null
                ? null
                : viewer.switchesOn.filter((key) => visibleSwitchKeys.has(key)),
            switchesUnreadable,
          },
        }
      : {}),
    ...(shows('roles') ? { roles: rolesFor(audience, viewer, text, t) } : {}),
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
      logger.warn('access-explainer: a catalogue key the app named is missing', {
        key: value.message,
      });
    }
    return value.message;
  };
}

/** `page_designs` → `Page designs`: a name to show when the app gave no label. */
function humanise(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
        label: definition?.label === undefined ? humanise(name) : text(definition.label),
        description:
          definition?.description === undefined
            ? t('admin.access.roles.namedTier.description')
            : text(definition.description),
        held: heldTiers.includes(name),
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
      role(orgRole.toLowerCase(), 'org-role', orgRole.toLowerCase(), viewer.orgRole === orgRole)
    ),
    ...named,
  ];
}

/**
 * The switches this viewer may know about. A platform admin: every one. An
 * org admin: those the org holds, and those it lacks that the app shows
 * locked. A holder: the same, narrowed to the switches their tiers' pages
 * require. A switch the app hides stays hidden from an org that lacks it.
 */
function switchKeysFor(audience: AccessAudience, viewer: AccessExplainerViewer): Set<string> {
  const registered = registeredEntitlementSwitches();
  if (audience === 'platform') return new Set(registered.map((s) => s.key));
  const on = new Set(viewer.switchesOn ?? []);
  const lockedKeys = new Set(viewer.locked.map((l) => l.requires));
  const keys = registered
    .filter((s) => on.has(s.key) || (s.whenLacking === 'lock' && lockedKeys.has(s.key)))
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
  const on = new Set(viewer.switchesOn ?? []);
  const locked = new Map(viewer.locked.map((l) => [l.requires, l]));
  return registeredEntitlementSwitches()
    .filter((s) => visible.has(s.key))
    .map((s) => {
      const held = audience === 'platform' ? null : on.has(s.key);
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
  visibleSwitches: ReadonlySet<string>
): AccessAreaView[] {
  // At `single` no org-tier page opens to anyone but a platform admin, so
  // there is nothing of the org's to show.
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
      requires,
      opens,
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
