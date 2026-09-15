/**
 * Which files read a row nobody owns without asking — found by the parser.
 *
 * The rule, the roster and the reasons live in
 * `lib/orchestration/access/ownerless-surfaces.ts`, beside the helpers they
 * carve out of; read that first. This module is the mechanics: given a source
 * file, which of `AiWorkflowExecution`, `AiConversation`, `AiMessage` does it
 * read, and does it import the access helper for each? The always-run test
 * `tests/unit/scripts/ci/ownerless-surfaces.test.ts` runs it over the tree.
 *
 * **It is the TypeScript parser, not a regex over text — and that is a lesson,
 * not a preference.** The first draft tokenized source by hand and three
 * review rounds each found shapes it could not see: optional chaining,
 * bracket access, a destructured client, a schema-qualified or multi-line
 * `FROM`, a SQL line beginning with `*` skipped as a docblock, a `//` in JSX
 * text swallowing the rest of a line, a type-only import counted as coverage.
 * Every one is ordinary code. A list of source-code shapes is exactly as
 * reliable as the afternoon spent making it — which is the thesis of the check
 * itself, reproduced inside the tool. The parser already knows every shape,
 * and comments do not exist in its output, so there is nothing to strip and
 * nothing to desync.
 *
 * ## What counts as a read
 *
 * - A **property or element access** whose name is one of the three models,
 *   on any receiver: `prisma.aiConversation`, `tx?.aiMessage`,
 *   `(tx ?? prisma).aiMessage`, `getDb().aiWorkflowExecution`,
 *   `prisma['aiConversation']`.
 * - A **destructuring binding** off a client: `const { aiMessage } = prisma`,
 *   renamed or not.
 * - A **table name in SQL text** — any string or template literal — after
 *   `FROM`, `JOIN`, `INTO` or `UPDATE`, tolerating a schema qualifier, a
 *   substitution, and whitespace across lines; and the `Prisma.raw('ai_…')`
 *   form, where the keyword sits on the other side of a template boundary.
 *
 * ## What satisfies it
 *
 * An import of one of the helper's **value exports** — named, aliased or
 * through a namespace — that the file uses in a value position. Which names
 * are value exports is read off the helper's own source
 * ({@link valueExportsOf}), so an interface imported without the `type`
 * keyword — legal under `isolatedModules`, and the helpers export
 * `AccessBasis`, `AdminCanViewResult` and `ExecutionOwner` — covers nothing:
 * a type reaches nothing at runtime, so it cannot be the road a query took. An
 * import nothing uses is reported by name, so the check cannot be silenced with
 * one line.
 *
 * ## What it still cannot see, said plainly
 *
 * A read through a **relation include** — `prisma.aiWorkflow.findMany({
 * include: { executions: true } })` — names no model and is not detected; the
 * test pins that as a fact. A file that imports the helper and runs an
 * unscoped query beside it passes. And a **dynamic** model name
 * (`prisma[name]`) is invisible to any static check. It raises the floor; it
 * is not a proof.
 *
 * {@link unexplainedMentions} is the oracle the detector does not control:
 * every identifier spelled like a model that sits in expression position, and
 * every table name inside any string or template piece, must correspond to a
 * detected read of that model, or it is reported. It keys on the names, not
 * on the shapes above, so a shape the detector has never heard of — in code or
 * in SQL — shows up here rather than passing quietly.
 */

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  OWNERLESS_MODELS,
  OWNERLESS_SURFACE_EXCEPTIONS,
  validateExceptions,
  type OwnerlessModel,
  type OwnerlessSurfaceException,
  type OwnerlessSurfaceViolation,
} from '@/lib/orchestration/access/ownerless-surfaces';

type HelperModule = (typeof OWNERLESS_MODELS)[OwnerlessModel];

const HELPER_SPECIFIER = /^@\/lib\/orchestration\/access\/(execution-access|conversation-access)$/;

const TABLE_TO_MODEL: Readonly<Record<string, OwnerlessModel>> = {
  ai_workflow_execution: 'aiWorkflowExecution',
  ai_conversation: 'aiConversation',
  ai_message: 'aiMessage',
};

/**
 * A table after a keyword that reads or writes it, in SQL text. The optional
 * qualifier accepts a schema (`public.`, `"public".`) and the `?` a template
 * substitution is rendered as (`${schema}.ai_conversation`).
 */
const RAW_TABLE =
  /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:["\w?]+\.)?"?(ai_workflow_execution|ai_conversation|ai_message)\b/gi;

/** Any spelling of any of the three models, anywhere in the text — the cheap pre-filter and the oracle's population. */
const ANY_MENTION =
  /aiWorkflowExecution|aiConversation|aiMessage|ai_workflow_execution|ai_conversation|ai_message/;

/** The two helper modules, which query Prisma directly by definition. Named files, not a directory. */
const SKIPPED_FILES = new Set([
  'lib/orchestration/access/execution-access.ts',
  'lib/orchestration/access/conversation-access.ts',
]);

function isOwnerlessModel(value: string): value is OwnerlessModel {
  return Object.hasOwn(OWNERLESS_MODELS, value);
}

function isHelperModule(value: string): value is HelperModule {
  return value === 'execution-access' || value === 'conversation-access';
}

function isJsDoc(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** Does the raw text mention any model at all? A file that does not cannot read one. */
export function mentionsModel(source: string): boolean {
  return ANY_MENTION.test(source);
}

/**
 * The names a helper module exports **as values** — functions and constants,
 * not types — read off the helper's own source rather than listed here.
 *
 * This is what decides whether an import counts as coverage. `import {
 * ExecutionOwner } from '…/execution-access'` is legal without the `type`
 * keyword under `isolatedModules`, is used only in annotations, and reaches
 * nothing at runtime; counting it would let the exact bug this check exists
 * for pass on the strength of an interface. Deriving the set from the helper
 * means a new helper function is covered the day it is exported, and a new
 * exported type never is.
 */
export function valueExportsOf(source: string): Set<string> {
  const sf = ts.createSourceFile('helper.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const isExported = (node: ts.Node): boolean =>
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt)) {
      names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && isExported(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name && isExported(stmt)) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

/** The helper modules' value exports, keyed by module, read from disk once. */
export type HelperValueExports = Readonly<Record<HelperModule, ReadonlySet<string>>>;

let helperExportsFromDisk: HelperValueExports | null = null;

function defaultHelperExports(): HelperValueExports {
  if (helperExportsFromDisk === null) {
    const read = (m: HelperModule): ReadonlySet<string> =>
      valueExportsOf(readFileSync(`lib/orchestration/access/${m}.ts`, 'utf8'));
    helperExportsFromDisk = {
      'execution-access': read('execution-access'),
      'conversation-access': read('conversation-access'),
    };
  }
  return helperExportsFromDisk;
}

/** What one source file reads, and how it is covered. */
export interface SourceAnalysis {
  /** The models the file reads, by any shape the parser can see. */
  models: Set<OwnerlessModel>;
  /** The helper modules the file value-imports. */
  helperModules: Set<HelperModule>;
  /** Value bindings imported from a helper that nothing in the file references. */
  unusedImports: string[];
}

function tablesIn(text: string, into: Set<OwnerlessModel>): void {
  for (const m of text.matchAll(RAW_TABLE)) {
    const model = TABLE_TO_MODEL[m[1].toLowerCase()];
    if (model) into.add(model);
  }
}

function isStringish(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * Read a file's shape off the AST. Parses once. `helperExports` defaults to
 * the real helpers' value exports read from disk; a test passes its own.
 */
export function analyzeSource(
  path: string,
  source: string,
  helperExports: HelperValueExports = defaultHelperExports()
): SourceAnalysis {
  const models = new Set<OwnerlessModel>();
  const helperModules = new Set<HelperModule>();
  const bindings: string[] = [];
  /** Namespace bindings, so `access.executionVisibilityWhere` can be checked against the export list. */
  const namespaces = new Map<string, HelperModule>();
  const uses = new Map<string, number>();
  const namespaceValueUses = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (isJsDoc(node)) return;

    if (ts.isImportDeclaration(node)) {
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      const helper = HELPER_SPECIFIER.exec(spec)?.[1];
      // Nothing inside an import declaration is a use, and nothing inside a
      // non-helper import matters here.
      if (!helper || !isHelperModule(helper)) return;
      const clause = node.importClause;
      if (!clause || clause.isTypeOnly || !clause.namedBindings) return;
      const exported = helperExports[helper];
      if (ts.isNamespaceImport(clause.namedBindings)) {
        // Counts once a value export is reached through it — see the
        // PropertyAccess branch below.
        namespaces.set(clause.namedBindings.name.text, helper);
        bindings.push(clause.namedBindings.name.text);
        return;
      }
      const valueBindings: string[] = [];
      for (const el of clause.namedBindings.elements) {
        // `el.propertyName` is the exported name when aliased (`a as b`);
        // `el.name` otherwise. Only a VALUE export can be the road a query
        // took — an interface imported without the `type` keyword is legal
        // and reaches nothing.
        const exportedName = (el.propertyName ?? el.name).text;
        if (!el.isTypeOnly && exported.has(exportedName)) valueBindings.push(el.name.text);
      }
      if (valueBindings.length > 0) {
        helperModules.add(helper);
        bindings.push(...valueBindings);
      }
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      if (isOwnerlessModel(node.name.text)) models.add(node.name.text);
      if (ts.isIdentifier(node.expression)) {
        const ns = namespaces.get(node.expression.text);
        if (ns !== undefined && helperExports[ns].has(node.name.text)) {
          helperModules.add(ns);
          namespaceValueUses.add(node.expression.text);
        }
      }
    } else if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (isStringish(arg) && isOwnerlessModel(arg.text)) models.add(arg.text);
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      ts.isVariableDeclaration(node.parent.parent)
    ) {
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) && isOwnerlessModel(key.text)) models.add(key.text);
    } else if (isStringish(node)) {
      tablesIn(node.text, models);
    } else if (ts.isTemplateExpression(node)) {
      // Substitutions become `?`, so `FROM ${schema}.ai_conversation` still
      // reads as keyword, qualifier, table.
      tablesIn(
        node.head.text + node.templateSpans.map((s) => `?${s.literal.text}`).join(''),
        models
      );
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRaw =
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'raw') ||
        (ts.isIdentifier(callee) && callee.text === 'raw');
      const arg = node.arguments[0];
      if (isRaw && arg !== undefined && isStringish(arg)) {
        const model = TABLE_TO_MODEL[arg.text.toLowerCase()];
        if (model) models.add(model);
      }
    } else if (ts.isIdentifier(node)) {
      // A property NAME is not a use of a same-named binding (`foo.scope` is
      // not a use of an imported `scope`); the receiver identifier is. Nor is
      // an identifier in a type position — a value binding read only as a type
      // (`typeof scope`) reached nothing at runtime.
      const p = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(p) && p.name === node;
      const isTypePosition =
        ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isQualifiedName(p);
      if (!isPropertyName && !isTypePosition) uses.set(node.text, (uses.get(node.text) ?? 0) + 1);
    }

    ts.forEachChild(node, visit);
  };
  visit(parse(path, source));

  return {
    models,
    helperModules,
    unusedImports: bindings.filter((b) =>
      namespaces.has(b) ? !namespaceValueUses.has(b) : (uses.get(b) ?? 0) === 0
    ),
  };
}

/**
 * Identifiers spelled like a model, in expression position, in a file where
 * that model was not detected as read — the oracle the detector does not
 * control.
 *
 * An over-approximation on purpose. It keys on the identifier, not on the
 * shapes {@link analyzeSource} knows, so a shape the detector has never met
 * lands here rather than passing quietly. A local variable that happens to be
 * called `aiMessage` and did not come from a client lands here too, and that
 * is a rename worth making rather than a rule worth adding. Positions that are
 * names rather than expressions — an object key, a type member, an import or
 * export specifier, a JSX attribute — are not mentions of a value and are
 * left out.
 */
export function unexplainedMentions(path: string, source: string): string[] {
  const { models } = analyzeSource(path, source);
  const sf = parse(path, source);
  const found: string[] = [];
  const report = (node: ts.Node, text: string, model: OwnerlessModel): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    found.push(
      `${path}:${line + 1} — \`${text}\` appears in code but no read of ${model} was detected in this file. Either the detector is missing a shape, or a local is named like a model.`
    );
  };
  const TABLE_TOKEN = /\b(ai_workflow_execution|ai_conversation|ai_message)\b/g;

  const isNamePosition = (id: ts.Identifier): boolean => {
    const p = id.parent;
    return (
      (ts.isPropertyAssignment(p) && p.name === id) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isEnumMember(p) ||
      ts.isImportSpecifier(p) ||
      ts.isExportSpecifier(p) ||
      ts.isTypeReferenceNode(p) ||
      ts.isQualifiedName(p) ||
      ts.isJsxAttribute(p) ||
      ts.isTypeAliasDeclaration(p) ||
      ts.isInterfaceDeclaration(p) ||
      ts.isTypeParameterDeclaration(p)
    );
  };

  const visit = (node: ts.Node): void => {
    if (isJsDoc(node)) return;
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && isOwnerlessModel(node.text) && !models.has(node.text)) {
      if (!isNamePosition(node)) report(node, node.text, node.text);
    }
    // A table name in any string or template piece, when no read of that
    // model was detected: `Prisma.raw('"ai_message"')`, a table held in a
    // constant and interpolated later, a quoting the SQL regex did not expect.
    // An audit `entityType: 'ai_conversation'` in a file that also reads the
    // model is filtered by `models.has`; one in a file that does not is worth
    // the glance.
    if (
      isStringish(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const m of node.text.matchAll(TABLE_TOKEN)) {
        const model = TABLE_TO_MODEL[m[1].toLowerCase()];
        if (model && !models.has(model)) report(node, m[1], model);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Every file that reads one of the three models outside its access helper and
 * is not declared as an exception — plus every exception that has rotted.
 *
 * Pure: `files` is the roster of source paths to consider and `read` returns a
 * file's text (or `null` to skip it), so a test can hand it synthetic files and
 * prove it goes red. Files that do not mention a model anywhere are not
 * parsed. Reports a setup fault as a violation: run over zero files it could
 * not have found anything.
 */
export function findUndeclaredOwnerlessReads(
  files: readonly string[],
  read: (path: string) => string | null,
  exceptions: readonly OwnerlessSurfaceException[] = OWNERLESS_SURFACE_EXCEPTIONS
): OwnerlessSurfaceViolation[] {
  if (files.length === 0) {
    return [
      {
        path: '(roster)',
        message:
          'findUndeclaredOwnerlessReads was handed no files, so it could not have found a read. The glob that builds the roster matched nothing.',
      },
    ];
  }

  const violations = validateExceptions(exceptions);
  const byPath = new Map(exceptions.map((e) => [e.path, e]));
  const seenPaths = new Set<string>();

  for (const path of files) {
    if (SKIPPED_FILES.has(path)) continue;
    const source = read(path);
    if (source === null) continue;
    seenPaths.add(path);

    const exception = byPath.get(path);
    const analysis = mentionsModel(source)
      ? analyzeSource(path, source)
      : {
          models: new Set<OwnerlessModel>(),
          helperModules: new Set<HelperModule>(),
          unusedImports: [],
        };

    if (analysis.models.size === 0) {
      if (exception) {
        violations.push({
          path,
          message: `Declared as an ownerless-surface exception but no longer reads AiWorkflowExecution, AiConversation or AiMessage. Delete the entry.`,
        });
      }
      continue;
    }

    for (const name of analysis.unusedImports) {
      violations.push({
        path,
        message: `Imports \`${name}\` from the access helper and never uses it. A bare import satisfies nothing — the query has to go through the helper, not sit beside it.`,
      });
    }

    const uncovered = [...analysis.models].filter(
      (model) => !analysis.helperModules.has(OWNERLESS_MODELS[model])
    );

    if (uncovered.length === 0) {
      if (exception) {
        violations.push({
          path,
          message: `Declared as an ownerless-surface exception (${exception.disposition}) but now imports the access helper for everything it reads. The entry is stale — delete it${exception.tracking ? `, and close ${exception.tracking} if this was the fix` : ''}.`,
        });
      }
      continue;
    }

    if (!exception) {
      const helpers = [...new Set(uncovered.map((m) => OWNERLESS_MODELS[m]))].join(', ');
      violations.push({
        path,
        message:
          `Reads ${uncovered.join(', ')} without a value import from \`@/lib/orchestration/access/${helpers}\`. ` +
          `Rows nobody owns will match nobody here, and the authorization policy is never asked. ` +
          `Go through the helper, or — if this file genuinely has no caller to scope to — declare it in ` +
          `OWNERLESS_SURFACE_EXCEPTIONS (core) or appOwnerlessSurfaceExceptions in lib/app/ci.ts (a fork), with the reason.`,
      });
    }
  }

  for (const entry of exceptions) {
    if (!seenPaths.has(entry.path)) {
      violations.push({
        path: entry.path,
        message: `Declared as an ownerless-surface exception but no such source file was scanned. Deleted or moved? Update or remove the entry.`,
      });
    }
  }

  return violations;
}
