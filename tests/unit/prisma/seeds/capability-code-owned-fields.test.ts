/**
 * Invariant: every `AiCapability` seed re-applies its code-owned fields.
 *
 * `functionDefinition`, `executionType` and `executionHandler` describe what
 * the code does — the schema the LLM and every MCP client are shown, and the
 * handler class the dispatcher resolves. They are not admin customisations, so
 * a seed that only writes them on `create` leaves an existing row advertising
 * the original schema forever. That is #545: a downstream fork added a
 * parameter to a capability, every test stayed green, and the MCP schema on
 * dev and prod never showed the new field.
 *
 * The tests it already had could not catch it — they pin the capability class
 * against the seed constant, not the seed constant against the DB write. This
 * one reads the `update` branch itself.
 *
 * **Source-level on purpose.** A behavioural test with a mock prisma would only
 * cover the seeds someone remembered to write a test for, and the failure mode
 * here is the *next* capability seed, written by someone who copied a file that
 * predates the rule. Parsing every seed catches that on the PR that adds it.
 *
 * Operator-owned fields are asserted absent as well, in both directions: a seed
 * that starts re-applying `isActive` would silently re-enable a capability an
 * operator turned off, and one that re-applies `name` would revert their
 * rename on the next deploy. The LLM-facing name and description live inside
 * `functionDefinition`, so nothing the model reads depends on those columns.
 *
 * @see .context/database/seeding.md — the ownership rule
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEED_DIR = join(process.cwd(), 'prisma', 'seeds');

/** Must track the capability class — always re-applied. */
const CODE_OWNED = ['functionDefinition', 'executionType', 'executionHandler'] as const;

/** The operator's to change — a seed must never write these on update. */
const OPERATOR_OWNED = ['isActive', 'rateLimit', 'name', 'description', 'category'] as const;

/** Span of the object literal that starts at `open` (an index of `{`). */
function objectAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced object literal');
}

/** Top-level keys of an object-literal body, ignoring nested objects. */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (depth === 0) {
      const prev = i > 0 ? body[i - 1] : ' ';
      if (/[\w$.]/.test(prev)) continue;
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      if (m) keys.push(m[1]);
    }
  }
  return keys;
}

/**
 * Every `aiCapability.upsert` across the seed directory, as
 * `{ file, update }` where `update` is the branch's top-level key list.
 *
 * A spread (`...FOO_IMPL`) is resolved by looking up that constant in the same
 * file and taking its keys — hoisting the code-owned half into a shared
 * constant is the pattern these seeds use to keep `create` and `update` from
 * drifting apart, and the check has to see through it.
 */
function capabilityUpserts(): { file: string; update: string[] }[] {
  const found: { file: string; update: string[] }[] = [];
  for (const file of readdirSync(SEED_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(SEED_DIR, file), 'utf8');
    const re = /aiCapability\.upsert\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const body = objectAt(src, src.indexOf('{', m.index + m[0].length - 1));
      const um = /\bupdate\s*:\s*\{/.exec(body);
      if (!um) continue;
      const updateBody = objectAt(body, body.indexOf('{', um.index + um[0].length - 1));
      const keys = topLevelKeys(updateBody);
      for (const spread of updateBody.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
        const cm = new RegExp(`const\\s+${spread[1]}\\s*=\\s*\\{`).exec(src);
        if (cm)
          keys.push(...topLevelKeys(objectAt(src, src.indexOf('{', cm.index + cm[0].length - 1))));
      }
      found.push({ file, update: keys });
    }
  }
  return found;
}

describe('AiCapability seeds — code-owned fields are re-applied (#545)', () => {
  const upserts = capabilityUpserts();

  it('finds the capability seeds at all', () => {
    // Guards the parser: a silent zero would make every assertion below vacuous
    // and the suite would stay green while the invariant went unchecked.
    expect(upserts.length).toBeGreaterThanOrEqual(7);
  });

  it.each(CODE_OWNED)('every seed re-applies %s on update', (field) => {
    const missing = upserts.filter((u) => !u.update.includes(field)).map((u) => u.file);
    expect(missing).toEqual([]);
  });

  it.each(OPERATOR_OWNED)('no seed overwrites %s on update', (field) => {
    const clobbering = upserts.filter((u) => u.update.includes(field)).map((u) => u.file);
    expect(clobbering).toEqual([]);
  });
});
