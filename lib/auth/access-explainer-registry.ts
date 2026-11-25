/**
 * What an app adds to the access explainer (§143): the registrars a fork
 * calls from `initAppAccessExplainer()` in `lib/app/access-explainer.ts`.
 *
 * The explainer (`lib/auth/access-explainer.ts`) derives everything about
 * access from the registrations that decide it: core's org-tier pages, the
 * fork's (`registerOrgTierAdminPage()`), its named tiers (`registerAdminTier()`,
 * whose `label` and `description` name them there) and its entitlement
 * switches (`registerEntitlementSwitch()`). None of that is restated here, so
 * none of it can drift from what the guards enforce. This is only the words
 * and the arrangement:
 *
 * - {@link registerAccessArea}: group pages into an area a reader recognises,
 *   with a label and a description;
 * - {@link registerPlatformOnlySurface}: something the install keeps for the
 *   platform, and why, so a client admin who looks for it learns it is not
 *   theirs rather than that it is missing;
 * - {@link setAccessSectionAudience}: which viewers see each of the
 *   explainer's own sections;
 * - {@link registerAccessSection}: a section of the app's own.
 *
 * Nothing registered here opens or closes anything. Changing who may open a
 * page is a registration in `lib/app/admin-tier.ts` or the policy, never this.
 *
 * Imports nothing at runtime but the text check, so the scaffold can import
 * it without pulling in the explainer, the policy or the guards.
 */

import {
  adminTextOrThrow,
  isPlainAdminPath,
  MAX_ADMIN_TEXT_DESCRIPTION,
  MAX_ADMIN_TEXT_LABEL,
  type AdminText,
} from '@/lib/auth/admin-tier';

/** The explainer's own sections, in the order the page shows them. */
export const ACCESS_EXPLAINER_SECTIONS = Object.freeze([
  'your-access',
  'roles',
  'areas',
  'switches',
  'platform-only',
] as const);

/** One of {@link ACCESS_EXPLAINER_SECTIONS}. */
export type AccessExplainerSection = (typeof ACCESS_EXPLAINER_SECTIONS)[number];

/**
 * Who is reading the explainer, as the policy placed them:
 *
 * - `'platform'`: a platform admin, who sees every registration.
 * - `'org'`: the OWNER or ADMIN of the org they entered, who sees that org's
 *   view: every org-tier and named-tier area, and the org's own switches.
 * - `'holder'`: someone who holds one or more of the app's named tiers in the
 *   org they entered and is not its OWNER/ADMIN, who sees their tiers only.
 *
 * Everyone else (an org MEMBER, a signed-in user with no admin reach) is
 * refused the explainer outright.
 */
export const ACCESS_AUDIENCES = Object.freeze(['platform', 'org', 'holder'] as const);

/** One of {@link ACCESS_AUDIENCES}. */
export type AccessAudience = (typeof ACCESS_AUDIENCES)[number];

/**
 * Core's areas: the org-tier pages Sunrise ships, grouped as the admin
 * sidebar groups them. Each claims the pages under its prefixes (see
 * {@link AccessAreaDefinition.pages}). The words are the platform catalogue's,
 * under `admin.access.areas.<key>`, so a fork rewords one with
 * `overridePlatformMessages()` (`lib/app/messages.ts`) rather than here.
 *
 * `orchestration` claims what the two narrower orchestration areas do not:
 * the dashboard, and any core orchestration page added later before it is
 * placed in one. The access-explainer test fails on a core org-tier page no
 * core area claims, so a new core page is placed when it is listed.
 */
export const CORE_ACCESS_AREAS: readonly Readonly<{ key: string; pages: readonly string[] }>[] =
  Object.freeze([
    { key: 'members', pages: ['/admin/members'] },
    { key: 'orgOptions', pages: ['/admin/org-options'] },
    { key: 'providerKeys', pages: ['/admin/provider-keys'] },
    { key: 'supportAccess', pages: ['/admin/support-access'] },
    { key: 'waitlist', pages: ['/admin/waitlist'] },
    { key: 'orchestration', pages: ['/admin/orchestration'] },
    {
      key: 'orchestrationBuild',
      pages: [
        '/admin/orchestration/agents',
        '/admin/orchestration/workflows',
        '/admin/orchestration/mcp',
      ],
    },
    {
      key: 'orchestrationOperate',
      pages: [
        '/admin/orchestration/knowledge',
        '/admin/orchestration/executions',
        '/admin/orchestration/conversations',
        '/admin/orchestration/approvals',
        '/admin/orchestration/triggers',
        '/admin/orchestration/event-subscriptions',
        '/admin/orchestration/evaluations',
        '/admin/orchestration/experiments',
        '/admin/orchestration/analytics',
        '/admin/orchestration/costs',
      ],
    },
  ]);

/** An area as an app registers it with {@link registerAccessArea}. */
export interface AccessAreaDefinition {
  /**
   * The area's id: lower case letters, digits, `_` and `-`, a letter first,
   * at most 48. Registering a key again replaces that area.
   */
  key: string;
  /** What the area is called, as the app's sidebar calls it. */
  label: AdminText;
  /** What someone does there, in a sentence or two. Optional. */
  description?: AdminText;
  /**
   * The pages the area claims, as plain admin paths (`/admin/reports`): each
   * claims that page and every page below it (`/admin/reports/[id]`). Where
   * two areas claim a page, the longer path wins, and an app's area wins a
   * tie with core's, so an app can move core's pages into an area of its own.
   * A page no area claims is shown under its first segment.
   */
  pages: readonly string[];
}

/** A surface the install keeps for the platform, as an app registers it. */
export interface PlatformOnlySurfaceDefinition {
  /** Its id, as {@link AccessAreaDefinition.key}. Registering it again replaces it. */
  key: string;
  /** What it is called. */
  label: AdminText;
  /** Why it stays the platform's: what a client admin would need to know. */
  reason: AdminText;
  /** The page, for a platform admin to follow: a plain `/admin/…` path. Optional. */
  href?: string;
}

/** A section of the app's own, as it registers it with {@link registerAccessSection}. */
export interface AccessSectionDefinition {
  /** Its id, as {@link AccessAreaDefinition.key}. Registering it again replaces it. */
  key: string;
  /** Its heading. */
  title: AdminText;
  /** Its text. Plain paragraphs: a blank line starts a new one. */
  body: AdminText;
  /** Who sees it. At least one of {@link ACCESS_AUDIENCES}. */
  audience: readonly AccessAudience[];
}

/** The longest plain {@link AccessSectionDefinition.body}. */
export const MAX_ACCESS_SECTION_BODY = 4000;

/** The most areas, platform-only surfaces or sections an app may register, each. */
export const MAX_ACCESS_REGISTRATIONS = 100;

/** What an area, surface or section key may look like. */
const ACCESS_KEY = /^[a-z][a-z0-9_-]{0,47}$/;

const CORE_AREA_KEYS: ReadonlySet<string> = new Set(CORE_ACCESS_AREAS.map((a) => a.key));

export interface RegisteredAccessArea {
  readonly key: string;
  readonly label: AdminText;
  readonly description: AdminText | null;
  readonly pages: readonly string[];
}
export interface RegisteredPlatformOnlySurface {
  readonly key: string;
  readonly label: AdminText;
  readonly reason: AdminText;
  readonly href: string | null;
}
export interface RegisteredAccessSection {
  readonly key: string;
  readonly title: AdminText;
  readonly body: AdminText;
  readonly audience: readonly AccessAudience[];
}

const areas = new Map<string, RegisteredAccessArea>();
const platformOnly = new Map<string, RegisteredPlatformOnlySurface>();
const sections = new Map<string, RegisteredAccessSection>();
const audiences = new Map<AccessExplainerSection, readonly AccessAudience[]>();

function keyOrThrow(fn: string, key: unknown): string {
  if (typeof key !== 'string' || !ACCESS_KEY.test(key)) {
    throw new TypeError(
      `${fn}: ${JSON.stringify(key)} is not a key — lower case letters, digits, _ and -, starting with a letter, at most 48 characters`
    );
  }
  return key;
}

function roomOrThrow(fn: string, map: Map<string, unknown>, key: string): void {
  if (!map.has(key) && map.size >= MAX_ACCESS_REGISTRATIONS) {
    throw new RangeError(`${fn}: more than ${MAX_ACCESS_REGISTRATIONS} registered`);
  }
}

function audienceOrThrow(
  fn: string,
  value: unknown,
  allowEmpty: boolean
): readonly AccessAudience[] {
  if (!Array.isArray(value)) throw new TypeError(`${fn}: audience is not a list`);
  const known: readonly string[] = ACCESS_AUDIENCES;
  const list: AccessAudience[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !known.includes(item)) {
      throw new TypeError(
        `${fn}: ${JSON.stringify(item)} is not an audience (${ACCESS_AUDIENCES.join(', ')})`
      );
    }
    const audience = ACCESS_AUDIENCES.find((a) => a === item);
    if (audience && !list.includes(audience)) list.push(audience);
  }
  if (!allowEmpty && list.length === 0) throw new TypeError(`${fn}: audience is empty`);
  return Object.freeze(list);
}

/**
 * Group pages into an area of the app's own, with the words a reader knows
 * it by. Throws on a key that is not a key or is one of core's areas (reword
 * those through the catalogue), a label or description that is not
 * {@link AdminText}, and pages that are not a non-empty list of plain
 * `/admin/…` paths.
 *
 * @example
 * ```ts
 * registerAccessArea({
 *   key: 'reports',
 *   label: 'Reports',
 *   description: 'Build and share reports from collected answers.',
 *   pages: ['/admin/reports'],
 * });
 * ```
 */
export function registerAccessArea(definition: AccessAreaDefinition): void {
  const fn = 'registerAccessArea';
  const key = keyOrThrow(fn, definition?.key);
  if (CORE_AREA_KEYS.has(key)) {
    throw new TypeError(
      `${fn}: "${key}" is one of core's areas; reword it with overridePlatformMessages() (admin.access.areas.${key})`
    );
  }
  const label = adminTextOrThrow(definition.label, `${fn}: "${key}"'s label`, MAX_ADMIN_TEXT_LABEL);
  const description =
    definition.description === undefined
      ? null
      : adminTextOrThrow(
          definition.description,
          `${fn}: "${key}"'s description`,
          MAX_ADMIN_TEXT_DESCRIPTION
        );
  if (!Array.isArray(definition.pages) || definition.pages.length === 0) {
    throw new TypeError(`${fn}: "${key}" claims no pages`);
  }
  const pages: string[] = [];
  for (const page of definition.pages) {
    if (!isPlainAdminPath(page)) {
      throw new TypeError(
        `${fn}: "${key}" claims ${JSON.stringify(page)}, which is not a plain /admin/ path`
      );
    }
    if (!pages.includes(page)) pages.push(page);
  }
  roomOrThrow(fn, areas, key);
  areas.set(key, Object.freeze({ key, label, description, pages: Object.freeze(pages) }));
}

/**
 * Say that something stays the platform's on this install, and why. Shown to
 * the audiences of the `platform-only` section (every viewer by default), so
 * write the reason for a client admin. Lists, never closes: the surface is
 * the platform's because nothing declared it otherwise.
 *
 * @example
 * ```ts
 * registerPlatformOnlySurface({
 *   key: 'billing',
 *   label: 'Billing',
 *   reason: 'Your plan is managed by our account team. Ask them to change it.',
 * });
 * ```
 */
export function registerPlatformOnlySurface(definition: PlatformOnlySurfaceDefinition): void {
  const fn = 'registerPlatformOnlySurface';
  const key = keyOrThrow(fn, definition?.key);
  const label = adminTextOrThrow(definition.label, `${fn}: "${key}"'s label`, MAX_ADMIN_TEXT_LABEL);
  const reason = adminTextOrThrow(
    definition.reason,
    `${fn}: "${key}"'s reason`,
    MAX_ADMIN_TEXT_DESCRIPTION
  );
  const { href } = definition;
  if (href !== undefined && !isPlainAdminPath(href)) {
    throw new TypeError(
      `${fn}: "${key}"'s href ${JSON.stringify(href)} is not a plain /admin/ path`
    );
  }
  roomOrThrow(fn, platformOnly, key);
  platformOnly.set(key, Object.freeze({ key, label, reason, href: href ?? null }));
}

/**
 * Choose which viewers see one of the explainer's own sections. Every section
 * is shown to every audience by default, with its content already narrowed to
 * what that viewer may know; this narrows who sees the section at all. An
 * empty list hides it from everyone. Throws on a section or audience that is
 * not one.
 *
 * @example
 * ```ts
 * // Clients buy packages from the account team: keep the switch list for staff.
 * setAccessSectionAudience('switches', ['platform']);
 * ```
 */
export function setAccessSectionAudience(
  section: AccessExplainerSection,
  audience: readonly AccessAudience[]
): void {
  const fn = 'setAccessSectionAudience';
  const known: readonly string[] = ACCESS_EXPLAINER_SECTIONS;
  if (typeof section !== 'string' || !known.includes(section)) {
    throw new TypeError(
      `${fn}: ${JSON.stringify(section)} is not a section (${ACCESS_EXPLAINER_SECTIONS.join(', ')})`
    );
  }
  audiences.set(section, audienceOrThrow(fn, audience, true));
}

/**
 * Add a section of the app's own: how its packages work, who to ask, what an
 * agency's staff may do in a client's org. Shown after the explainer's own
 * sections, in registration order, to the audiences it names.
 *
 * @example
 * ```ts
 * registerAccessSection({
 *   key: 'agency',
 *   title: { message: 'app.access.agency.title' },
 *   body: { message: 'app.access.agency.body' },
 *   audience: ['org', 'holder'],
 * });
 * ```
 */
export function registerAccessSection(definition: AccessSectionDefinition): void {
  const fn = 'registerAccessSection';
  const key = keyOrThrow(fn, definition?.key);
  const title = adminTextOrThrow(definition.title, `${fn}: "${key}"'s title`, MAX_ADMIN_TEXT_LABEL);
  const body = adminTextOrThrow(definition.body, `${fn}: "${key}"'s body`, MAX_ACCESS_SECTION_BODY);
  const audience = audienceOrThrow(fn, definition.audience, false);
  roomOrThrow(fn, sections, key);
  sections.set(key, Object.freeze({ key, title, body, audience }));
}

/** Everything the app registered, for the init gate's snapshot and the explainer. */
export interface AccessExplainerRegistrations {
  readonly areas: ReadonlyMap<string, RegisteredAccessArea>;
  readonly platformOnly: ReadonlyMap<string, RegisteredPlatformOnlySurface>;
  readonly sections: ReadonlyMap<string, RegisteredAccessSection>;
  readonly audiences: ReadonlyMap<AccessExplainerSection, readonly AccessAudience[]>;
}

/**
 * A copy of every registry this module owns, without running the app's init.
 * The init gate's snapshot; read through `accessExplainerRegistrations()` in
 * `lib/auth/access-explainer.ts`, which runs the init first.
 *
 * @internal
 */
export function snapshotAccessExplainerRegistry(): AccessExplainerRegistrations {
  return {
    areas: new Map(areas),
    platformOnly: new Map(platformOnly),
    sections: new Map(sections),
    audiences: new Map(audiences),
  };
}

/**
 * Put every registry back to a snapshot: the init gate's rollback, and the
 * tests' reset (pass {@link EMPTY_ACCESS_EXPLAINER_REGISTRY}).
 *
 * @internal
 */
export function restoreAccessExplainerRegistry(snapshot: AccessExplainerRegistrations): void {
  areas.clear();
  for (const [k, v] of snapshot.areas) areas.set(k, v);
  platformOnly.clear();
  for (const [k, v] of snapshot.platformOnly) platformOnly.set(k, v);
  sections.clear();
  for (const [k, v] of snapshot.sections) sections.set(k, v);
  audiences.clear();
  for (const [k, v] of snapshot.audiences) audiences.set(k, v);
}

/** Nothing registered: Sunrise's shipped state. */
export const EMPTY_ACCESS_EXPLAINER_REGISTRY: AccessExplainerRegistrations = Object.freeze({
  areas: new Map(),
  platformOnly: new Map(),
  sections: new Map(),
  audiences: new Map(),
});
