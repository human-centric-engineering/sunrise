/**
 * Hand-rolled `next/navigation` router mocks: rules.
 *
 * WHY THIS EXISTS: `AppRouterInstance` gains required members between Next
 * minors (16.3.0 added `bfcacheId`), and nothing type-checks a `vi.mock`
 * factory. A test that writes the router out by hand therefore keeps compiling
 * while handing the component under test an object the real router is no longer
 * shaped like. `createMockRouter()` (`tests/types/mocks.ts`) exists so there is
 * one place to add the next member; this check is what keeps the suite going
 * through it.
 *
 * Two invariants, both across every `.ts`/`.tsx` under `tests/` (`setup.ts`,
 * `helpers/` and `mocks/` included, not only `*.test.ts`):
 *
 * 1. **No object literal supplying all six router methods.** Six members means
 *    the author meant "a complete router", which is the factory's job. A
 *    minimal stub of two or three members, for a component that reads nothing
 *    else, is deliberately fine and is not flagged.
 * 2. **No cast that switches the type check off.** `useRouter as unknown as X`
 *    is strictly worse than an uncast literal, which at least fails loudly when
 *    the interface grows.
 *
 * ## Why this parses instead of pattern-matching
 *
 * The previous implementation was a regex-and-brace-matching scanner embedded
 * in `.claude/commands/pre-pr.md`, and in a fork it reported CLEAN on a suite
 * holding 16 complete literals and 17 casts (#936). Every one of its blind spots
 * came from not having a parser:
 *
 * - It collected members with `/([A-Za-z_$][\w$]*)\s*:/`, so a **shorthand**
 *   member (`refresh,`, no colon) was never counted. Ten files wrote `refresh`
 *   that way and five wrote `push`; all sixteen read as five-of-six and passed.
 * - It **anchored** on `prefetch\s*:` to find a literal at all, so a literal
 *   whose `prefetch` was shorthand would not even have been located.
 * - Its cast rule was a `grep` for the literal string
 *   `as unknown as ReturnType<typeof useRouter>`. Every real offender there
 *   wrote `as unknown as ReturnType<typeof vi.fn>` instead, which defeats the
 *   type check just as thoroughly.
 * - It needed a comment filter, because a JSDoc line mentioning the cast
 *   matched it.
 *
 * An AST has no such classes of bug. Shorthand is a node kind rather than a
 * spelling; `properties` is direct members only, so a nested literal cannot
 * contribute keys; comments are not nodes; and strings, template literals and
 * regex literals are single tokens, so code quoted inside them is not code.
 *
 * That last property is load-bearing for this module's own test, which holds
 * every violating shape as a template literal: the checker walking `tests/`
 * parses those as one `NoSubstitutionTemplateLiteral` and finds nothing. The
 * test needs no exemption, and a checker that has to exempt itself is the same
 * shape as the bug being fixed.
 *
 * Takes source *text*, not a path, so the rules stay testable without touching
 * the repo's real files.
 */

import ts from 'typescript';

/** The six members of `AppRouterInstance` a hand-rolled literal always writes. */
const ROUTER_METHODS = ['push', 'replace', 'refresh', 'back', 'forward', 'prefetch'] as const;

/** The factory every mock router is supposed to come from. */
const FACTORY = 'createMockRouter';

export type RouterMockRule = 'cast' | 'literal';

export interface RouterMockViolation {
  /** The path as given to {@link scanRouterMocks}, echoed for the report. */
  file: string;
  /** 1-based, as an editor counts. */
  line: number;
  column: number;
  rule: RouterMockRule;
  message: string;
}

export interface ScanOptions {
  /**
   * Suppresses the `literal` rule only.
   *
   * For `tests/types/mocks.ts`, which necessarily writes the complete router
   * out: it is the factory. The `cast` rule still applies there, deliberately:
   * a real cast added by a fork extending the factory is exactly what needs
   * catching, and the JSDoc mentioning one is a comment, so it is not a node.
   */
  allowCompleteLiteral?: boolean;
}

/**
 * The opt-out for a genuine false positive, written on the line above the
 * flagged code (or above the statement holding it). The reason is required:
 * `// router-mocks-ignore:` with nothing after it does not count, so every
 * exemption in the suite says why it is one.
 */
// `[ \t]*`, not `\s*`: the reason must be on the directive's own line, so a
// block comment's line break cannot carry it onto the closing `*/`, which is
// stripped before testing so it cannot stand in for one either.
const IGNORE_DIRECTIVE = /router-mocks-ignore:[ \t]*\S/;

function isIgnored(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.text;
  const lineOf = (position: number): number =>
    sourceFile.getLineAndCharacterOfPosition(position).line;
  // Only a directive ending on the line directly above the flagged node counts.
  // Ancestors are walked only to find it when it is attached to the enclosing
  // statement (`// ...` then `it.each([{ ... }])` on the next line); one above
  // a multi-line `vi.mock` factory does not reach a literal further down it.
  const targetLine = lineOf(node.getStart(sourceFile)) - 1;
  for (
    let current: ts.Node | undefined = node;
    current !== undefined && !ts.isSourceFile(current);
    current = current.parent
  ) {
    const ranges = ts.getLeadingCommentRanges(text, current.getFullStart()) ?? [];
    const directive = ranges.some(
      (range) =>
        lineOf(range.end) === targetLine &&
        IGNORE_DIRECTIVE.test(text.slice(range.pos, range.end).replace(/\*\/$/, ''))
    );
    if (directive) return true;
    if (ts.isStatement(current)) break;
  }
  return false;
}

/**
 * Whether the file is about the *pages* router (`next/router`) and not the App
 * Router at all. Its router mock has the same six method names, but it is a
 * different type that `createMockRouter()` does not build, so neither rule
 * applies to it. `next/router` is read from plain string nodes only, so a
 * module name quoted in a template-literal fixture cannot switch the scan off.
 */
function mocksOnlyPagesRouter(sourceFile: ts.SourceFile): boolean {
  let pages = false;
  let navigation = false;
  const visit = (node: ts.Node): void => {
    // Asymmetric on purpose. Only a plain string counts as evidence for the
    // skip, but a template literal counts against it: `vi.mock(\`next/navigation\`)`
    // is still the App Router, and erring here means scanning, not a silent pass.
    if (ts.isStringLiteral(node) && node.text === 'next/router') pages = true;
    if (ts.isStringLiteralLike(node) && node.text === 'next/navigation') navigation = true;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return pages && !navigation;
}

/**
 * `.tsx` must parse as TSX.
 *
 * Read as `ScriptKind.TS`, a JSX tag is a type assertion and the tree from
 * there on is nonsense, silently, with no error surfaced. Fifteen of the
 * sixteen files this check was written to catch (#936) are `.tsx`, so getting
 * this wrong would have reproduced the CLEAN it replaces.
 */
function scriptKindFor(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** The declared name of one object-literal member, or `null` if it has none. */
function memberName(member: ts.ObjectLiteralElementLike): string | null {
  // The entire bug the previous scanner had. Shorthand is not a spelling of a
  // key here; it is a distinct node with the same `name`.
  if (ts.isShorthandPropertyAssignment(member)) return member.name.text;

  // A spread contributes no *declared* names. It can only add members, so it
  // never invalidates the superset test below and needs no bail-out.
  if (ts.isSpreadAssignment(member)) return null;

  const name = 'name' in member ? member.name : undefined;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  // `{ ['push']: … }` is the same member written the long way round.
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

/**
 * Whether this literal spreads the factory's result (`...createMockRouter()`).
 *
 * Only a direct spread counts. The factory's name appearing somewhere deeper,
 * say as one member's value (`prefetch: createMockRouter().prefetch`), still
 * leaves the other five written by hand.
 */
function usesFactory(literal: ts.ObjectLiteralExpression): boolean {
  return literal.properties.some(
    (member) => ts.isSpreadAssignment(member) && isFactoryCall(member.expression)
  );
}

/** `createMockRouter(...)`, or the same through a namespace import (`mocks.createMockRouter(...)`). */
function isFactoryCall(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === FACTORY;
  return ts.isPropertyAccessExpression(callee) && callee.name.text === FACTORY;
}

/**
 * Whether this literal is the overrides argument of a factory call:
 * `createMockRouter({ push, replace, ... })`. Supplying all six spies there is
 * what the CLI's own advice tells a test asserting on all six to do, and the
 * factory still fills in every member Next adds.
 */
function isFactoryArgument(literal: ts.ObjectLiteralExpression): boolean {
  const call = outsideParens(literal).parent;
  return call !== undefined && ts.isCallExpression(call) && isFactoryCall(call);
}

function skipParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function innermostOperand(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** A cast expression, in either syntax. */
type CastExpression = ts.AsExpression | ts.TypeAssertion;

function isCast(node: ts.Node): node is CastExpression {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

/**
 * `X as unknown as T` is two nested casts, and reporting both would double every
 * finding. Only the outermost cast of a chain is considered, and it is judged on
 * every link (see `chainTargetsRouter`), so skipping the inner ones loses nothing.
 * Parentheses are looked through: `(X as unknown) as T` is the same chain.
 */
function isInnerCastOfChain(node: CastExpression): boolean {
  let parent = node.parent;
  while (parent !== undefined && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return (
    parent !== undefined && isCast(parent) && skipParens(parent.expression) === skipParens(node)
  );
}

/** The value a router mock is handed to: `vi.mocked(useRouter).mockReturnValue(HERE)`. */
const RETURN_SETTER = /^(?:mockReturnValue|mockReturnValueOnce)$/;
const IMPLEMENTATION_SETTER = /^(?:mockImplementation|mockImplementationOnce)$/;
const MOCKED_USE_ROUTER =
  /^vi\.mocked\s*(?:<[^>]*>)?\(\s*(?:[\w$]+\.)*useRouter\s*(?:,\s*(?:true|\{[^}]*\})\s*)?\)$/;

/** `vi.mocked(useRouter)` in any spelling, or `vi.spyOn(navigation, 'useRouter')`. */
function isMockedUseRouter(expression: ts.Expression, sourceFile: ts.SourceFile): boolean {
  if (MOCKED_USE_ROUTER.test(expression.getText(sourceFile))) return true;
  if (!ts.isCallExpression(expression)) return false;
  const [, method] = expression.arguments;
  return (
    expression.expression.getText(sourceFile) === 'vi.spyOn' &&
    method !== undefined &&
    ts.isStringLiteralLike(method) &&
    method.text === 'useRouter'
  );
}

/**
 * Climbs from `node` to the outermost expression whose value it can become:
 * through parentheses, either branch of `c ? X : Y`, and either operand of
 * `??`, `||` and `&&`. `x ? ({ push } as never) : createMockRouter()` hands
 * out the cast just as surely as a bare `{ push } as never` does.
 */
function asReturnedValue(node: ts.Node): ts.Node {
  let current = outsideParens(node);
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) return current;
    const isBranch =
      ts.isConditionalExpression(parent) &&
      (parent.whenTrue === current || parent.whenFalse === current);
    const isOperand =
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(parent.operatorToken.kind);
    if (!isBranch && !isOperand) return current;
    current = outsideParens(parent);
  }
}

function outsideParens(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== undefined && ts.isParenthesizedExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}

/**
 * Whether `node` is the router a mocked `useRouter` hands out: the argument of
 * `.mockReturnValue(...)`, or what an implementation passed to
 * `.mockImplementation(...)` returns (`() => X`, or any `return X` in its body),
 * including as one branch of a conditional or a `??`/`||`/`&&` operand.
 */
function isReturnedFromMockedUseRouter(node: ts.Expression, sourceFile: ts.SourceFile): boolean {
  let current = asReturnedValue(node);
  let setter = RETURN_SETTER;

  const parent = current.parent;
  if (parent !== undefined && ts.isArrowFunction(parent) && parent.body === current) {
    current = outsideParens(parent);
    setter = IMPLEMENTATION_SETTER;
  } else if (parent !== undefined && ts.isReturnStatement(parent)) {
    // The nearest enclosing function, however deep the `return` sits in it:
    // `() => { if (x) { return X; } ... }` returns X as surely as a top-level
    // `return` does.
    let fn: ts.Node | undefined = parent.parent;
    while (fn !== undefined && !ts.isFunctionLike(fn)) fn = fn.parent;
    if (fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
    current = outsideParens(fn);
    setter = IMPLEMENTATION_SETTER;
  }

  const call = current.parent;
  if (call === undefined || !ts.isCallExpression(call)) return false;
  if (!call.arguments.some((argument) => argument === current)) return false;
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    setter.test(callee.name.text) &&
    isMockedUseRouter(callee.expression, sourceFile)
  );
}

/**
 * Whether any link of the cast chain rooted at `node` targets the router, or
 * the chain as a whole is the router value handed to a mocked `useRouter`
 * (`vi.mocked(useRouter).mockReturnValue({ push } as never)`).
 */
function chainTargetsRouter(node: CastExpression, sourceFile: ts.SourceFile): boolean {
  if (isFactoryCall(innermostOperand(node.expression))) return false;
  if (isReturnedFromMockedUseRouter(node, sourceFile)) return true;
  let current: ts.Expression = node;
  while (isCast(current)) {
    if (castTargetsRouter(current, sourceFile)) return true;
    current = skipParens(current.expression);
  }
  return false;
}

/**
 * Does this cast target the router?
 *
 * Two independent triggers, because the offenders in this repo trip only the
 * first and the documented invariant names only the second:
 *
 * - the thing being cast **is** `useRouter` (or `navigation.useRouter`), no
 *   matter what it is cast to. This is what catches
 *   `useRouter as unknown as ReturnType<typeof vi.fn>`;
 * - the target type names the router, no matter what is being cast. This is
 *   what catches `{} as unknown as ReturnType<typeof useRouter>`.
 *
 * Scoping to `useRouter` rather than banning `as unknown as ReturnType<typeof
 * vi.fn>` outright is not politeness. Sunrise's suite has over 800 of those
 * casts and none is on the router: they are on `apiClient.post`,
 * `useSearchParams`, `headers`. A rule broad enough to catch a router one flags
 * every one of them.
 */
function castTargetsRouter(node: CastExpression, sourceFile: ts.SourceFile): boolean {
  const operand = innermostOperand(node.expression).getText(sourceFile);
  if (operand === 'useRouter' || operand.endsWith('.useRouter')) return true;

  // Matched as words anywhere in the target, not as one exact spelling, so a
  // namespaced `typeof navigation.useRouter`, an inline
  // `import('next/navigation').AppRouterInstance`, and the repo's own
  // `MockRouter` alias are all caught. A cast to `MockRouter` hides a missing
  // member exactly as a cast to the Next type does.
  const target = node.type.getText(sourceFile);
  return (
    /ReturnType\s*<\s*typeof\s+(?:[\w$]+\.)*useRouter\s*>/.test(target) ||
    /\b(?:AppRouterInstance|MockRouter)\b/.test(target)
  );
}

/**
 * Every hand-rolled router mock in one file.
 *
 * Findings are returned in source order. The parse is a parse only (no
 * program, no type-checker, no `tsconfig` resolution), so this stays fast
 * enough to run over the whole suite on every `npm run validate`.
 */
export function scanRouterMocks(
  source: string,
  file: string,
  options: ScanOptions = {}
): RouterMockViolation[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(file)
  );

  const violations: RouterMockViolation[] = [];
  if (mocksOnlyPagesRouter(sourceFile)) return violations;

  const at = (node: ts.Node): { line: number; column: number } => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: position.line + 1, column: position.character + 1 };
  };

  const visit = (node: ts.Node): void => {
    if (!options.allowCompleteLiteral && ts.isObjectLiteralExpression(node)) {
      const names = new Set(
        node.properties.map(memberName).filter((name): name is string => name !== null)
      );
      if (
        ROUTER_METHODS.every((method) => names.has(method)) &&
        !usesFactory(node) &&
        !isFactoryArgument(node) &&
        !isIgnored(node, sourceFile)
      ) {
        violations.push({
          file,
          ...at(node),
          rule: 'literal',
          message:
            'Object literal supplies all six router methods by hand. ' +
            `Use \`${FACTORY}()\` from '@/tests/types/mocks' so the next member ` +
            'Next adds lands in one place.',
        });
      }
    }

    if (
      isCast(node) &&
      !isInnerCastOfChain(node) &&
      chainTargetsRouter(node, sourceFile) &&
      !isIgnored(node, sourceFile)
    ) {
      violations.push({
        file,
        ...at(node),
        rule: 'cast',
        message:
          'Cast switches off the type check on a router mock. ' +
          `Use \`vi.mocked(useRouter)\` and \`${FACTORY}()\` instead: a cast ` +
          'hides a missing member rather than failing on it.',
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/** `path:line:col  message`, the shape an editor's jump-to-line understands. */
export function formatViolation(violation: RouterMockViolation): string {
  return `${violation.file}:${violation.line}:${violation.column}  [${violation.rule}] ${violation.message}`;
}
