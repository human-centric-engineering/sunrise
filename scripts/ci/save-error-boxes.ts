/**
 * Hand-drawn save-error boxes (§124 t-950).
 *
 * A failed save is shown one way: `<SaveError>`, beside the Save that was
 * pressed, brought into view and focused (`.context/ui/form-errors.md`). About
 * 80 components once drew a red box of their own instead, wherever their
 * author put it, and nothing stopped the next one. This finds the next one.
 *
 * **A library, not a CLI**: `check-save-error-boxes.ts` walks the tree and
 * hands file contents over.
 *
 * It uses the TypeScript parser, as `shared-settings-writes.ts` does and for
 * the same reason: a list of source shapes written by hand misses ordinary
 * code. A class-name grep is useless here: 92 components that submit use red
 * or destructive classes, for field messages, delete buttons and load panels.
 *
 * ## What it reports
 *
 * A component's **save-error state** rendered inside a **red box** it draws.
 *
 * - **Save-error state**: a `useState` value whose setter is called with
 *   something other than `null`, `undefined`, `''` or `false`
 *   - inside the `catch` of a `try` that sends a **mutation**, or
 *   - inside a `.catch(…)` on a promise chain that sends one, or
 *   - inside an `onError` callback passed to a mutation (better-auth's
 *     `authClient.signIn.email(body, { onError })`), or
 *   - inside an `if` whose condition reads a mutation's result
 *     (`const { error } = await authClient.changePassword(...)`: better-auth
 *     answers a refusal rather than throwing it).
 * - **Mutation**: `apiClient.post|patch|put|delete(...)`, a `fetch(url, init)`
 *   whose `init` has a `method` that is not the literal `'GET'`, or a call on
 *   `authClient` other than `getSession`.
 * - **Red box**: a JSX element whose `className` names a red or destructive
 *   colour (`bg-destructive/10`, `text-destructive`, `border-red-300`,
 *   `text-red-700`), showing the state as text inside it (`{error}`,
 *   `{error.message}`, `{error || '…'}`). A value derived from the state
 *   (`const displayError = error || oauthMessage`) counts as the state.
 *
 * A load error is not reported: its `try` reads (`apiClient.get`, a bare
 * `fetch(url)`). Nor is `<SaveError failure={…}>` or `<FormError message={…}>`:
 * the shared components draw the box, and their caller draws nothing.
 *
 * ## What it cannot see, said plainly
 *
 * State kept in a reducer or an object (`setState({ status: 'error' })` read as
 * `state.message`) counts only when the object itself is set in the catch and
 * read in the box. A setter passed to a helper that calls it is not followed. A
 * box drawn by another component the page passes the message to is that
 * component's, and is reported there only if it submits. A mutation through
 * any client but these three is not one. It raises the floor; it is not a
 * proof.
 */

import ts from 'typescript';

export interface SaveErrorBox {
  path: string;
  /** 1-based line of the red element. */
  line: number;
  /** The state the box renders. */
  state: string;
}

/**
 * `{/* save-error-box-ignore: <why> *\/}` on the line above a box excuses it,
 * for a fork's own component: a fork never edits {@link BOX_EXEMPTIONS}, a core
 * file. The reason is required; the marker with nothing after it does not count.
 */
const IGNORE_DIRECTIVE = /save-error-box-ignore:[ \t]*[^\s*]/;

const RED = /(?:^|[\s:'"`])(?:[a-z-]+:)*(?:bg|text|border)-(?:destructive|red-\d{2,3})\b/;

const MUTATING_API = new Set(['post', 'patch', 'put', 'delete']);

/** Whether a value set into the state clears it rather than reporting. */
function isClearing(arg: ts.Expression | undefined): boolean {
  if (!arg) return true;
  if (arg.kind === ts.SyntaxKind.NullKeyword || arg.kind === ts.SyntaxKind.FalseKeyword) {
    return true;
  }
  if (ts.isIdentifier(arg) && arg.text === 'undefined') return true;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text === '';
  return false;
}

/** `a.b.c(...)`'s callee as `['a', 'b', 'c']`, or null when it isn't a plain chain. */
function calleeChain(expr: ts.Expression): string[] | null {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr)) {
    const left = calleeChain(expr.expression);
    return left ? [...left, expr.name.text] : null;
  }
  return null;
}

/** Whether a call sends a mutation. */
export function isMutationCall(call: ts.CallExpression): boolean {
  const chain = calleeChain(call.expression);
  if (!chain) return false;
  if (chain[0] === 'apiClient' && chain.length === 2) return MUTATING_API.has(chain[1]);
  if (chain[0] === 'authClient' && chain.length >= 2) return chain[1] !== 'getSession';
  if (chain.length === 1 && chain[0] === 'fetch') {
    const init = call.arguments[1];
    if (!init || !ts.isObjectLiteralExpression(init)) return false;
    const method = init.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method'
    );
    if (!method) return false;
    const value = method.initializer;
    return !(ts.isStringLiteral(value) && value.text.toUpperCase() === 'GET');
  }
  return false;
}

/** Whether a node contains a mutation call, not looking into nested functions. */
function sendsMutation(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && isMutationCall(n)) {
      found = true;
      return;
    }
    // A callback defined in the try but not run by it (an onSuccess handler's
    // own fetch) is still part of what the try sends: keep looking inside.
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The setter names called with a reporting value anywhere under `node`. */
function settersReporting(node: ts.Node, setters: Map<string, string>, into: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const state = setters.get(n.expression.text);
      if (state && !isClearing(n.arguments[0])) into.add(state);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/**
 * Each function that binds a mutation's awaited result, with the names bound:
 * `const { error } = await authClient.x()`, `const res = await fetch(url, { method })`.
 * Kept per function, so a load elsewhere in the file reading its own `res` is
 * not taken for the mutation's.
 */
function mutationResults(root: ts.Node): Map<ts.Node, Set<string>> {
  const byFunction = new Map<ts.Node, Set<string>>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      let init: ts.Expression = n.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && isMutationCall(init)) {
        let fn: ts.Node = n;
        while (fn.parent && !ts.isFunctionLike(fn)) fn = fn.parent;
        const names = byFunction.get(fn) ?? new Set<string>();
        const bind = (name: ts.BindingName): void => {
          if (ts.isIdentifier(name)) names.add(name.text);
          else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bind(el.name);
        };
        bind(n.name);
        byFunction.set(fn, names);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return byFunction;
}

/** Ifs directly in `fn` (not in a function nested inside it). */
function ownIfs(fn: ts.Node): ts.IfStatement[] {
  const ifs: ts.IfStatement[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isIfStatement(n)) ifs.push(n);
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return ifs;
}

/** Whether an identifier is a name being declared or accessed, not a read of a binding. */
function isNameOnly(id: ts.Identifier): boolean {
  const parent = id.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === id) ||
    (ts.isPropertyAssignment(parent) && parent.name === id) ||
    ts.isJsxAttribute(parent)
  );
}

/** Whether `node` reads any of `names` as a binding. */
function mentions(node: ts.Node, names: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && names.has(n.text) && !isNameOnly(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The string pieces of a `className` value: a literal, a template, or `cn(...)`'s literals. */
function classText(attr: ts.JsxAttribute): string {
  const init = attr.initializer;
  if (!init) return '';
  if (ts.isStringLiteral(init)) return init.text;
  const parts: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) parts.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(init);
  return parts.join(' ');
}

function isRedElement(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  return attrs.properties.some(
    (p) =>
      ts.isJsxAttribute(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === 'className' &&
      RED.test(classText(p))
  );
}

/** Reports every red box rendering a save-error state in one file. */
export function scanSaveErrorBoxes(source: string, path: string): SaveErrorBox[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // setter name → state name, from `const [x, setX] = useState(...)`.
  const setters = new Map<string, string>();
  const visitState = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isArrayBindingPattern(n.name) &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      calleeChain(n.initializer.expression)?.at(-1) === 'useState'
    ) {
      const [value, setter] = n.name.elements;
      if (
        value &&
        setter &&
        ts.isBindingElement(value) &&
        ts.isBindingElement(setter) &&
        ts.isIdentifier(value.name) &&
        ts.isIdentifier(setter.name)
      ) {
        setters.set(setter.name.text, value.name.text);
      }
    }
    ts.forEachChild(n, visitState);
  };
  visitState(file);
  if (setters.size === 0) return [];

  const saveStates = new Set<string>();
  for (const [fn, names] of mutationResults(file)) {
    for (const branch of ownIfs(fn)) {
      if (mentions(branch.expression, names)) {
        settersReporting(branch.thenStatement, setters, saveStates);
      }
    }
  }
  const visitCatch = (n: ts.Node): void => {
    if (ts.isTryStatement(n) && n.catchClause && sendsMutation(n.tryBlock)) {
      settersReporting(n.catchClause.block, setters, saveStates);
    }
    // `apiClient.delete(url).then(…).catch((err) => setError(…))`
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'catch' &&
      sendsMutation(n.expression.expression)
    ) {
      for (const arg of n.arguments) settersReporting(arg, setters, saveStates);
    }
    if (ts.isCallExpression(n) && isMutationCall(n)) {
      for (const arg of n.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue;
        for (const prop of arg.properties) {
          const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
          if (name === 'onError') settersReporting(prop, setters, saveStates);
        }
      }
    }
    ts.forEachChild(n, visitCatch);
  };
  visitCatch(file);
  if (saveStates.size === 0) return [];

  // A value derived from one is one too: `const displayError = error || oauthMessage`.
  // To a fixpoint, so an alias of an alias counts.
  for (let grew = true; grew;) {
    grew = false;
    const visitAlias = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        !saveStates.has(n.name.text) &&
        n.initializer &&
        !ts.isFunctionLike(n.initializer) &&
        mentions(n.initializer, saveStates)
      ) {
        saveStates.add(n.name.text);
        grew = true;
      }
      ts.forEachChild(n, visitAlias);
    };
    visitAlias(file);
  }

  const boxes: SaveErrorBox[] = [];
  const lines = source.split('\n');
  const reported = new Set<ts.Node>();
  const visitJsx = (n: ts.Node): void => {
    const state = ts.isJsxExpression(n) ? shownState(n, saveStates) : null;
    if (state) {
      const box = redAncestor(n);
      if (box && !reported.has(box)) {
        reported.add(box);
        const line = file.getLineAndCharacterOfPosition(box.getStart(file)).line + 1;
        if (!IGNORE_DIRECTIVE.test(lines[line - 2] ?? '')) boxes.push({ path, line, state });
      }
    }
    ts.forEachChild(n, visitJsx);
  };
  visitJsx(file);
  return boxes;
}

/**
 * The save-error state a JSX child shows as text: `{error}`, `{error.message}`,
 * `{error || 'Could not save'}`. A flag that only picks what renders
 * (`{isPending ? … : …}`) shows nothing of its own, and an attribute
 * (`<SaveError failure={…}>`) is the shared component's to draw.
 */
function shownState(expr: ts.JsxExpression, states: Set<string>): string | null {
  if (!expr.expression || ts.isJsxAttribute(expr.parent)) return null;
  let e: ts.Expression = expr.expression;
  while (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    e = e.left;
  }
  while (ts.isPropertyAccessExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return ts.isIdentifier(e) && states.has(e.text) ? e.text : null;
}

/** The nearest red element around `node`, within the component that renders it. */
function redAncestor(node: ts.Node): ts.JsxElement | ts.JsxSelfClosingElement | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n)) return null;
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && isRedElement(n)) return n;
  }
  return null;
}

const RUN =
  'a run, test or generation, not a save: it changes nothing the person is editing, so §124 ' +
  'leaves its result display alone (form-errors.md, "Not converted, by rule").';
const ORG_SWITCH =
  'an org switch, not a save: it moves the admin between orgs, so §124 leaves it alone ' +
  '(t-960 ruling).';
const EXPORT = 'an export, not a save: it downloads data and changes nothing.';
const FIELDS =
  'field messages, each under its own field, as form-errors.md asks; the summary goes ' +
  'through SaveError.';

/**
 * Save-error states that may render in a box of their own, keyed
 * `path#state`, each with the reason. An entry that no longer matches a box is
 * reported, so the list cannot outlive what it excuses.
 */
export const BOX_EXEMPTIONS: Readonly<Record<string, string>> = {
  'components/admin/shared-settings-access.tsx#error': ORG_SWITCH,
  'components/admin/support-banner.tsx#error': ORG_SWITCH,
  'components/admin/orgs/enter-support-button.tsx#error': ORG_SWITCH,
  'components/admin/orchestration/agents-table.tsx#listError':
    EXPORT + ' The state also holds the list load error; the row actions report through SaveError.',
  'components/admin/orchestration/settings/backup-panel.tsx#error': EXPORT,
  'components/admin/orchestration/evaluation-runner.tsx#rescoreError': RUN,
  'components/admin/orchestration/evaluation-runner.tsx#chatError': RUN,
  'components/admin/orchestration/evaluation-runner.tsx#completionError':
    'the evaluation runner is out of §124 by the feature’s own reconciliation (a run panel). ' +
    'Its Complete error already sits directly above the Complete button, so the failure §124 ' +
    'fixes (an error off-screen from the button pressed) does not occur.',
  'components/admin/orchestration/execution-detail-view.tsx#actionResult':
    RUN +
    ' Only the supervisor re-review sets an error here; cancel, retry and approve report ' +
    'through SaveError.',
  'components/admin/orchestration/model-test-button.tsx#result': RUN,
  'components/admin/orchestration/webhook-test-button.tsx#result': RUN,
  'components/admin/orchestration/rerun-execution-dialog.tsx#error': RUN,
  'components/admin/orchestration/workflow-builder/execution-input-dialog.tsx#error': RUN,
  'components/admin/orchestration/workflow-builder/execution-panel.tsx#errorMessage': RUN,
  'components/admin/orchestration/chat/chat-interface.tsx#error':
    'a chat message that failed to send: the chat shows it in the conversation, where the reply ' +
    'would have been.',
  'components/admin/orchestration/evaluations-foundations/generate-cases-button.tsx#error': RUN,
  'components/admin/orchestration/evaluations-foundations/generate-from-description-form.tsx#error':
    RUN,
  'components/admin/orchestration/experiments/experiments-list.tsx#error':
    RUN + ' It starts an experiment; the state also holds the list load error.',
  'components/admin/orchestration/experiments/pairwise-verdict-card.tsx#error': RUN,
  'components/admin/orchestration/knowledge/editable-section.tsx#error':
    RUN + ' Refine asks an agent for a proposed change, reviewed before anything is saved.',
  'components/admin/orchestration/knowledge/explore-tab.tsx#searchError': RUN,
  'components/admin/orchestration/knowledge/document-tags-modal.tsx#createFieldErrors': FIELDS,
  'components/admin/orchestration/knowledge/knowledge-tags-table.tsx#errs': FIELDS,
  'components/admin/orchestration/provider-test-button.tsx#display': RUN,
  'components/admin/orchestration/providers-list.tsx#r': RUN + ' A provider’s connection test.',
  'components/admin/orchestration/setup-wizard.tsx#result': RUN + ' A provider’s connection test.',
};

export interface BoxReport {
  /** Boxes no exemption covers. */
  boxes: SaveErrorBox[];
  /** Exemption keys that matched no box: what they excused has gone. */
  staleExemptions: string[];
}

/** Applies the exemptions to every box found in a tree. */
export function applyExemptions(
  found: SaveErrorBox[],
  exemptions: Readonly<Record<string, string>> = BOX_EXEMPTIONS
): BoxReport {
  const used = new Set<string>();
  const boxes = found.filter((box) => {
    const key = `${box.path}#${box.state}`;
    if (!(key in exemptions)) return true;
    used.add(key);
    return false;
  });
  return { boxes, staleExemptions: Object.keys(exemptions).filter((key) => !used.has(key)) };
}

export function formatBox(box: SaveErrorBox): string {
  return `${box.path}:${box.line}  renders \`${box.state}\` in a red box of its own`;
}
