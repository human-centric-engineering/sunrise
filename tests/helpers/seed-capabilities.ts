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
   */
  definedNames: string[];
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

/** Every `*.ts` under `dir`, recursively, as paths relative to `SEED_DIR`. */
function seedFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...seedFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

export function scanCapabilitySeeds(): SeedScan {
  const upserts: CapabilityUpsert[] = [];
  const unparseable: { file: string; reason: string }[] = [];
  const definedNames: string[] = [];

  for (const file of seedFiles(SEED_DIR)) {
    const raw = readFileSync(join(SEED_DIR, file), 'utf8');
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
        const cm = new RegExp(`const\\s+${spread[1]}\\s*=\\s*\\{`).exec(masked);
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
    const fd = /\bfunctionDefinition\s*:\s*\{/g;
    let f: RegExpExecArray | null;
    while ((f = fd.exec(masked)) !== null) {
      const open = masked.indexOf('{', f.index + f[0].length - 1);
      const close = objectEnd(masked, open);
      if (close === -1) {
        unparseable.push({ file, reason: 'unbalanced functionDefinition' });
        continue;
      }
      // First TOP-LEVEL `name:` — a nested `properties: { name: {...} }` is
      // deeper, and is an object rather than a string in any case.
      let depth = 0;
      for (let i = open + 1; i < close; i++) {
        const ch = masked[i];
        if (ch === '{' || ch === '[' || ch === '(') depth++;
        else if (ch === '}' || ch === ']' || ch === ')') depth--;
        else if (depth === 0 && /^name\s*:/.test(masked.slice(i, i + 12))) {
          const after = i + /^name\s*:/.exec(masked.slice(i, i + 12))![0].length;
          const lit = /^\s*['"]([^'"]+)['"]/.exec(raw.slice(after));
          if (lit) definedNames.push(lit[1]);
          break;
        }
      }
    }
  }

  return { upserts, unparseable, definedNames };
}
