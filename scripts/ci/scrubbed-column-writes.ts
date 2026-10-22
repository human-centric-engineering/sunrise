/**
 * Which files write a column erasure scrubs in place — found by the parser
 * (§122 t-887).
 *
 * The rule, the manifest and the reasons live in `lib/privacy/stale-writers.ts`;
 * read that first. This module is the mechanics: given a source file, which of
 * the models in `SCRUBBED_COLUMNS` does it write a scrubbed column of? **A library,
 * not a CLI**: the always-run test `tests/unit/lib/privacy/stale-writers.test.ts`
 * runs it over the tree.
 *
 * It uses the TypeScript parser, as `ownerless-surfaces.ts` and
 * `shared-settings-writes.ts` beside it do, for the reason the first gives: a
 * list of source shapes written by hand misses ordinary code.
 *
 * ## What counts as a write
 *
 * - A call to a Prisma write method (`create`, `update`, `upsert` and their
 *   `Many` / `AndReturn` forms) on a property or element access named for a
 *   scrubbed model, on any receiver: `prisma.aiWorkflow.update`,
 *   `tx?.aiWorkflowSchedule.create`, `db['aiWorkflowVersion'].upsert` — **when
 *   it can write a scrubbed column**. The columns are read off the `data` (or
 *   an upsert's `create` and `update`) object literal. A write whose columns
 *   cannot be read — `data: patch`, a spread, a computed key — counts: the
 *   unknown direction is the one that asks for a declaration.
 * - A nested write through a relation field whose type is a scrubbed model —
 *   `aiWorkflow.create({ data: { versions: { create: … } } })` — inside the
 *   payload (`data`, an upsert's `create` / `update`) of a Prisma write call
 *   on any model. A relation under `include`, `select` or `where` is a read. The relations are read off the schema per
 *   parent model, so `AiAgent.versions` is not mistaken for
 *   `AiWorkflow.versions`. Counted whatever its columns: the shapes below a
 *   relation are too many to follow.
 * - SQL text — any string or template piece — that runs `UPDATE` (or
 *   `UPDATE ONLY`), `INSERT INTO` or `MERGE INTO` on a scrubbed table, in any
 *   case, tolerating a schema qualifier and whitespace across lines. And SQL
 *   that writes to a substitution (`UPDATE ${t}`, `INSERT INTO ${table}`),
 *   when the file also holds a scrubbed table's name as a string on its own:
 *   `Prisma.raw('ai_…')`, a const, an argument, a union type. Every table it
 *   names that way counts, since which one the substitution holds cannot be
 *   seen.
 * - A **reference to a scrubbed model's delegate** that is not the receiver of
 *   a method call: `const d = tx.aiWorkflowExecution`, `const { aiWorkflow } =
 *   prisma`, `run(prisma.aiWorkflowSchedule)`. What it is used for cannot be
 *   seen, so it is reported as `unresolved` rather than passing.
 *
 * Deletes are not writes here: a deleted row cannot put a person back.
 *
 * ## What it still cannot see, said plainly
 *
 * A **dynamic** model name (`prisma[name]`) and a model reached through a
 * generic helper's type parameter are not detected. A nested write is read
 * only when its object literal sits in the call; one built elsewhere and
 * passed in as `data` counts as an unknown write on the call's own model, not
 * on the related one. Column-level reading applies to Prisma calls only; any
 * SQL write to a scrubbed table counts. It raises the floor; it is not a proof.
 */

import ts from 'typescript';
import type { ScrubbedModel } from '@/lib/privacy/stale-writers';

/** A source file, by repo-relative path. */
export interface SourceFile {
  path: string;
  source: string;
}

/** What a file was found to do to one model. */
export interface ScrubbedWrite {
  file: string;
  model: string;
  /**
   * How it was found. `unresolved` means a delegate reference the scan cannot
   * follow — it may not write at all, but the scan cannot tell.
   */
  via: 'prisma' | 'nested' | 'sql' | 'unresolved';
}

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
]);

/** Nested-write operations under a relation field. `connect` and `disconnect` write no column. */
const NESTED_WRITE_OPS = new Set([
  'create',
  'createMany',
  'connectOrCreate',
  'update',
  'updateMany',
  'upsert',
  'set',
]);

/** `AiWorkflowExecution` → `aiWorkflowExecution`, the client accessor. */
export function accessorOf(model: string): string {
  return model[0].toLowerCase() + model.slice(1);
}

/** Every model's relation fields: model → field name → the model it points at. */
export type RelationMap = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * Every relation field of every model, read off the schema source:
 * `versions AiWorkflowVersion[] @relation(…)` inside `model AiWorkflow` →
 * `AiWorkflow.versions → AiWorkflowVersion`. Keyed by the parent model,
 * because a field name means nothing on its own: `AiAgent.versions` is a
 * different table from `AiWorkflow.versions`.
 */
export function relationsOf(schemaSources: readonly string[]): RelationMap {
  const fields: Array<{ parent: string; field: string; type: string }> = [];
  const models = new Set<string>();
  for (const source of schemaSources) {
    let parent: string | null = null;
    for (const line of source.split('\n')) {
      const open = /^model\s+(\w+)\s*\{/.exec(line);
      if (open) {
        parent = open[1];
        models.add(parent);
        continue;
      }
      if (/^\}/.test(line)) {
        parent = null;
        continue;
      }
      const m = parent ? /^\s+(\w+)\s+(\w+)(\[\])?\??(\s|$)/.exec(line) : null;
      if (parent && m) fields.push({ parent, field: m[1], type: m[2] });
    }
  }
  const out = new Map<string, Map<string, string>>();
  for (const { parent, field, type } of fields) {
    if (!models.has(type)) continue;
    const held = out.get(parent) ?? new Map<string, string>();
    held.set(field, type);
    out.set(parent, held);
  }
  return out;
}

/** The name an access expression reaches: `a.b` → `b`, `a?.['b']` → `b`. */
function accessedName(node: ts.Expression): string | null {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text;
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression)) {
    return inner.argumentExpression.text;
  }
  return null;
}

function propertyKey(p: ts.ObjectLiteralElementLike): string | null {
  if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) return null;
  const name = p.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

/** The value of `key` in an object literal, when it is written as a plain property. */
function property(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (propertyKey(p) !== key) continue;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
  }
  return undefined;
}

function unwrap(node: ts.Expression): ts.Expression {
  let inner = node;
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isSatisfiesExpression(inner) ||
    ts.isNonNullExpression(inner)
  ) {
    inner = inner.expression;
  }
  return inner;
}

/**
 * Whether `ref` is handed straight to a write, so reading it changes nothing:
 * the argument of `x.updateMany(ref)`, or the value of `data: ref` (or an
 * upsert's `create:` / `update:`).
 */
function isBareWriteUse(ref: ts.Identifier): boolean {
  const parent = ref.parent;
  if (ts.isCallExpression(parent) && parent.arguments.includes(ref)) {
    const method = accessedName(parent.expression);
    return method !== null && WRITE_METHODS.has(method);
  }
  const isPayload = (p: ts.ObjectLiteralElementLike): boolean =>
    ['data', 'create', 'update'].includes(propertyKey(p) ?? '');
  // `data: ref`, or the shorthand `{ where, data }`.
  return (
    (ts.isPropertyAssignment(parent) && parent.initializer === ref && isPayload(parent)) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === ref && isPayload(parent))
  );
}

/**
 * A local `const` an identifier names, when its initialiser is in the same
 * file and nothing can have changed it: `const claim = { where, data }` …
 * `updateMany(claim)`. Found by walking out through the enclosing blocks, so
 * the nearest declaration wins as it does at runtime.
 *
 * Followed only when **every** reference to the name in that block is a bare
 * write use ({@link isBareWriteUse}). A `const` object is still mutable —
 * `updateData.escalationConfig = …` after `const updateData = {}` is how the
 * settings route builds its write — so a literal with any other use says
 * nothing about what is written, and stays unresolved. Anything else (a
 * parameter, a `let`, an import) stays unresolved too.
 */
function resolveConst(id: ts.Identifier): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const)
      ) {
        continue;
      }
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== id.text || !decl.initializer) {
          continue;
        }
        let onlyBare = true;
        const check = (node: ts.Node): void => {
          if (
            ts.isIdentifier(node) &&
            node !== decl.name &&
            node.text === id.text &&
            !isBareWriteUse(node)
          ) {
            onlyBare = false;
          }
          if (onlyBare) ts.forEachChild(node, check);
        };
        check(scope);
        return onlyBare ? decl.initializer : undefined;
      }
    }
  }
  return undefined;
}

/** An expression with wrappers removed and a local `const` followed to its value, once. */
function valueOf(node: ts.Expression): ts.Expression {
  const inner = unwrap(node);
  if (!ts.isIdentifier(inner)) return inner;
  const init = resolveConst(inner);
  return init ? unwrap(init) : inner;
}

/**
 * The object literals a spread can contribute: `...{ a }`, and both arms of
 * `...(c ? { a } : {})` or `...(c && { a })`. Null when one of them is not a
 * literal.
 */
function spreadLiterals(node: ts.Expression): ts.ObjectLiteralExpression[] | null {
  const value = valueOf(node);
  if (ts.isObjectLiteralExpression(value)) return [value];
  if (ts.isConditionalExpression(value)) {
    const a = spreadLiterals(value.whenTrue);
    const b = spreadLiterals(value.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  if (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return spreadLiterals(value.right);
  }
  return null;
}

/** The keys an object literal names, through spreads, or `'unknown'`. */
function keysOf(obj: ts.ObjectLiteralExpression): Set<string> | 'unknown' {
  const out = new Set<string>();
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const parts = spreadLiterals(p.expression);
      if (parts === null) return 'unknown';
      for (const part of parts) {
        const keys = keysOf(part);
        if (keys === 'unknown') return 'unknown';
        keys.forEach((k) => out.add(k));
      }
      continue;
    }
    const key = propertyKey(p);
    if (key === null) return 'unknown';
    out.add(key);
  }
  return out;
}

/**
 * The columns a `data` value names, or `'unknown'` when they cannot be read:
 * a parameter, a call, a spread of one, a computed key. An array
 * (`createMany`) is the union of its elements.
 */
function columnsOf(data: ts.Expression | undefined): Set<string> | 'unknown' {
  if (data === undefined) return new Set();
  const value = valueOf(data);
  if (ts.isArrayLiteralExpression(value)) {
    const out = new Set<string>();
    for (const el of value.elements) {
      const cols = columnsOf(el);
      if (cols === 'unknown') return 'unknown';
      cols.forEach((c) => out.add(c));
    }
    return out;
  }
  return ts.isObjectLiteralExpression(value) ? keysOf(value) : 'unknown';
}

/** The `data` values a write call carries: `data`, or an upsert's `create` and `update`. */
function dataOf(method: string, arg: ts.Expression | undefined): ts.Expression[] | 'unknown' {
  if (arg === undefined) return 'unknown';
  const value = valueOf(arg);
  if (!ts.isObjectLiteralExpression(value)) return 'unknown';
  const keys = method === 'upsert' ? ['create', 'update'] : ['data'];
  const found: ts.Expression[] = [];
  for (const k of keys) {
    const v = property(value, k);
    if (v !== undefined) found.push(v);
  }
  // A spread could carry `data` itself: unless every spread is a literal
  // without one, the call's columns are unknown.
  for (const p of value.properties) {
    if (!ts.isSpreadAssignment(p)) continue;
    const parts = spreadLiterals(p.expression);
    if (parts === null) return 'unknown';
    for (const part of parts) {
      for (const k of keys) {
        const v = property(part, k);
        if (v !== undefined) found.push(v);
      }
    }
  }
  return found;
}

function writesScrubbedColumn(
  method: string,
  arg: ts.Expression | undefined,
  columns: readonly string[]
): boolean {
  const datas = dataOf(method, arg);
  if (datas === 'unknown') return true;
  return datas.some((d) => {
    const cols = columnsOf(d);
    return cols === 'unknown' || columns.some((c) => cols.has(c));
  });
}

/**
 * Every scrubbed model `node` writes through a relation field, read as the
 * fields of `parent`: `{ versions: { create: … } }` under `AiWorkflow` writes
 * `AiWorkflowVersion`. Below a relation the walk continues as the related
 * model, so a write two relations deep is still seen.
 */
function nestedWrites(
  node: ts.Node,
  parent: string,
  relations: RelationMap,
  scrubbed: ReadonlySet<string>,
  into: Set<string>
): void {
  const fields = relations.get(parent);
  if (fields && ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      const key = propertyKey(p);
      const target = key === null ? undefined : fields.get(key);
      if (target && ts.isPropertyAssignment(p)) {
        const value = unwrap(p.initializer);
        const writes =
          !ts.isObjectLiteralExpression(value) ||
          value.properties.some((op) => {
            const opKey = propertyKey(op);
            return opKey === null || NESTED_WRITE_OPS.has(opKey);
          });
        if (writes && scrubbed.has(target)) into.add(target);
        nestedWrites(value, target, relations, scrubbed, into);
      } else {
        ts.forEachChild(p, (child) => nestedWrites(child, parent, relations, scrubbed, into));
      }
    }
    return;
  }
  ts.forEachChild(node, (child) => nestedWrites(child, parent, relations, scrubbed, into));
}

function isJsDoc(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

function isTextPiece(
  node: ts.Node
): node is
  | ts.StringLiteral
  | ts.NoSubstitutionTemplateLiteral
  | ts.TemplateHead
  | ts.TemplateMiddle
  | ts.TemplateTail {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/** A string sitting in a type position — `Pick<Client, 'aiWorkflow'>` — names no runtime value. */
function inTypePosition(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p) || ts.isExpressionStatement(p)) return false;
  }
  return false;
}

/** A scanner bound to one set of scrubbed models. */
export interface Scanner {
  /** What `file` writes. A file that names no scrubbed model, table or reaching relation is skipped unparsed. */
  scan: (file: SourceFile) => ScrubbedWrite[];
}

/** The scanner for one set of scrubbed models and their relation fields. */
export function createScanner(scrubbed: readonly ScrubbedModel[], relations: RelationMap): Scanner {
  const byAccessor = new Map(scrubbed.map((m) => [accessorOf(m.model), m]));
  const scrubbedNames = new Set(scrubbed.map((m) => m.model));
  /** Every model with a relation, by accessor, so a nested write under any of them is read. */
  const parentByAccessor = new Map([...relations.keys()].map((m) => [accessorOf(m), m]));
  /** Field names that reach a scrubbed model from somewhere: the pre-filter's third population. */
  const reachingFields = new Set(
    [...relations.values()].flatMap((fields) =>
      [...fields].filter(([, target]) => scrubbedNames.has(target)).map(([field]) => field)
    )
  );
  const byTable = new Map(scrubbed.map((m) => [m.table, m]));
  const tables = scrubbed.map((m) => m.table).join('|');
  const sqlWrite = new RegExp(
    String.raw`\b(?:UPDATE(?:\s+ONLY)?|INSERT\s+INTO|MERGE\s+INTO)\s+(?:["\w]+\.)?"?(${tables})\b`,
    'gi'
  );
  /** A write keyword with its target in the next substitution: `UPDATE ${t} …`. */
  const sqlWriteToSubstitution =
    /\b(?:UPDATE(?:\s+ONLY)?|INSERT\s+INTO|MERGE\s+INTO)\s+(?:["\w]+\.)?"?$/i;
  /**
   * The cheap pre-filter. A delegate or table name, in any case: Postgres
   * folds an unquoted `UPDATE AI_WORKFLOW`, so a case-sensitive gate would skip
   * a file the case-insensitive SQL detector would have caught. A relation
   * field name is common English (`workflow`, `version`), so it lets a file
   * through only beside a Prisma write method.
   */
  const named = new RegExp([...byAccessor.keys(), ...byTable.keys()].join('|'), 'i');
  const reaching = new RegExp(String.raw`\b(?:${[...reachingFields].join('|')})\b`);
  const writeMethod = new RegExp(String.raw`\.(?:${[...WRITE_METHODS].join('|')})\(`);

  function scan(file: SourceFile): ScrubbedWrite[] {
    const { source } = file;
    if (!named.test(source) && !(reaching.test(source) && writeMethod.test(source))) return [];
    const sf = ts.createSourceFile(
      file.path,
      file.source,
      ts.ScriptTarget.Latest,
      true,
      file.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const found = new Map<string, ScrubbedWrite['via']>();
    const record = (model: string, via: ScrubbedWrite['via']): void => {
      // A definite write outranks an unresolved reference to the same model.
      if (!found.has(model) || found.get(model) === 'unresolved') found.set(model, via);
    };
    /**
     * Tables named on their own in a string — `Prisma.raw('ai_workflow')`,
     * `const T = '"ai_workflow"'`, a `'ai_webhook_delivery'` argument — and
     * whether any SQL writes to a substitution. Together they are a write: the
     * file can be seen to write to a table it holds in a value, though not to
     * which one, so every table it names counts.
     */
    const namedTables = new Set<string>();
    let writesToSubstitution = false;

    const visit = (node: ts.Node): void => {
      if (isJsDoc(node)) return;

      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const method = accessedName(callee);
        const receiver =
          ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? callee.expression
            : null;
        if (method && receiver) {
          const accessor = accessedName(receiver);
          const model = accessor ? byAccessor.get(accessor) : undefined;
          if (
            model &&
            WRITE_METHODS.has(method) &&
            writesScrubbedColumn(method, node.arguments[0], model.columns)
          ) {
            record(model.model, 'prisma');
          }
          // Only the payload: a relation under `include`, `select` or `where`
          // is read, not written.
          const parent = accessor ? parentByAccessor.get(accessor) : undefined;
          const datas =
            parent && WRITE_METHODS.has(method) ? dataOf(method, node.arguments[0]) : [];
          if (parent && datas !== 'unknown') {
            const nested = new Set<string>();
            for (const data of datas) {
              nestedWrites(valueOf(data), parent, relations, scrubbedNames, nested);
            }
            nested.forEach((m) => record(m, 'nested'));
          }
        }
      }

      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        // A delegate that is the receiver of a call was judged with the call.
        const accessor = accessedName(node);
        const model = accessor ? byAccessor.get(accessor) : undefined;
        if (model && !isCalleeReceiver(node)) record(model.model, 'unresolved');
      } else if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        ts.isVariableDeclaration(node.parent.parent)
      ) {
        const key = node.propertyName ?? node.name;
        const model = ts.isIdentifier(key) ? byAccessor.get(key.text) : undefined;
        if (model) record(model.model, 'unresolved');
      }

      if (ts.isStringLiteralLike(node)) {
        // Type positions too: `table: 'ai_webhook_delivery' | …` names it as surely.
        const model = byTable.get(node.text.trim().replace(/^"|"$/g, '').toLowerCase());
        if (model) namedTables.add(model.model);
      }

      if (isTextPiece(node) && !inTypePosition(node)) {
        for (const m of node.text.matchAll(sqlWrite)) {
          const model = byTable.get(m[1].toLowerCase());
          if (model) record(model.model, 'sql');
        }
        if (
          (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) &&
          sqlWriteToSubstitution.test(node.text)
        ) {
          writesToSubstitution = true;
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);

    if (writesToSubstitution) namedTables.forEach((m) => record(m, 'sql'));
    return [...found].map(([model, via]) => ({ file: file.path, model, via }));
  }

  return { scan };
}

/** `x.model.method(…)` — the access is the receiver of a call's callee. */
function isCalleeReceiver(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const viaParen = ts.isParenthesizedExpression(parent) ? parent.parent : parent;
  const access = ts.isParenthesizedExpression(parent) ? parent : node;
  return (
    !!viaParen &&
    (ts.isPropertyAccessExpression(viaParen) || ts.isElementAccessExpression(viaParen)) &&
    viaParen.expression === access &&
    !!viaParen.parent &&
    ts.isCallExpression(viaParen.parent) &&
    viaParen.parent.expression === viaParen
  );
}
