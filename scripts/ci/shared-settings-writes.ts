/**
 * Which route handlers and capabilities change a shared setting, and do they
 * say so (§107 t-751).
 *
 * The rule lives in `lib/tenancy/shared-settings.ts`: at `multi`, shared
 * settings — rows of the `GLOBAL_CONFIG_MODELS` — change only from the install
 * org. Two places enforce it, and each needs the code to declare itself:
 *
 * - a route handler that changes one is
 *   `withAdminAuth(handler, { writesSharedSettings: true })`, and the guard
 *   refuses it;
 * - a capability class that changes one sets `writesSharedSettings = true`,
 *   and the dispatcher refuses it.
 *
 * This module finds the ones that should have declared. **A library, not a
 * CLI**: the always-run test
 * `tests/unit/scripts/ci/shared-settings-writes.test.ts` runs it over the tree.
 *
 * It uses the TypeScript parser, as `ownerless-surfaces.ts` beside it does and
 * for the reason that file gives: a list of source shapes written by hand
 * misses ordinary code.
 *
 * ## What counts as a write
 *
 * - A call to a Prisma write method (`create`, `update`, `upsert`, `delete`
 *   and their `Many` forms) on a property or element access named for a
 *   global-config model, on any receiver: `prisma.featureFlag.create`,
 *   `tx.aiCapability.update`, `db['knowledgeTag'].upsert`. The model names are
 *   derived from `GLOBAL_CONFIG_MODELS`, so a model added there is covered.
 * - SQL text — any string or template piece — that writes one of their tables
 *   (`UPDATE`, `INSERT INTO`, `DELETE FROM`).
 * - A call to a **writer**: a top-level function in any source file it is
 *   given (the test gives it `lib/` and the non-route files under `app/`), or
 *   in the route file itself, that writes, directly or by calling another
 *   writer. A function passed by name — `withAdminAuth(createThing)`,
 *   `items.map(save)` — counts as called, and so does `ns.fn()` through a
 *   namespace import (`import * as ns`). Any other `x.method()` does not: a
 *   method name like `update` would otherwise match every Prisma call in the
 *   tree. Found by a fixpoint over the call graph, by name. That
 *   over-approximates — two functions of the same name are one to it — and
 *   errs towards asking for a declaration, which is the safe direction.
 *
 * ## What it still cannot see, said plainly
 *
 * A write through a **nested relation** (`aiAgent.update({ data: { profile:
 * { create } } })`) names the parent model only. A **dynamic** model name
 * (`prisma[name]`) is not detected. A **method** of some other class is not
 * followed by name, and a capability is recognised only when its class
 * extends `BaseCapability` directly. It raises the floor; it is not a proof.
 */

import ts from 'typescript';
import { GLOBAL_CONFIG_MODELS } from '@/lib/tenancy/classification';

/** Writes that only add a row; an `upsert` joins them when its `update` is `{}`. */
const CREATE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn']);

const WRITE_METHODS = new Set([
  ...CREATE_METHODS,
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** `AiProviderModel` → `aiProviderModel`, the client accessor. */
export const GLOBAL_CONFIG_ACCESSORS: ReadonlySet<string> = new Set(
  GLOBAL_CONFIG_MODELS.map((model) => model[0].toLowerCase() + model.slice(1))
);

/** The mapped table names: `AiProviderModel` → `ai_provider_model`. */
const GLOBAL_CONFIG_TABLES = GLOBAL_CONFIG_MODELS.map((model) =>
  model.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
);
const SQL_WRITE = new RegExp(
  String.raw`\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+(?:"?public"?\.)?"?(?:${GLOBAL_CONFIG_TABLES.join('|')})\b`,
  'i'
);

/**
 * Functions whose own writes to a global-config model are still not a change
 * to a shared setting, keyed `path#name`. Their direct writes are ignored, so
 * their callers are not asked to declare; what they call is still followed.
 *
 * An entry is honoured only while every one of those writes **only adds what
 * is missing** — a `create`, or an `upsert` whose `update` is `{}` — so a later
 * edit that makes one of them change an existing row is reported, not hidden.
 * The reason is the content: it says why a write from a customer's org changes
 * nothing another org would notice.
 */
export const NON_CHANGING_WRITERS: Readonly<Record<string, string>> = {
  'lib/orchestration/settings.ts#createDefaultSettingsRow':
    'creates the orchestration settings singleton when it is missing, with the defaults every ' +
    'org would read anyway; it never changes a value.',
  'lib/orchestration/mcp/config.ts#getMcpServerConfig':
    'creates the MCP server singleton when it is missing, with the defaults; it never changes a ' +
    'value.',
  'lib/orchestration/knowledge/seeder.ts#materialisePatternsKnowledge':
    "writes the calling org's own copy of the patterns knowledge; its one shared write creates " +
    'the built-in patterns tag when it is missing, identical whoever creates it.',
  'lib/feature-flags/index.ts#seedDefaultFlags':
    'creates the default feature flags that are missing, never touching one that exists; run ' +
    'by the seed, which acts as the install org.',
};

/**
 * Route handlers that change a shared setting without declaring it, each with
 * the reason. Keyed `path#METHOD`. Empty in Sunrise: the backup import was the
 * one candidate, and it declares instead (§109 t-738 will split it).
 */
export const UNDECLARED_ROUTE_EXCEPTIONS: Readonly<Record<string, string>> = {};

export interface SourceFile {
  path: string;
  source: string;
}

/** A file parsed once, with the namespace imports its `ns.fn()` calls resolve through. */
interface Parsed {
  path: string;
  sf: ts.SourceFile;
  namespaces: ReadonlySet<string>;
}

function parse(file: SourceFile): Parsed {
  const sf = ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const namespaces = new Set<string>();
  for (const statement of sf.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
  }
  return { path: file.path, sf, namespaces };
}

/** The name an access expression reaches: `a.b` → `b`, `a['b']` → `b`. */
function accessedName(node: ts.Expression): string | null {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression)) {
    return inner.argumentExpression.text;
  }
  return null;
}

/** `upsert({ …, update: {} })` — it creates what is missing and changes nothing. */
function isCreateIfMissing(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === 'update' &&
      ts.isObjectLiteralExpression(p.initializer) &&
      p.initializer.properties.length === 0
  );
}

interface BodyFacts {
  /** It writes a global-config model itself. */
  writes: boolean;
  /** One of those writes can change or delete an existing row. */
  changes: boolean;
  /** Every name it calls or passes on: identifiers, and the last name of a property call. */
  calls: Set<string>;
}

function factsOf(body: ts.Node, namespaces: ReadonlySet<string>): BodyFacts {
  const facts: BodyFacts = { writes: false, changes: false, calls: new Set() };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) facts.calls.add(callee.text);
      // A function handed over by name runs as surely as one called.
      for (const arg of node.arguments) {
        if (ts.isIdentifier(arg)) facts.calls.add(arg.text);
      }
      const method = accessedName(callee);
      if (method) {
        const receiver =
          ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? callee.expression
            : null;
        if (receiver && ts.isIdentifier(receiver) && namespaces.has(receiver.text)) {
          facts.calls.add(method);
        }
        const model = receiver ? accessedName(receiver) : null;
        if (model && WRITE_METHODS.has(method) && GLOBAL_CONFIG_ACCESSORS.has(model)) {
          facts.writes = true;
          const onlyAdds =
            CREATE_METHODS.has(method) || (method === 'upsert' && isCreateIfMissing(node));
          if (!onlyAdds) facts.changes = true;
        }
      }
    }
    if (
      (ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      SQL_WRITE.test(node.text)
    ) {
      facts.writes = true;
      facts.changes = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return facts;
}

/** Top-level named functions: declarations, and `const f = () => …` / `function () …`. */
function topLevelFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      out.set(statement.name.text, statement.body);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          out.set(decl.name.text, decl.initializer.body);
        }
      }
    }
  }
  return out;
}

/**
 * Each top-level function's facts, with a {@link NON_CHANGING_WRITERS} entry's
 * own writes dropped — only while they only add. Same name in two files: one
 * node, the union of both (see the header).
 */
function graphOf(files: readonly Parsed[]): Map<string, BodyFacts> {
  const graph = new Map<string, BodyFacts>();
  for (const file of files) {
    for (const [name, body] of topLevelFunctions(file.sf)) {
      const facts = factsOf(body, file.namespaces);
      const own =
        `${file.path}#${name}` in NON_CHANGING_WRITERS && !facts.changes
          ? { ...facts, writes: false }
          : facts;
      const held = graph.get(name);
      graph.set(
        name,
        held
          ? {
              writes: held.writes || own.writes,
              changes: held.changes || own.changes,
              calls: new Set([...held.calls, ...own.calls]),
            }
          : own
      );
    }
  }
  return graph;
}

/** Close over `graph`, starting from `seed`: every function that calls a writer is a writer. */
function closeOver(graph: ReadonlyMap<string, BodyFacts>, seed: ReadonlySet<string>): Set<string> {
  const writers = new Set(seed);
  for (const [name, facts] of graph) {
    if (facts.writes) writers.add(name);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, facts] of graph) {
      if (writers.has(name)) continue;
      if ([...facts.calls].some((called) => writers.has(called))) {
        writers.add(name);
        grew = true;
      }
    }
  }
  return writers;
}

/** Every top-level function in `files` that changes a shared setting, directly or through another. */
export function libWriters(files: readonly SourceFile[]): Set<string> {
  return closeOver(graphOf(files.map(parse)), new Set());
}

/**
 * The {@link NON_CHANGING_WRITERS} entries that no longer hold: the function
 * is gone, writes nothing to excuse, or now changes an existing row.
 */
export function staleNonChangingWriters(
  files: readonly SourceFile[],
  entries: Readonly<Record<string, string>> = NON_CHANGING_WRITERS
): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(entries)) {
    const [path, name] = key.split('#');
    const file = files.find((f) => f.path === path);
    const parsed = file ? parse(file) : undefined;
    const body = parsed ? topLevelFunctions(parsed.sf).get(name) : undefined;
    if (!parsed || !body) {
      problems.push(`${key}: no such function`);
      continue;
    }
    const facts = factsOf(body, parsed.namespaces);
    if (!facts.writes) problems.push(`${key}: writes no shared setting — remove the entry`);
    else if (facts.changes) {
      problems.push(`${key}: changes or deletes an existing row, so it is a writer like any other`);
    }
  }
  return problems;
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface RouteHandler {
  method: string;
  /** The handler changes a shared setting. */
  writes: boolean;
  /** It is `withAdminAuth(…, { writesSharedSettings: true })`. */
  declares: boolean;
}

function declaresOption(call: ts.CallExpression): boolean {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'withAdminAuth') return false;
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === 'writesSharedSettings' &&
      p.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

/** Each exported HTTP handler in a route file: does it write, and does it declare? */
export function analyzeRoute(file: SourceFile, writers: ReadonlySet<string>): RouteHandler[] {
  const parsed = parse(file);
  const { sf } = parsed;
  const reachable = closeOver(graphOf([parsed]), writers);

  const handlers: RouteHandler[] = [];
  const judge = (method: string, body: ts.Node, declares: boolean): void => {
    const facts = factsOf(body, parsed.namespaces);
    handlers.push({
      method,
      writes: facts.writes || [...facts.calls].some((called) => reachable.has(called)),
      declares,
    });
  };
  for (const statement of sf.statements) {
    const exported = ts.canHaveModifiers(statement)
      ? ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (!exported) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      if (HTTP_METHODS.has(statement.name.text)) judge(statement.name.text, statement.body, false);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !HTTP_METHODS.has(decl.name.text) || !decl.initializer) {
          continue;
        }
        const init = decl.initializer;
        judge(decl.name.text, init, ts.isCallExpression(init) && declaresOption(init));
      }
    }
  }
  return handlers;
}

export interface CapabilityClass {
  /** `path#ClassName`. */
  name: string;
  /** A method or property of the class changes a shared setting. */
  writes: boolean;
  /** It sets `writesSharedSettings = true`. */
  declares: boolean;
}

function extendsBaseCapability(node: ts.ClassDeclaration): boolean {
  return (node.heritageClauses ?? []).some(
    (clause) =>
      clause.token === ts.SyntaxKind.ExtendsKeyword &&
      clause.types.some((t) => {
        const expr = t.expression;
        return ts.isIdentifier(expr) && expr.text === 'BaseCapability';
      })
  );
}

/** Every class in `file` that extends `BaseCapability`: does it write, and does it declare? */
export function analyzeCapabilities(
  file: SourceFile,
  writers: ReadonlySet<string>
): CapabilityClass[] {
  if (!file.source.includes('BaseCapability')) return [];
  const parsed = parse(file);
  const { sf } = parsed;
  const reachable = closeOver(graphOf([parsed]), writers);
  const out: CapabilityClass[] = [];
  for (const statement of sf.statements) {
    if (!ts.isClassDeclaration(statement) || !statement.name) continue;
    if (!extendsBaseCapability(statement)) continue;
    const facts = factsOf(statement, parsed.namespaces);
    const declares = statement.members.some(
      (m) =>
        ts.isPropertyDeclaration(m) &&
        ts.isIdentifier(m.name) &&
        m.name.text === 'writesSharedSettings' &&
        m.initializer?.kind === ts.SyntaxKind.TrueKeyword
    );
    out.push({
      name: `${file.path}#${statement.name.text}`,
      writes: facts.writes || [...facts.calls].some((called) => reachable.has(called)),
      declares,
    });
  }
  return out;
}

export interface SharedSettingsViolation {
  /** `path#METHOD` for a route, `path#ClassName` for a capability. */
  handler: string;
  problem: string;
}

/**
 * Every route handler and capability class that changes a shared setting
 * without declaring it, and every route exception that no longer matches a
 * handler that would need it.
 *
 * `sources` is where writers are looked for — `lib/` and the non-route files
 * under `app/`; capability classes are looked for there too. Pass `writers`
 * when the caller has already computed {@link libWriters} over the same
 * sources, so the tree is parsed once.
 */
export function findUndeclaredSharedSettingsWrites(
  routes: readonly SourceFile[],
  sources: readonly SourceFile[],
  exceptions: Readonly<Record<string, string>> = UNDECLARED_ROUTE_EXCEPTIONS,
  writers: ReadonlySet<string> = libWriters(sources)
): SharedSettingsViolation[] {
  const violations: SharedSettingsViolation[] = [];
  const used = new Set<string>();
  for (const route of routes) {
    for (const handler of analyzeRoute(route, writers)) {
      const key = `${route.path}#${handler.method}`;
      if (!handler.writes || handler.declares) continue;
      if (key in exceptions) {
        used.add(key);
        continue;
      }
      violations.push({
        handler: key,
        problem:
          'changes a shared setting without `withAdminAuth(…, { writesSharedSettings: true })` ' +
          '— only withAdminAuth can declare it; a withAuth route must not write shared settings',
      });
    }
  }
  for (const source of sources) {
    for (const capability of analyzeCapabilities(source, writers)) {
      if (capability.writes && !capability.declares) {
        violations.push({
          handler: capability.name,
          problem:
            'is a capability that changes a shared setting without `writesSharedSettings = true`',
        });
      }
    }
  }
  for (const key of Object.keys(exceptions)) {
    if (!used.has(key)) {
      violations.push({
        handler: key,
        problem: 'is excepted, but no undeclared shared-settings write was found there — remove it',
      });
    }
  }
  return violations;
}
