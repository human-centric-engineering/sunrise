/**
 * Public-surface detection by exported symbol, not by path list — pure, no IO.
 *
 * `/pre-pr` step 5d decides "did this touch the public surface?" from a
 * hardcoded list of paths: the named seam files, `lib/auth/guards.ts`,
 * `lib/api/responses.ts`, `lib/logging/*`, `app/api/v1/admin/orchestration/**`,
 * `prisma/schema/`. `lib/security/sanitize.ts` is not on it, so when #506 added
 * `normalizeRootRelativePath` as a new export on `@/lib/security` — surface a
 * fork can import, and that `lib/auth-landing` already depends on — 5d stayed
 * silent. The CHANGELOG entry exists because a human judged it necessary, not
 * because the gate asked (#552).
 *
 * The list asks *"is this file on my list?"*. The question is *"does this change
 * what a fork can import?"* — and that has an answer that needs no list: compare
 * the set of symbols each barrel exports against the base revision. Added,
 * removed or renamed is a public-surface change by definition, including from
 * seams nobody has thought of yet.
 *
 * # Why the compiler and not a regex
 *
 * Of the 164 export statements across this repo's 24 `lib/**\/index.ts` barrels,
 * three are `export * from './x'`. A regex sees the line and cannot say what it
 * re-exports, so a barrel would read as unchanged while the surface underneath
 * it moved — the precise failure mode this file exists to remove. The
 * TypeScript compiler is already a dependency; it resolves the star and returns
 * the actual symbol set.
 *
 * @see scripts/ci/check-exports.ts — the CLI that reads the revisions
 */

import ts from 'typescript';

/** What one barrel exposes. */
export interface BarrelExports {
  /** Repo-relative path, e.g. `lib/security/index.ts`. */
  file: string;
  /** Exported symbol names, sorted. Types and values alike — forks import both. */
  symbols: string[];
  /** Specifiers of `export *` statements that could not be followed. */
  unresolvedStars: string[];
}

/** A barrel whose exported set moved. */
export interface ExportChange {
  file: string;
  added: string[];
  removed: string[];
}

/**
 * Reads the exported symbol names of a barrel from source text.
 *
 * `resolveSibling` takes a specifier and the directory to resolve it *from*,
 * and returns the imported module's source together with its own directory —
 * so a nested star resolves relative to the file that wrote it. It returns
 * `null` when the module cannot be read. **Resolving the specifier is
 * the caller's job, and in this repo that means handling `@/`** — CLAUDE.md
 * mandates the alias and ESLint forbids relative paths, so every one of the six
 * stars in `lib/` is an `@/` specifier. A resolver that only understood `./`
 * returned `null` for all of them, which is how this file shipped claiming to
 * follow stars while following none. A star that cannot be followed is
 * reported through {@link BarrelParse.unresolvedStars} rather than silently
 * contributing nothing, because "no symbols" and "could not look" must not
 * arrive as the same answer.
 */
export interface BarrelParse {
  symbols: string[];
  unresolvedStars: string[];
}

function parseSource(text: string): ts.SourceFile {
  return ts.createSourceFile('barrel.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Collects the names a single file exports, following `export *` via `readFile`. */
export function readBarrelExports(
  text: string,
  resolveSibling: (specifier: string, fromDir: string) => { text: string; dir: string } | null,
  fromDir = '',
  depth = 0
): BarrelParse {
  const symbols = new Set<string>();
  const unresolvedStars: string[] = [];
  const source = parseSource(text);

  for (const statement of source.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        // `export { a, b as c }` and `export type { … }`
        for (const element of statement.exportClause.elements) symbols.add(element.name.text);
        continue;
      }
      if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        // `export * as costTracker from '…'` — one importable symbol, the
        // namespace itself. This fell through both branches and was recorded
        // nowhere, so deleting `export * as costTracker` from
        // `lib/orchestration/llm/index.ts` read as no change at all.
        symbols.add(statement.exportClause.name.text);
        continue;
      }
      if (!statement.exportClause) {
        // `export * from './x'` — resolve it, or say we could not.
        const specifier =
          statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
            ? statement.moduleSpecifier.text
            : null;
        // Depth cap: a cycle between two barrels would otherwise not terminate.
        const target = specifier !== null && depth < 8 ? resolveSibling(specifier, fromDir) : null;
        if (target === null) {
          if (specifier !== null) unresolvedStars.push(specifier);
          continue;
        }
        // The resolved file's OWN directory, not the outer barrel's. Reusing
        // the top-level one made `./deep` inside `sub/mod.ts` resolve against
        // `lib/x/` rather than `lib/x/sub/` — a confidently wrong symbol set
        // with no warning, which is worse than the unresolved-star case this
        // module is built around.
        const nested = readBarrelExports(target.text, resolveSibling, target.dir, depth + 1);
        for (const name of nested.symbols) symbols.add(name);
        unresolvedStars.push(...nested.unresolvedStars);
      }
      continue;
    }

    if (!exported) continue;

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) symbols.add(declaration.name.text);
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name)
    ) {
      symbols.add(statement.name.text);
    }
  }

  return { symbols: [...symbols].sort(), unresolvedStars };
}

/** Barrels whose exported symbol set differs between the two revisions. */
export function diffExports(base: BarrelExports[], head: BarrelExports[]): ExportChange[] {
  const baseByFile = new Map(base.map((entry) => [entry.file, entry.symbols]));
  const changes: ExportChange[] = [];

  for (const entry of head) {
    const before = baseByFile.get(entry.file);
    // A brand-new barrel is a new surface in its entirety; an absent one is
    // reported by the removed-file pass below.
    const previous = new Set(before ?? []);
    const current = new Set(entry.symbols);

    const added = entry.symbols.filter((name) => !previous.has(name));
    const removed = [...previous].filter((name) => !current.has(name)).sort();
    if (added.length > 0 || removed.length > 0) changes.push({ file: entry.file, added, removed });
  }

  const headFiles = new Set(head.map((entry) => entry.file));
  for (const entry of base) {
    if (headFiles.has(entry.file)) continue;
    changes.push({ file: entry.file, added: [], removed: entry.symbols });
  }

  return changes.sort((a, b) => a.file.localeCompare(b.file));
}
