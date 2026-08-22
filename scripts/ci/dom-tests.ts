/**
 * Which failing tests are failing only because they have no DOM — the pure half.
 *
 * `vitest.config.ts` runs on `node`, and a file that needs browser APIs opts in
 * with an environment docblock on line 1 (see
 * `.context/testing/environments.md`). Sunrise's own files carry theirs. A
 * fork's do not: a merge brings directives for upstream files and nothing for
 * the fork's own, so on the first run after merging, every fork-authored
 * component test fails with `ReferenceError: document is not defined`.
 *
 * Measured across the five forks on this machine when the default changed:
 * 1233 fork-authored test files, ~350 of them needing a directive. That is too
 * many to annotate by hand and exactly the wrong thing to guess at.
 *
 * WHY THIS DECIDES BY RUNNING, NOT BY PATTERN. Sunrise's own migration used a
 * static classifier over test sources and it was wrong in both directions: it
 * over-declared 69 files (matching the English words "knowledge **document**"
 * and "context **window**") and missed one entirely — `console-provider.test.ts`,
 * whose DOM need lives in the *source under test*, behind a `typeof` guard, so
 * nothing in the test file hinted at it. A code review caught that one; no
 * regex would have.
 *
 * Failing to run is the exact signal, and it is free: the test already told us.
 *
 * THE ASYMMETRY IS WHY OVER-DECLARING MATTERS. A DOM test on node fails loudly.
 * A node test that picks up happy-dom **passes**, and quietly goes back to
 * reading the client half of `lib/env.ts`'s schema — the thing the default
 * changed to escape. So {@link classify} only ever proposes a directive for a
 * file that **already failed**, and the CLI keeps it only if adding it turned
 * that file green. A directive this tool cannot justify is reverted.
 *
 * @see scripts/ci/mark-dom-tests.ts — the CLI that runs vitest and applies this
 * @see .context/testing/environments.md — the fork merge recipe
 */

/** The directive this tool writes. Assembled so this file does not carry one. */
export const DIRECTIVE = `// @vitest-${'environment'} happy-dom`;

/** Any environment directive at all, whatever its value. */
const ANY_DIRECTIVE = new RegExp(`@(?:vitest|jest)-${'environment'}\\s+([\\w-]+)\\b`);

/**
 * Globals happy-dom provides that a bare node process does not.
 *
 * Filtered against the running process rather than trusted as written — see
 * {@link domGlobalsMissingHere}. A name Node has since adopted stops counting
 * as a DOM signal on its own, with nothing to remember to delete. `navigator`,
 * `fetch`, `Response`, `Event` and `CustomEvent` are deliberately absent from
 * this list: Node 24 has them all, so a `ReferenceError` naming one is a real
 * fault, not a missing environment.
 */
const BROWSER_GLOBALS = [
  'document',
  'window',
  'localStorage',
  'sessionStorage',
  'history',
  'location',
  'screen',
  'matchMedia',
  'getComputedStyle',
  'getSelection',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'scrollTo',
  'alert',
  'confirm',
  'prompt',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLFormElement',
  'HTMLCanvasElement',
  'SVGElement',
  'Node',
  'DocumentFragment',
  'ShadowRoot',
  'DOMParser',
  'XMLSerializer',
  'XMLHttpRequest',
  'MutationObserver',
  'IntersectionObserver',
  'ResizeObserver',
  'CSSStyleDeclaration',
  'Range',
  'Selection',
  'Image',
  'Audio',
  'DataTransfer',
  'MouseEvent',
  'KeyboardEvent',
  'PointerEvent',
  'TouchEvent',
  'ClipboardEvent',
] as const;

/**
 * The subset of {@link BROWSER_GLOBALS} genuinely absent from this process.
 *
 * Injectable so the test can pin a set rather than depend on whichever Node
 * runs it — a list that changes under the test is a test that changes meaning.
 */
export function domGlobalsMissingHere(
  has: (name: string) => boolean = (name) => name in globalThis
): Set<string> {
  return new Set(BROWSER_GLOBALS.filter((name) => !has(name)));
}

/**
 * Names a failure message reports as undefined.
 *
 * Two shapes, both measured against vitest 4.1.10's JSON reporter:
 *
 *   - a failure inside a test — `ReferenceError: document is not defined`
 *   - a failure while importing the file — bare `document is not defined`,
 *     with no `ReferenceError:` prefix and an empty `assertionResults`
 *
 * The prefix is therefore optional, which is the whole reason this is a
 * function with a test rather than an inline regex.
 */
export function undefinedNames(message: string): string[] {
  const names: string[] = [];
  const pattern = /(?:ReferenceError:\s*)?\b([A-Za-z_$][\w$]*) is not defined\b/g;
  let match = pattern.exec(message);
  while (match !== null) {
    names.push(match[1]);
    match = pattern.exec(message);
  }
  return names;
}

/** One failing test file as the JSON reporter describes it. */
export interface FailedFile {
  /** Repo-relative path. */
  path: string;
  /** Every failure string the reporter produced for this file. */
  messages: readonly string[];
  /** The file's current source, so an existing directive can be honoured. */
  source: string;
}

/** What should happen to each failing file. */
export interface Classification {
  /** Failed on a missing browser global and carries no directive — add one. */
  candidates: Array<{ path: string; missing: string[] }>;
  /** Asks for an environment already and still fails. Not this tool's problem. */
  alreadyDeclared: Array<{ path: string; environment: string }>;
  /** Failed for some other reason. Left alone. */
  unrelated: string[];
}

/**
 * Sorts failing files into the three groups.
 *
 * A file reaches `candidates` only by having failed on a global that happy-dom
 * supplies and this process lacks. Everything else is somebody else's bug, and
 * saying so is the point — a migration tool that quietly widened its remit to
 * "make the suite green" would be the worst possible version of this.
 */
export function classify(
  files: readonly FailedFile[],
  missingGlobals: Set<string>
): Classification {
  const result: Classification = { candidates: [], alreadyDeclared: [], unrelated: [] };

  for (const file of files) {
    const missing = [
      ...new Set(
        file.messages
          .flatMap((message) => undefinedNames(message))
          .filter((name) => missingGlobals.has(name))
      ),
    ].sort();

    if (missing.length === 0) {
      result.unrelated.push(file.path);
      continue;
    }
    const declared = ANY_DIRECTIVE.exec(file.source);
    if (declared !== null) {
      result.alreadyDeclared.push({ path: file.path, environment: declared[1] });
      continue;
    }
    result.candidates.push({ path: file.path, missing });
  }

  return result;
}

/** Adds the directive to line 1. Returns `null` if the file already has one. */
export function withDirective(source: string): string | null {
  if (ANY_DIRECTIVE.test(source)) return null;
  return `${DIRECTIVE}\n\n${source}`;
}

/** Removes a directive this tool added, for a candidate the re-run did not fix. */
export function withoutDirective(source: string): string {
  return source.startsWith(`${DIRECTIVE}\n\n`) ? source.slice(`${DIRECTIVE}\n\n`.length) : source;
}

/** The collaborators {@link selfTestFailure} exercises, injectable for its own test. */
export interface SelfTestDeps {
  names: typeof undefinedNames;
  sort: typeof classify;
  add: typeof withDirective;
  remove: typeof withoutDirective;
  missing: typeof domGlobalsMissingHere;
}

/**
 * Proves this module still reports before any caller trusts a clean answer.
 *
 * The failure it guards against is the one every scanner in this repo has had:
 * a matcher that stops matching returns "nothing to do", which is
 * indistinguishable from "nothing was wrong". Here that would mean a fork
 * merging the change, running this, being told there is nothing to fix, and
 * annotating 350 files by hand.
 *
 * `deps` exists so the sentinel's own rejection paths can be driven with broken
 * collaborators. A sentinel whose failure branches have never executed is the
 * thing it was written to prevent.
 */
export function selfTestFailure(deps: Partial<SelfTestDeps> = {}): string | null {
  const {
    names = undefinedNames,
    sort = classify,
    add = withDirective,
    remove = withoutDirective,
    missing = domGlobalsMissingHere,
  } = deps;

  if (names('ReferenceError: document is not defined').join() !== 'document') {
    return 'undefinedNames no longer reads the in-test failure shape.';
  }
  if (names('window is not defined').join() !== 'window') {
    return 'undefinedNames no longer reads the import-time shape (no ReferenceError prefix).';
  }
  if (names('everything is fine').length !== 0) {
    return 'undefinedNames matched a message that reports nothing undefined.';
  }

  const verdict = sort(
    [
      { path: 'a.test.ts', messages: ['ReferenceError: document is not defined'], source: 'x' },
      { path: 'b.test.ts', messages: ['expected 1 to be 2'], source: 'x' },
      {
        path: 'c.test.ts',
        messages: ['ReferenceError: document is not defined'],
        source: DIRECTIVE + '\nx',
      },
    ],
    new Set(['document'])
  );
  if (verdict.candidates.length !== 1 || verdict.candidates[0].path !== 'a.test.ts') {
    return `classify proposed ${JSON.stringify(verdict.candidates)}; expected only a.test.ts.`;
  }
  if (verdict.unrelated.join() !== 'b.test.ts') {
    return 'classify no longer separates a failure unrelated to the environment.';
  }
  if (verdict.alreadyDeclared.length !== 1) {
    return 'classify would add a second directive to a file that already has one.';
  }

  if (add('const a = 1;\n') !== DIRECTIVE + '\n\nconst a = 1;\n') {
    return 'withDirective no longer puts the directive on line 1.';
  }
  if (add(DIRECTIVE + '\nx') !== null) {
    return 'withDirective would overwrite an existing directive.';
  }
  if (remove(DIRECTIVE + '\n\nx') !== 'x') {
    return 'withoutDirective cannot undo what withDirective wrote.';
  }

  // The runtime filter must actually filter: Node has these, so they are not
  // DOM signals and a ReferenceError naming one is a real fault.
  const live = missing();
  for (const present of ['fetch', 'Response', 'navigator']) {
    if (live.has(present)) return `${present} is treated as a missing DOM global, but Node has it.`;
  }
  if (!live.has('document')) {
    return 'document is not treated as a missing DOM global, so nothing would ever be proposed.';
  }

  return null;
}
