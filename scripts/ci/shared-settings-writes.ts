/**
 * Which route handlers change a shared setting, and do they say so (§107 t-751).
 *
 * The rule lives in `lib/tenancy/shared-settings.ts`: at `multi`, shared
 * settings — rows of the `GLOBAL_CONFIG_MODELS` — change only from the install
 * org, and a route that changes one declares
 * `withAdminAuth(handler, { writesSharedSettings: true })` so the guard
 * enforces it. This module finds the routes that should have declared it. **A
 * library, not a CLI**: the always-run test
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
 * - A call to a **writer**: a top-level function anywhere under `lib/`, or in
 *   the route file itself, that writes, directly or by calling another writer.
 *   Found by a fixpoint over the call graph, by name. That over-approximates
 *   — two functions of the same name are one to it — and the over-approximation
 *   errs towards asking a route to declare, which is the safe direction.
 *
 * ## What it still cannot see, said plainly
 *
 * A write through a **nested relation** (`aiAgent.update({ data: { profile:
 * { create } } })`) names the parent model only. A **dynamic** model name
 * (`prisma[name]`) is not detected. A write reached through a class method or
 * a callback passed as a value is not followed: the built-in capabilities that
 * write provider models are methods, reached through the dispatcher, and carry
 * their own check and their own tests. It raises the floor; it is not a proof.
 */

import ts from 'typescript';
import { GLOBAL_CONFIG_MODELS } from '@/lib/tenancy/classification';

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
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
 * Functions that write a global-config model and are still not a change to a
 * shared setting. Each is treated as a non-writer, so its callers are not
 * asked to declare. The reason is the content: an entry here says why a write
 * made from a customer's org changes nothing another org would notice.
 */
export const NON_CHANGING_WRITERS: Readonly<Record<string, string>> = {
  createDefaultSettingsRow:
    'creates the orchestration settings singleton when it is missing (`update: {}`), with the ' +
    'defaults every org would read anyway; it never changes a value.',
  getMcpServerConfig:
    'creates the MCP server singleton when it is missing (`update: {}`), with the defaults; it ' +
    'never changes a value.',
  materialisePatternsKnowledge:
    "writes the calling org's own copy of the patterns knowledge; its one shared write creates " +
    'the built-in patterns tag when it is missing (`update: {}`), identical whoever creates it.',
  seedDefaultFlags:
    'creates the default feature flags that are missing, never touching one that exists; run ' +
    'by the seed, which acts as the install org.',
};

/**
 * Route handlers that change a shared setting without declaring it, each with
 * the reason. Keyed `path#METHOD`.
 */
export const UNDECLARED_ROUTE_EXCEPTIONS: Readonly<Record<string, string>> = {
  'app/api/v1/admin/orchestration/backup/import/route.ts#POST':
    'restores tenant data and shared settings together; §109 t-738 re-scopes the importer to ' +
    'the importing org and applies the install-org rule to the shared part (note on t-738). ' +
    'Refusing the whole import here would block an org restoring its own agents.',
};

export interface SourceFile {
  path: string;
  source: string;
}

function parse(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.source,
    ts.ScriptTarget.Latest,
    true,
    file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
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

interface BodyFacts {
  /** It writes a global-config model itself. */
  writes: boolean;
  /** Every name it calls: identifiers, and the last name of a property call. */
  calls: Set<string>;
}

function factsOf(body: ts.Node): BodyFacts {
  const facts: BodyFacts = { writes: false, calls: new Set() };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) facts.calls.add(callee.text);
      const method = accessedName(callee);
      if (method) {
        facts.calls.add(method);
        const receiver =
          ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? callee.expression
            : null;
        const model = receiver ? accessedName(receiver) : null;
        if (model && WRITE_METHODS.has(method) && GLOBAL_CONFIG_ACCESSORS.has(model)) {
          facts.writes = true;
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

/** Close `seed` over `graph`: every function that calls a writer is a writer. */
function closeOver(
  graph: ReadonlyMap<string, BodyFacts>,
  seed: ReadonlySet<string>,
  exempt: ReadonlySet<string>
): Set<string> {
  const writers = new Set([...seed].filter((name) => !exempt.has(name)));
  for (const [name, facts] of graph) {
    if (facts.writes && !exempt.has(name)) writers.add(name);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, facts] of graph) {
      if (writers.has(name) || exempt.has(name)) continue;
      if ([...facts.calls].some((called) => writers.has(called))) {
        writers.add(name);
        grew = true;
      }
    }
  }
  return writers;
}

/**
 * Every top-level function under `lib/` that changes a shared setting,
 * directly or through another. Names in {@link NON_CHANGING_WRITERS} are left
 * out, and so is everything that reaches a write only through them.
 */
export function libWriters(files: readonly SourceFile[]): Set<string> {
  const graph = new Map<string, BodyFacts>();
  for (const file of files) {
    for (const [name, body] of topLevelFunctions(parse(file))) {
      const facts = factsOf(body);
      const held = graph.get(name);
      // Same name in two files: one node, the union of both (see the header).
      graph.set(
        name,
        held
          ? { writes: held.writes || facts.writes, calls: new Set([...held.calls, ...facts.calls]) }
          : facts
      );
    }
  }
  return closeOver(graph, new Set(), new Set(Object.keys(NON_CHANGING_WRITERS)));
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
  const sf = parse(file);
  const local = new Map<string, BodyFacts>();
  for (const [name, body] of topLevelFunctions(sf)) local.set(name, factsOf(body));
  const reachable = closeOver(local, writers, new Set(Object.keys(NON_CHANGING_WRITERS)));

  const handlers: RouteHandler[] = [];
  const judge = (method: string, body: ts.Node, declares: boolean): void => {
    const facts = factsOf(body);
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

export interface SharedSettingsViolation {
  /** `path#METHOD`. */
  handler: string;
  problem: string;
}

/**
 * Every route handler that changes a shared setting without declaring it, and
 * every exception that no longer matches a handler that would need it.
 */
export function findUndeclaredSharedSettingsWrites(
  routes: readonly SourceFile[],
  lib: readonly SourceFile[],
  exceptions: Readonly<Record<string, string>> = UNDECLARED_ROUTE_EXCEPTIONS
): SharedSettingsViolation[] {
  const writers = libWriters(lib);
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
          'changes a shared setting without `withAdminAuth(…, { writesSharedSettings: true })`',
      });
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
