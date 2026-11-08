/**
 * Is the org-tier roster what the tree declares? (§111 t-810)
 *
 * `lib/auth/admin-tier.ts` holds one roster of the admin surfaces an org
 * OWNER/ADMIN may use. Pages are declared IN it; API routes are declared at
 * their call site (`withAdminAuth(handler, { tier: 'org' })`) and listed in it.
 * This module checks the two agree, so opening a surface is always a diff to
 * the roster a reviewer can see — ruling 5 on §111. **A library, not a CLI**:
 * the always-run test `tests/unit/scripts/ci/admin-tier-roster.test.ts` runs
 * it over the tree.
 *
 * What it reports:
 *
 * - a route handler declared `tier: 'org'` that neither core's roster nor
 *   the fork's (`lib/app/admin-tier-routes.ts`) lists, or one listed in either
 *   that does not declare it, or a core route the fork re-lists;
 * - a `tier` the scanner cannot read as the literal `'org'` — a variable or a
 *   spread hides the declaration from review, which is the thing the roster is for;
 * - an org-tier handler with no `ownership` declaration. An org admin's rows
 *   are narrowed to their own, so the guard demands one the first time it
 *   admits them (refusing under test, logging elsewhere); this says so at
 *   review time instead of at the first request;
 * - a listed page with no `page.tsx` behind it, core's or the fork's;
 * - a nav item, core's or the fork's, marked `tier: 'org'` over a page that is not listed —
 *   a link an org admin would follow to a redirect;
 * - a page that is not listed but whose URL a listed pattern names — a `[x]`
 *   segment that also takes a literal page beside it (`/admin/reports/[id]`
 *   over `/admin/reports/settings`). Next.js serves the literal page, and the
 *   matcher, which cannot see the tree, would call it org-tier;
 * - a core section (`CORE_ADMIN_SECTIONS`) with no page under it, or a core
 *   page or nav item in a section the list does not name — the list is what
 *   keeps a fork's pages out of core's.
 *
 * Named tiers (t-999) are held to the same checks, and to three of their own:
 * a route, page or nav item may declare a tier only if the fork registered it
 * (`registerAdminTier()`); a nav item marked with a named tier must point at a
 * page registered for that tier, which is the page its holders can open; and
 * a tier's `landing` must be a page registered for it, word for word. A nav
 * item marked `'org'` over a named-tier page is reported too: its holders
 * would never see it.
 *
 * With core sections closed (`closeCoreOrgTierSection()`, t-929), a fork's nav
 * item is judged against the narrowed list: one marked `tier: 'org'` over a
 * closed core page is a link an org admin would follow to a redirect. Core's
 * own items in a closed section are not reported — the sidebar hides them.
 *
 * Uses the TypeScript parser, as `shared-settings-writes.ts` beside it does.
 */
import ts from 'typescript';
import {
  adminPageTier,
  adminPageTierOf,
  adminSectionOf,
  matchesAdminPagePattern,
  withoutClosedSections,
  type NamedTierAdminPage,
} from '@/lib/auth/admin-tier';
import { namedTierLandingProblem } from '@/lib/auth/admin-landing';

export interface SourceFile {
  path: string;
  source: string;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** One `withAdminAuth(…)` call that passes a `tier` option, or might. */
export interface TierDeclaration {
  /** `path#METHOD`. */
  at: string;
  /**
   * The option's value when it is a string literal — `'org'`, or a named
   * tier — or `null` when it is anything else (a variable, a spread), which
   * review cannot read. Whether the literal names a tier anyone registered is
   * {@link findAdminTierRosterProblems}'s to say.
   */
  tier: string | null;
  /** The same options object declares `ownership`. */
  declaresOwnership: boolean;
}

/** A property's key as written — `tier`, `'tier'`, `"tier"` — or `null` for a computed one. */
function keyText(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) return p.name.text;
  return null;
}

/** Strip the wrappers an expression can sit inside without changing its value. */
function unwrapUp(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent) ||
    ts.isNonNullExpression(current.parent) ||
    // An outer wrapper call: `wrap(withAdminAuth(…))`.
    (ts.isCallExpression(current.parent) &&
      current.parent.arguments.includes(current as ts.Expression))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * The name a `withAdminAuth(…)` call is bound to: the variable it initialises
 * (through `as`, `satisfies`, parentheses and wrapper calls), or the function
 * it is called inside. `null` when it is bound to neither.
 */
function boundName(call: ts.CallExpression): string | null {
  const top = unwrapUp(call);
  if (ts.isVariableDeclaration(top.parent) && ts.isIdentifier(top.parent.name)) {
    return top.parent.name.text;
  }
  for (let node: ts.Node | undefined = top.parent; node; node = node.parent) {
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    // `const withOrgAdmin = (h) => withAdminAuth(h, …)` — a wrapper.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  }
  return null;
}

/** `export { handler as GET, handler as HEAD }` → `handler` ↦ `['GET', 'HEAD']`. */
function exportedAs(sf: ts.SourceFile): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const statement of sf.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const specifier of statement.exportClause.elements) {
      const local = (specifier.propertyName ?? specifier.name).text;
      map.set(local, [...(map.get(local) ?? []), specifier.name.text]);
    }
  }
  return map;
}

/** The names `withAdminAuth` is called by here: itself, and any import alias of it. */
function guardNames(sf: ts.SourceFile): Set<string> {
  const names = new Set(['withAdminAuth']);
  for (const statement of sf.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'withAdminAuth') {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/**
 * Every `withAdminAuth(…)` call in a source file that passes a `tier`, or that
 * might — wherever the call sits, however the handler is exported, and under
 * whatever name the guard was imported.
 *
 * Scanning calls rather than `export const GET = …` statements is the point:
 * the guard acts on any call, so a scanner that recognises one export shape
 * reports a clean tree for every other shape (`export { h as GET }`, a call
 * under `as` or `satisfies`, a call inside `export async function GET`). The
 * test runs it over every module under `app/` and `lib/`, not the route files
 * alone, so a wrapper that bakes the tier in (`withOrgAdmin = (h) =>
 * withAdminAuth(h, { tier: 'org', … })`) is reported under its own name and
 * has to be listed, wherever it sits — `lib/`, or a fork's
 * `app/api/v1/app/reports/_lib/`. The routes that use it are then reviewed as
 * uses of a listed wrapper.
 */
export function tierDeclarations(file: SourceFile): TierDeclaration[] {
  const sf = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true);
  const aliases = exportedAs(sf);
  const guards = guardNames(sf);
  const found: TierDeclaration[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      guards.has(node.expression.text)
    ) {
      judge(node);
    }
    ts.forEachChild(node, visit);
  };

  const judge = (call: ts.CallExpression): void => {
    const options = call.arguments[1];
    if (!options) return;
    const name = boundName(call);
    const methods = name
      ? HTTP_METHODS.has(name)
        ? [name]
        : (aliases.get(name) ?? []).filter((m) => HTTP_METHODS.has(m))
      : [];
    const ats = (methods.length ? methods : [name ?? '(unbound)']).map((m) => `${file.path}#${m}`);
    const record = (tier: string | null, declaresOwnership: boolean): void => {
      for (const at of ats) found.push({ at, tier, declaresOwnership });
    };
    const unreadable = (): void => record(null, false);

    if (!ts.isObjectLiteralExpression(options)) {
      // Options built elsewhere could carry a tier the scanner cannot see.
      // Reported when the text mentions one (`ORG_TIER_OPTIONS`), so ordinary
      // shared option constants stay quiet. A constant whose name says
      // nothing of a tier slips past: write the option inline.
      if (/tier/i.test(options.getText())) unreadable();
      return;
    }
    const tier = options.properties.find((p) => keyText(p) === 'tier');
    const hidden = options.properties.some(
      (p) =>
        (ts.isSpreadAssignment(p) || (p.name && keyText(p) === null)) && /tier/i.test(p.getText())
    );
    if (!tier) {
      if (hidden) unreadable();
      return;
    }
    record(
      !hidden && ts.isPropertyAssignment(tier) && ts.isStringLiteralLike(tier.initializer)
        ? tier.initializer.text
        : null,
      options.properties.some((p) => keyText(p) === 'ownership')
    );
  };

  visit(sf);
  return found;
}

/** A core nav item, as much of it as the check reads. */
export interface NavItemFacts {
  href: string;
  tier?: string;
}

export interface RosterInput {
  /** Every module under `app/` and `lib/`: route files, and the wrappers beside them. */
  routes: readonly SourceFile[];
  /** `ORG_TIER_ADMIN_ROUTES`. */
  listedRoutes: readonly string[];
  /**
   * The fork's routes, from `lib/app/admin-tier-routes.ts`. Held to the same
   * checks as core's, and named as the fork's in a problem.
   */
  appListedRoutes?: readonly string[];
  /** `ORG_TIER_ADMIN_PAGES`. */
  listedPages: readonly string[];
  /**
   * The fork's pages, from `lib/app/admin-tier.ts` (`getAppOrgTierAdminPages()`).
   * Held to the same checks as core's, and named as the fork's in a problem.
   */
  appListedPages?: readonly string[];
  /** Every `page.tsx` path under `app/admin`, repo-relative. */
  pageFiles: readonly string[];
  /** Every sidebar item: core's, and the sections the fork registered. */
  navItems: readonly NavItemFacts[];
  /** `CORE_ADMIN_SECTIONS`. Unchecked when left out. */
  coreSections?: readonly string[];
  /** Core's sidebar hrefs alone, for the section check. */
  coreNavHrefs?: readonly string[];
  /** The core sections the fork closed to org admins (`closedCoreOrgTierSections()`). */
  closedSections?: readonly string[];
  /**
   * The fork's named tiers (t-999), as `registerAdminTier()` left them: the
   * name, and the landing when it named one. Empty when left out, so a named
   * tier anywhere is reported as unregistered.
   */
  namedTiers?: readonly { name: string; landing?: string }[];
  /**
   * The fork's pages registered for a named tier (`namedTierAdminPages()`).
   * Each is also in {@link appListedPages}, as the registry keeps them.
   */
  appNamedTierPages?: readonly NamedTierAdminPage[];
}

/** The URL pattern a page file serves: `app/admin/(g)/x/[id]/page.tsx` → `/admin/x/[id]`. */
function pagePattern(file: string): string {
  return file
    .replace(/^app/, '')
    .replace(/\/page\.tsx$/, '')
    .split('/')
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .join('/');
}

/** Everything about the roster that does not match the tree, one sentence each. */
export function findAdminTierRosterProblems(input: RosterInput): string[] {
  const problems: string[] = [];
  const namedTiers = input.namedTiers ?? [];
  const tierNames = new Set(['org', ...namedTiers.map((t) => t.name)]);
  const declarations = input.routes.flatMap(tierDeclarations);
  // A route counts as declared when its tier is one that opens something:
  // `'org'`, or a named tier the fork registered. One naming no registered
  // tier is reported below and opens nothing, as the policy answers it.
  const declaredTier = new Map(
    declarations
      .filter((d) => d.tier !== null && tierNames.has(d.tier))
      .map((d) => [d.at, d.tier ?? 'org'])
  );
  const declared = new Set(declaredTier.keys());
  const listed = new Set(input.listedRoutes);

  for (const d of declarations) {
    if (d.tier === null) {
      problems.push(
        `${d.at}: its \`tier\` is not a string literal, so review cannot see what it opens. Write the tier in the options object: \`tier: 'org'\`, or the named tier's name.`
      );
    } else if (!tierNames.has(d.tier)) {
      problems.push(
        `${d.at}: declared tier '${d.tier}', which is neither 'org' nor a tier registered with registerAdminTier() in lib/app/admin-tier.ts, so it admits nobody. Register the tier, or fix the name.`
      );
    } else if (!d.declaresOwnership) {
      problems.push(
        `${d.at}: declared tier '${d.tier}' with no \`ownership\`. An org admin's rows are narrowed to their own, so the guard demands one when it admits them — declare it.`
      );
    }
  }
  const appListed = new Set(input.appListedRoutes ?? []);
  for (const at of declared) {
    if (!listed.has(at) && !appListed.has(at)) {
      problems.push(
        `${at}: declared tier '${declaredTier.get(at)}' but not listed in ORG_TIER_ADMIN_ROUTES (core's) or lib/app/admin-tier-routes.ts (the fork's).`
      );
    }
  }
  for (const at of listed) {
    // Core's routes open to the org tier, never to a fork's named one.
    const tier = declaredTier.get(at);
    if (tier !== undefined && tier !== 'org') {
      problems.push(
        `${at}: listed in ORG_TIER_ADMIN_ROUTES, core's, but declares the named tier '${tier}'. Core's routes are 'org'.`
      );
    }
  }
  const routeLists: [string, ReadonlySet<string>][] = [
    ['ORG_TIER_ADMIN_ROUTES', listed],
    ['lib/app/admin-tier-routes.ts', appListed],
  ];
  for (const at of appListed) {
    // The fork's list means "routes the fork opened". A core route there
    // passes either way, and a core rename would then be reported against a
    // file core does not own.
    if (listed.has(at)) {
      problems.push(
        `${at}: listed in lib/app/admin-tier-routes.ts, but it is core's and ORG_TIER_ADMIN_ROUTES already lists it. Remove it from the fork's list.`
      );
    }
  }
  // A route whose literal names no registered tier was reported above; saying
  // again that it "does not declare" one would misdescribe the same mistake.
  const misnamed = new Set(
    declarations.filter((d) => d.tier !== null && !tierNames.has(d.tier)).map((d) => d.at)
  );
  for (const [where, ats] of routeLists) {
    for (const at of ats) {
      if (!declared.has(at) && !misnamed.has(at)) {
        problems.push(
          `${at}: listed in ${where} but does not declare tier 'org' or a registered named tier.`
        );
      }
    }
  }

  const pageFiles = new Set(input.pageFiles);
  const appPages = input.appListedPages ?? [];
  const pageLists: [string, readonly string[]][] = [
    ['ORG_TIER_ADMIN_PAGES', input.listedPages],
    ['lib/app/admin-tier.ts', appPages],
  ];
  for (const [where, pages] of pageLists) {
    for (const pattern of pages) {
      // `matchesAdminPagePattern` takes literal and `[x]` segments only. A
      // catch-all would never match, and a route group is not in the URL, so
      // either would be a page the roster says is open and the layout refuses.
      if (/\[\[|\[\.\.\.|\(/.test(pattern)) {
        problems.push(
          `${pattern}: listed in ${where} with a catch-all or route-group segment, which the matcher cannot match. List the URL pattern with [x] segments only.`
        );
        continue;
      }
      const file = `app${pattern}/page.tsx`;
      if (!pageFiles.has(file)) {
        problems.push(`${pattern}: listed in ${where} but ${file} does not exist.`);
      }
    }
  }

  const allPages = [...input.listedPages, ...appPages];
  const listedSet = new Set(allPages);
  for (const file of input.pageFiles) {
    const path = pagePattern(file);
    // A catch-all page is matched by nothing here; the catch-all check above
    // keeps one off the list.
    if (listedSet.has(path) || /\[\[|\[\.\.\./.test(path)) continue;
    const by = allPages.find((pattern) => matchesAdminPagePattern(pattern, path));
    if (by) {
      problems.push(
        `${path}: not listed, but the listed pattern ${by} names its URL, so an org admin would be let into it. List it if it is the org's, or list the dynamic page's siblings one by one.`
      );
    }
  }

  if (input.coreSections) {
    const sections = new Set(input.coreSections);
    for (const section of sections) {
      if (!input.pageFiles.some((file) => file.startsWith(`app/admin/${section}/`))) {
        problems.push(
          `CORE_ADMIN_SECTIONS lists ${section}, but app/admin/${section}/ has no page.`
        );
      }
    }
    for (const path of [...input.listedPages, ...(input.coreNavHrefs ?? [])]) {
      const section = adminSectionOf(path);
      if (section !== null && !sections.has(section)) {
        problems.push(
          `${path}: core's, in a section CORE_ADMIN_SECTIONS does not name, so a fork could list pages in it. Add ${section}.`
        );
      }
    }
  }

  const closed = input.closedSections ?? [];
  for (const at of appListed) {
    // `app/api/v1/admin/orchestration/x/route.ts#GET` → `orchestration`.
    const section = adminSectionOf(at.replace(/^app/, ''));
    if (section !== null && closed.includes(section) && declared.has(at)) {
      problems.push(
        `${at}: declared tier '${declaredTier.get(at)}' in a core section lib/app/admin-tier.ts closed to org admins, so the guard refuses org admins it. Move the route out of the section or drop its tier.`
      );
    }
  }
  const openPages = [...withoutClosedSections(input.listedPages, closed), ...appPages];
  const coreHrefs = new Set(input.coreNavHrefs ?? []);
  const namedPages = input.appNamedTierPages ?? [];
  for (const item of input.navItems) {
    if (item.tier !== undefined && item.tier !== 'org') {
      const page = item.href.split(/[?#]/)[0];
      if (!tierNames.has(item.tier)) {
        problems.push(
          `nav item ${item.href}: marked tier '${item.tier}', which is neither 'org' nor a tier registered with registerAdminTier(), so nobody but a platform admin sees it.`
        );
      } else if (adminPageTierOf(page, allPages, namedPages) !== item.tier) {
        problems.push(
          `nav item ${item.href}: marked tier '${item.tier}' over a page not registered for that tier, so its holders would follow it to a redirect. Register the page with { tier: '${item.tier}' }, or mark the item with the page's tier.`
        );
      }
      continue;
    }
    if (item.tier !== 'org') continue;
    // The page an href opens: a query string or fragment is not part of it.
    const page = item.href.split(/[?#]/)[0];
    const pageTier = adminPageTierOf(page, allPages, namedPages);
    if (pageTier !== null && pageTier !== 'org') {
      // An org admin sees it either way; the page's holders never do, since
      // the sidebar shows them only items marked with a tier they hold.
      problems.push(
        `nav item ${item.href}: marked tier 'org' over a page registered for tier '${pageTier}', so that tier's holders never see it. Mark the item with tier '${pageTier}'.`
      );
    } else if (adminPageTier(page, allPages) !== 'org') {
      problems.push(
        `nav item ${item.href}: marked tier 'org' over a page neither ORG_TIER_ADMIN_PAGES nor lib/app/admin-tier.ts lists, so an org admin would follow it to a redirect.`
      );
    } else if (!coreHrefs.has(item.href) && adminPageTier(page, openPages) !== 'org') {
      problems.push(
        `nav item ${item.href}: marked tier 'org' over a page in a core section lib/app/admin-tier.ts closed to org admins, so an org admin would follow it to a redirect.`
      );
    }
  }
  for (const { name, landing } of namedTiers) {
    if (landing === undefined) continue;
    const problem = namedTierLandingProblem(name, landing, namedPages);
    if (problem !== null) {
      problems.push(
        `named tier '${name}': its landing ${landing} ${problem} /admin would ignore it and log why.`
      );
    }
  }
  return problems;
}
