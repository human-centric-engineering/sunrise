/**
 * Static reader for the `AiCapability` upserts in `prisma/seeds/`.
 *
 * Shared by the two seed invariants so they agree on what "every capability
 * seed" means — `capability-code-owned-fields` checks what each upsert writes,
 * `capability-class-seed-parity` checks that every slug found here has a
 * class pinned to it.
 *
 * Three things this deliberately gets right, each of which it got wrong first
 * and a review caught by writing a probe seed and watching the suite stay green:
 *
 *  1. **Recursive.** `prisma/runner.ts` walks subdirectories precisely so a
 *     fork can drop its own seeds in `prisma/seeds/app-foo/`. Reading only the
 *     top level left the seeds most likely to be written by someone copying an
 *     older file — a fork's — entirely unchecked.
 *  2. **Loud on anything it cannot read.** An upsert whose `update:` is a
 *     hoisted const or a helper call does not match the object-literal pattern.
 *     Skipping those silently reported success for call sites nobody had
 *     inspected, so they now surface as `unparseable` for the caller to fail on.
 *  3. **String- and comment-aware.** Capability descriptions contain literal
 *     braces (`` `{ encoding: "base64", data }` ``). Counting those as
 *     structure mis-spans the object and blames the wrong file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CapabilityUpsert {
  /** Path relative to `prisma/seeds`, e.g. `011-call-external-api.ts`. */
  file: string;
  /** Slug from the `where:` clause, when it is a literal. */
  slug: string | null;
  /** Top-level keys the `update` branch writes, with `...CONST` resolved. */
  update: string[];
}

export interface SeedScan {
  upserts: CapabilityUpsert[];
  /** Call sites this reader could not statically interpret. Never ignore. */
  unparseable: { file: string; reason: string }[];
  /**
   * Every capability the seeds define, by `functionDefinition.name`.
   *
   * Not read from the `where:` clause: only four of the eight upserts pass a
   * literal slug there — `005` loops over an array and `010` reads `def.slug`
   * from a const — so deriving coverage from `where` would silently check half
   * the capabilities. `functionDefinition.name` is a literal in all of them,
   * and equals the slug (asserted below), so it is the honest key.
   *
   * A definition held in a same-file const (`functionDefinition: FOO_DEF`, or
   * the shorthand `{ functionDefinition }`) is resolved to that const's
   * literal `name`.
   */
  definedNames: string[];
  /** {@link definedNames}, each with the file it was read from. */
  definitions: { file: string; name: string }[];
  /**
   * `functionDefinition` values this reader cannot name: imported, built at
   * runtime, or read off a class instance (`cap.capability.functionDefinition`).
   * Not `unparseable` — the upsert is fine — but not silently dropped either,
   * which is how a seed built from a hoisted const went unwatched (#646). The
   * parity test requires each file here to be covered.
   */
  opaqueDefinitions: { file: string; expr: string }[];
}

const SEED_DIR = join(process.cwd(), 'prisma', 'seeds');

/** Blank out string literals, template literals and comments, preserving length. */
function maskLiterals(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' ';
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) out[i++] = ' ';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out[i++] = ' ';
      while (i < src.length) {
        if (src[i] === '\\') {
          out[i++] = ' ';
          if (i < src.length) out[i++] = ' ';
          continue;
        }
        if (src[i] === quote) {
          out[i++] = ' ';
          break;
        }
        out[i++] = ' ';
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

/** An identifier as a regex fragment — `$` is legal in one and an anchor in a regex. */
const ident$ = (name: string): string => name.replace(/\$/g, '\\$');

/** End index of the object literal opening at `open`, or -1 if unbalanced. */
function objectEnd(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level keys of an object-literal body, ignoring nested structures. */
function topLevelKeys(masked: string, from: number, to: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = from; i < to; i++) {
    const ch = masked[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (depth === 0) {
      const prev = i > from ? masked[i - 1] : ' ';
      if (/[\w$.]/.test(prev)) continue;
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(masked.slice(i, i + 80));
      if (m) keys.push(m[1]);
    }
  }
  return keys;
}

/** Every `*.ts` under `dir`, recursively, as paths relative to the scan root. */
function seedFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...seedFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

/**
 * Blank `interface X { … }` and `type X = { … }` bodies, so a field typed
 * `functionDefinition: Foo` is not read as a value.
 */
function maskTypeBodies(masked: string): string {
  const out = masked.split('');
  const re = /\b(?:interface\s+[\w$]+[^{=;]*|type\s+[\w$]+(?:<[^>]*>)?\s*=\s*)\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = objectEnd(masked, open);
    if (close === -1) continue;
    for (let i = open + 1; i < close; i++) if (out[i] !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/**
 * Whether the key at `at` sits in an object PATTERN — `const { k } = x`,
 * `({ k }) => …`, `for (const { k } of xs)` — rather than an object literal.
 * Finds the enclosing brace (within a bounded look-back) and reads what
 * surrounds it: a declaration keyword before, or `=`, `) =>`, `of`, `in` or a
 * type annotation after.
 */
function inDestructuringPattern(masked: string, at: number): boolean {
  let depth = 0;
  let open = -1;
  for (let i = at - 1; i >= Math.max(0, at - 2000); i--) {
    const ch = masked[i];
    if (ch === '}' || ch === ']' || ch === ')') depth++;
    else if (ch === '{' || ch === '[' || ch === '(') {
      if (depth === 0) {
        if (ch === '{') open = i;
        break;
      }
      depth--;
    }
  }
  if (open === -1) return false;
  if (/\b(?:const|let|var)\s*$/.test(masked.slice(Math.max(0, open - 16), open))) return true;
  const close = objectEnd(masked, open);
  if (close === -1) return false;
  return /^\s*(?:=(?![=>])|\)\s*(?:=>|\{)|:|of\b|in\b)/.test(masked.slice(close + 1, close + 40));
}

/**
 * The first TOP-LEVEL `name:` string literal of the object opening at `open`.
 * `null` when there is none (or it is not a literal); `undefined` when the
 * object is unbalanced. A nested `properties: { name: {...} }` is deeper, and
 * is an object rather than a string in any case.
 */
function literalName(raw: string, masked: string, open: number): string | null | undefined {
  const close = objectEnd(masked, open);
  if (close === -1) return undefined;
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const ch = masked[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (depth === 0 && /^name\s*:/.test(masked.slice(i, i + 12))) {
      if (i > open + 1 && /[\w$.]/.test(masked[i - 1])) continue;
      const after = i + /^name\s*:/.exec(masked.slice(i, i + 12))![0].length;
      const lit = /^\s*['"]([^'"]+)['"]/.exec(raw.slice(after, after + 200));
      return lit ? lit[1] : null;
    }
  }
  return null;
}

/** @param seedDir Scan root; defaults to `prisma/seeds`. Tests pass a fixture dir. */
export function scanCapabilitySeeds(seedDir: string = SEED_DIR): SeedScan {
  const upserts: CapabilityUpsert[] = [];
  const unparseable: { file: string; reason: string }[] = [];
  const definitions: { file: string; name: string }[] = [];
  const opaqueDefinitions: { file: string; expr: string }[] = [];

  for (const file of seedFiles(seedDir)) {
    const raw = readFileSync(join(seedDir, file), 'utf8');
    const masked = maskLiterals(raw);
    const re = /aiCapability\.upsert\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const argOpen = masked.indexOf('{', m.index + m[0].length - 1);
      const argEnd = objectEnd(masked, argOpen);
      if (argEnd === -1) {
        unparseable.push({ file, reason: 'unbalanced upsert argument' });
        continue;
      }

      const um = /\bupdate\s*:\s*\{/.exec(masked.slice(argOpen, argEnd));
      if (!um) {
        // A hoisted const or a helper call. Refusing to guess is the point:
        // reporting nothing for a call site would pass it silently.
        unparseable.push({ file, reason: 'update branch is not an inline object literal' });
        continue;
      }
      const updOpen = argOpen + um.index + um[0].length - 1;
      const updEnd = objectEnd(masked, updOpen);
      if (updEnd === -1) {
        unparseable.push({ file, reason: 'unbalanced update branch' });
        continue;
      }

      const update = topLevelKeys(masked, updOpen + 1, updEnd);
      for (const spread of masked.slice(updOpen, updEnd).matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
        const cm = new RegExp(`const\\s+${ident$(spread[1])}\\s*=\\s*\\{`).exec(masked);
        if (!cm) {
          unparseable.push({ file, reason: `spread ...${spread[1]} not resolvable in this file` });
          continue;
        }
        const co = masked.indexOf('{', cm.index + cm[0].length - 1);
        const ce = objectEnd(masked, co);
        if (ce === -1) unparseable.push({ file, reason: `unbalanced const ${spread[1]}` });
        else update.push(...topLevelKeys(masked, co + 1, ce));
      }

      // `where: { slug: 'x' }` — located in the masked source, then read from
      // the RAW one, because masking blanks the literal we are after.
      //
      // The match deliberately stops at the colon. Ending it with `\s*` looked
      // right and was not: masking replaces the string with SPACES, so `\s*`
      // ran straight past the literal and every slug came back null — an empty
      // list that made the parity coverage check pass vacuously.
      const whereRel = /\bwhere\s*:\s*\{\s*slug\s*:/.exec(masked.slice(argOpen, argEnd));
      let slug: string | null = null;
      if (whereRel) {
        const at = argOpen + whereRel.index + whereRel[0].length;
        const lit = /^\s*['"]([^'"]+)['"]/.exec(raw.slice(at));
        slug = lit ? lit[1] : null;
      }

      upserts.push({ file, slug, update });
    }

    // Capability names, wherever the definitions live in the file — inside an
    // array the seed loops over, a hoisted const, or the upsert itself.
    const types = maskTypeBodies(masked);
    const fd = /\bfunctionDefinition\b/g;
    let f: RegExpExecArray | null;
    while ((f = fd.exec(types)) !== null) {
      // A short window either side is all the checks below read; slicing the
      // whole prefix per match made a long seed quadratic.
      const before = types.slice(Math.max(0, f.index - 64), f.index);
      const after = types.slice(f.index + f[0].length, f.index + f[0].length + 16);
      // `const functionDefinition = …` and friends declare a binding; they are
      // read when something references it, not here.
      if (/\b(?:const|let|var|readonly|public|private|protected)\s+$/.test(before)) continue;
      // Member access (`def.functionDefinition`) is a read, not a property key.
      if (/\.\s*$/.test(before)) continue;

      const colon = /^\s*:\s*/.exec(after);
      let value: string;
      let at: number;
      if (colon) {
        at = f.index + f[0].length + colon[0].length;
        value = types.slice(at, at + 200);
      } else if (/[{,]\s*$/.test(before) && /^\s*[,}]/.test(after)) {
        // Shorthand `{ functionDefinition }` — the binding of the same name.
        at = f.index;
        value = 'functionDefinition';
      } else {
        continue;
      }

      // A destructuring pattern binds the key; it does not define a capability.
      if (inDestructuringPattern(types, f.index)) continue;
      // `select: { functionDefinition: true }`, `where: { … : Prisma.JsonNull }`:
      // a query flag or filter, not a definition.
      if (/^(?:true|false|null|undefined|Prisma\.(?:JsonNull|DbNull|AnyNull))\b/.test(value)) {
        continue;
      }

      if (value.startsWith('{')) {
        const name = literalName(raw, types, at);
        if (name === undefined) {
          unparseable.push({ file, reason: 'unbalanced functionDefinition' });
          continue;
        }
        if (name !== null) {
          definitions.push({ file, name });
          continue;
        }
        // A literal whose `name` is computed (`name: cap.slug`) — falls through.
      }

      // An identifier: resolve it to a same-file `const x = { … }`.
      // A trailing `as T` / `satisfies T` changes nothing about which const it is.
      // `\s+` before the keyword, or backtracking splits `fooas.def` into `foo`.
      const ident = /^([A-Za-z_$][\w$]*)(?=\s*(?:[,}\n;]|$)|\s+(?:as|satisfies)\b)/.exec(value);
      if (!value.startsWith('{') && ident) {
        const decl = new RegExp(`\\bconst\\s+${ident$(ident[1])}\\s*(?::[^=]+)?=\\s*\\{`, 'g');
        const all = [...types.matchAll(decl)];
        // Two consts of that name are two scopes, and this reader does not
        // track scope: naming either would be a guess, so neither is named.
        const cm = all.length === 1 ? all[0] : undefined;
        if (cm) {
          const name = literalName(raw, types, types.indexOf('{', cm.index + cm[0].length - 1));
          if (name === undefined) {
            unparseable.push({ file, reason: `unbalanced const ${ident[1]}` });
            continue;
          }
          if (name !== null) {
            definitions.push({ file, name });
            continue;
          }
        }
      }

      // Imported, built at runtime, read off a class instance, or a literal
      // with a computed `name`: a definition this reader cannot name. Reported rather than dropped — the caller
      // decides what covers it (#646).
      const expr = value.startsWith('{') ? '{ … }' : /^[^,}\n;]*/.exec(value)![0].trim();
      opaqueDefinitions.push({ file, expr });
    }
  }

  return {
    upserts,
    unparseable,
    definitions,
    definedNames: definitions.map((d) => d.name),
    opaqueDefinitions,
  };
}
