/**
 * Coverage guard: lib/privacy/stale-writers.ts vs every file in the tree
 * (§122 t-887).
 *
 * Erasure scrubs a person out of rows it keeps. Any file that writes one of
 * those columns from an older copy can put them back, and until now each such
 * writer was found only when a review happened to read it. This test parses
 * the tree (`scripts/ci/scrubbed-column-writes.ts`) and holds the manifest
 * level with what it finds, so a new writer cannot land without saying how it
 * knows its copy is stale.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * "not listed": your file writes a column erasure scrubs in place. Add it to
 * `STALE_WRITERS` with the anchor that says how it knows its copy is stale —
 * the header of `lib/privacy/stale-writers.ts` lists them. If it can't say,
 * that is the bug the test is for: an older copy will put an erased person
 * back.
 *
 * "listed but does not write": the file no longer writes that model's scrubbed
 * columns (or moved). Remove or move the entry. **Never** delete an entry for a
 * file that still writes, to make the first test pass.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — you satisfy this from your own code
 * ---------------------------------------------------------------------------
 * Your files are scanned too. Declare yours with `registerStaleWriter()` from
 * `initAppErasureHooks()` in `lib/app/erasure.ts`, or from your framework
 * tier's init. Nothing here needs editing.
 *
 * Whole-tree: declared in `ALWAYS_RUN_TESTS`, because no import chain connects
 * a new writer to this file.
 *
 * @see lib/privacy/stale-writers.ts
 * @see scripts/ci/scrubbed-column-writes.ts
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

// A fork's erasure hooks may import the Prisma client at module scope; this
// file never runs them.
vi.mock('@/lib/db/client', () => ({ prisma: {} }));

const { SCRUBBED_COLUMNS, STALE_WRITERS } = await import('@/lib/privacy/stale-writers');
const { getAppStaleWriters } = await import('@/lib/privacy/erasure-hooks');
const { createScanner, relationsOf } = await import('@/scripts/ci/scrubbed-column-writes');

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');
const SCHEMAS = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith('.prisma'))
  .map((f) => readFileSync(path.join(SCHEMA_DIR, f), 'utf8'));

/**
 * Not scanned, each with the reason:
 *
 * - `tests/` — fixtures, not write paths.
 * - `scripts/smoke/` — creates the rows a smoke run against a development
 *   database then erases. A fixture written to be scrubbed is not a stale copy
 *   of anything.
 * - `scripts/spikes/` — the same, for one-off measurements against a
 *   development database (`erasure-delivery-scale.ts` seeds deliveries to time
 *   erasing them).
 */
const NOT_SCANNED = [/^tests\//, /^scripts\/smoke\//, /^scripts\/spikes\//];

function sources(): string[] {
  return execSync("git ls-files --cached --others --exclude-standard -- '*.ts' '*.tsx'", {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      (p) =>
        p !== '' &&
        !p.endsWith('.d.ts') &&
        !/\.test\.tsx?$/.test(p) &&
        !p.startsWith('node_modules/') &&
        !NOT_SCANNED.some((re) => re.test(p)) &&
        // Deleted from the working tree but still in the index: nothing to read.
        existsSync(p)
    );
}

const scanner = createScanner(SCRUBBED_COLUMNS, relationsOf(SCHEMAS));
const FOUND = sources().flatMap((p) => scanner.scan({ path: p, source: readFileSync(p, 'utf8') }));
const APP = getAppStaleWriters();
const LISTED = [...STALE_WRITERS, ...APP];

const key = (w: { file: string; model: string }): string => `${w.file}#${w.model}`;

describe('the stale-writer manifest', () => {
  it('scans a population that contains the known writers', () => {
    // An "everything is listed" pass is free on an empty scan. Erasure's own
    // writers exist by construction, so finding none means the scan is broken.
    const found = new Set(FOUND.map(key));
    expect(FOUND.length).toBeGreaterThan(20);
    expect(found).toContain('lib/privacy/run-recipients.ts#AiWorkflowExecution');
    expect(found).toContain('lib/privacy/delivery-payloads.ts#AiWebhookDelivery');
  });

  it('lists every file that writes a scrubbed column', () => {
    const listed = new Set(LISTED.map(key));
    const unlisted = FOUND.filter((w) => !listed.has(key(w))).map(
      (w) =>
        `${w.file} writes ${w.model} (${w.via === 'unresolved' ? 'through a delegate the scan cannot follow' : `found by ${w.via}`})`
    );
    expect(
      unlisted,
      'Not listed in lib/privacy/stale-writers.ts — add each with its anchor (see this file’s header)'
    ).toEqual([]);
  });

  it('lists no file that does not write', () => {
    const found = new Set(FOUND.map(key));
    const stale = LISTED.filter((w) => !found.has(key(w))).map(key);
    expect(
      stale,
      'Listed but no write found — remove or move the entry if the file stopped writing'
    ).toEqual([]);
  });

  it('lists each file and model once, across Sunrise and the app', () => {
    const keys = LISTED.map(key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('gives every entry a scrubbed model and a reason', () => {
    const models = new Set(SCRUBBED_COLUMNS.map((m) => m.model));
    for (const w of LISTED) {
      expect(models, key(w)).toContain(w.model);
      expect(w.how.length, `${key(w)}: say how it knows its copy is stale`).toBeGreaterThanOrEqual(
        20
      );
    }
  });

  it('gives every entry one of the six anchors', () => {
    // `pending` went with §122's last task (t-900). The type says so; this
    // holds a registration that got past it, a fork's included.
    const anchors = ['version', 'row-lock', 'taken-at', 'intent', 'erasure', 'seed'];
    for (const w of LISTED) expect(anchors, key(w)).toContain(w.anchor);
  });
});

describe('SCRUBBED_COLUMNS', () => {
  /** `model X { … }` → its field names and its `@@map` table. */
  function modelOf(name: string): { fields: Set<string>; table: string | null } | null {
    for (const source of SCHEMAS) {
      const block = new RegExp(String.raw`^model\s+${name}\s*\{([\s\S]*?)^\}`, 'm').exec(source);
      if (!block) continue;
      const fields = new Set(
        block[1]
          .split('\n')
          .map((line) => /^\s+(\w+)\s+\w/.exec(line)?.[1])
          .filter((f): f is string => f !== undefined)
      );
      const table = /@@map\("(\w+)"\)/.exec(block[1])?.[1] ?? null;
      return { fields, table };
    }
    return null;
  }

  it.each(SCRUBBED_COLUMNS.map((m) => [m.model, m] as const))(
    '%s names a real model, its table and its columns',
    (_name, scrubbed) => {
      const schema = modelOf(scrubbed.model);
      expect(schema, `no model ${scrubbed.model}`).not.toBeNull();
      expect(schema?.table).toBe(scrubbed.table);
      for (const column of scrubbed.columns) expect(schema?.fields).toContain(column);
    }
  );
});
