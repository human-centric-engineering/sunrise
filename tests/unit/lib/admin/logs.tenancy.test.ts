/**
 * Tests: the admin log buffer is scoped to the org reading it (§108 t-714)
 *
 * The buffer is one process-wide ring and the *query* is what is scoped, so
 * these tests drive the real tenant context — `runAsOrg` to produce a line,
 * `runAsOrg` again to read it — rather than passing an org in. A stamp that
 * came from anywhere other than the call stack would pass a test that hands it
 * over and fail in production, where nobody does.
 *
 * The case worth the file is the **unstamped** entry: boot, a `runAsSystem`
 * job, and a platform credential (an admin API key with no org, which
 * `inTenantScope` runs unscoped in both modes) all produce one. It is everyone's
 * at `single` and nobody's at `multi` — which is what keeps every existing
 * single-tenant install's Logs page showing what it always showed.
 *
 * @see lib/admin/logs.ts
 * @see lib/tenancy/process-state.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Two readers of one variable, on purpose: `lib/tenancy/context.ts` goes
// through the validated `env` module, and `lib/admin/logs.ts` reads
// `process.env` directly because it may have no runtime imports. Both are
// stubbed here, and a test below pins that they agree.
const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

/** Put the install in a mode, for both readers of it. */
function setMode(mode: 'single' | 'multi'): void {
  mockEnv.TENANCY_MODE = mode;
  vi.stubEnv('TENANCY_MODE', mode);
}

import { addLogEntry, getLogEntries, clearLogBuffer, getBufferSize } from '@/lib/admin/logs';
import { isMultiTenant, runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import type { LogEntry } from '@/types/admin';

const ORG_A = 'cmorg00000000000000000orga';
const ORG_B = 'cmorg00000000000000000orgb';

function entry(message: string, over: Partial<Omit<LogEntry, 'id'>> = {}): Omit<LogEntry, 'id'> {
  return { timestamp: new Date().toISOString(), level: 'info', message, ...over };
}

beforeEach(() => {
  clearLogBuffer();
  setMode('multi');
});

describe('at multi', () => {
  /** Seed one line per producer: org A, org B, a system job, and no context. */
  async function seed(): Promise<void> {
    await runAsOrg(ORG_A, async () => addLogEntry(entry('org A request')));
    await runAsOrg(ORG_B, async () => addLogEntry(entry('org B request')));
    await runAsSystem('test: a system-scoped job', async () =>
      addLogEntry(entry('system job line'))
    );
    addLogEntry(entry('platform credential line'));
  }

  it('shows each org its own lines and nobody else’s', async () => {
    await seed();

    const asA = await runAsOrg(ORG_A, async () =>
      getLogEntries({ limit: 100 }).entries.map((e) => e.message)
    );
    const asB = await runAsOrg(ORG_B, async () =>
      getLogEntries({ limit: 100 }).entries.map((e) => e.message)
    );

    expect(asA).toEqual(['org A request']);
    expect(asB).toEqual(['org B request']);
  });

  it('hides the unstamped lines from an org admin — system jobs included', async () => {
    await seed();

    const asA = await runAsOrg(ORG_A, async () =>
      getLogEntries({ limit: 100 }).entries.map((e) => e.message)
    );

    expect(asA).not.toContain('system job line');
    expect(asA).not.toContain('platform credential line');
  });

  it('shows the unstamped lines to a reader who is also outside an org', async () => {
    // The platform credential: `inTenantScope` enters no org for it, in either
    // mode. It is the nearest thing to an operator view until §111, and it
    // still sees no org's lines.
    await seed();

    const asPlatform = getLogEntries({ limit: 100 }).entries.map((e) => e.message);

    expect(asPlatform.sort()).toEqual(['platform credential line', 'system job line']);
  });

  it('counts only what the reader can see, so pagination is not of other orgs’ lines', async () => {
    await runAsOrg(ORG_A, async () => addLogEntry(entry('a1')));
    for (const message of ['b1', 'b2', 'b3']) {
      await runAsOrg(ORG_B, async () => addLogEntry(entry(message)));
    }

    const asA = await runAsOrg(ORG_A, async () => getLogEntries({ limit: 100 }));

    // `total` drives the admin table's pager — reporting 4 here would offer a
    // reader pages of rows that do not exist for them.
    expect(asA.total).toBe(1);
    expect(getBufferSize()).toBe(4);
  });

  it('keeps every org’s lines in the one ring — the scope is the query, not the buffer', async () => {
    await seed();
    expect(getBufferSize()).toBe(4);
  });

  it('applies the level and search filters within the reader’s own lines', async () => {
    await runAsOrg(ORG_A, async () => addLogEntry(entry('database timeout', { level: 'error' })));
    await runAsOrg(ORG_B, async () => addLogEntry(entry('database timeout', { level: 'error' })));

    const asA = await runAsOrg(ORG_A, async () => getLogEntries({ search: 'database' }));

    expect(asA.total).toBe(1);
    expect(asA.entries[0].orgId).toBe(ORG_A);
  });
});

describe('at single', () => {
  beforeEach(() => {
    setMode('single');
  });

  it('shows the unstamped lines, so the page keeps showing what it always did', async () => {
    // Boot, the maintenance tick under a platform key, a system-scoped job:
    // none of them enters an org, in either mode. Hiding them at `single`
    // would empty the page of exactly what an operator opens it for, and
    // protect nothing — there is one org.
    addLogEntry(entry('boot line'));
    await runAsSystem('test: a system-scoped job', async () =>
      addLogEntry(entry('system job line'))
    );
    await runAsOrg(INSTALL_ORG_ID, async () => addLogEntry(entry('install org request')));

    const seen = getLogEntries({ limit: 100 })
      .entries.map((e) => e.message)
      .sort();

    expect(seen).toEqual(['boot line', 'install org request', 'system job line']);
  });

  it('reads the install org’s lines with no scope entered around the read', async () => {
    await runAsOrg(INSTALL_ORG_ID, async () => addLogEntry(entry('install org request')));

    expect(getLogEntries({ limit: 100 }).entries.map((e) => e.message)).toEqual([
      'install org request',
    ]);
  });

  it('still shows a second org’s job lines, which the narrower rule would have hidden', async () => {
    // `forEachOrg` iterates every ACTIVE org in BOTH modes, and the org API
    // creates orgs in both, so a single-mode install CAN hold a second org and
    // stamp its job lines with it. Scoping the read to the install org here
    // would have made those lines vanish from a page that has always shown
    // them — a narrowing at `single` with nothing to show for it.
    await runAsOrg(ORG_B, async () => addLogEntry(entry('org B job line')));
    await runAsOrg(INSTALL_ORG_ID, async () => addLogEntry(entry('install org request')));

    expect(
      getLogEntries({ limit: 100 })
        .entries.map((e) => e.message)
        .sort()
    ).toEqual(['install org request', 'org B job line']);
  });
});

describe('the buffer stays out of the browser bundle', () => {
  // The invariant this file's design exists to protect, asserted on the source
  // rather than on behaviour, because nothing else in the local gate sequence
  // can see it: `lib/logging/index.ts` reaches the buffer with a literal
  // `require('@/lib/admin/logs')` and is imported by fifteen-plus `'use
  // client'` modules, so a RUNTIME import here lands in the browser bundle.
  // The first version of §108 t-714 imported `@/lib/tenancy/context` directly
  // and `npm run build` failed with seven unresolved Node builtins —
  // `lib/db/client.ts` → `pg` → `dns`/`fs`/`net`/`tls`. type-check, lint and
  // vitest were all green for it.
  //
  // `require(` and `await import(` are in the detector because the coupling
  // this guard prevents is itself written as a `require` — a bundler resolves
  // a literal specifier whichever form it takes, so a lazy
  // `const { x } = require('@/lib/tenancy/context')` inside a function would
  // reproduce the same build failure while an import-only regex stayed green.
  const RUNTIME_IMPORT = /^import\s+(?!type\b)|\brequire\s*\(|\bimport\s*\(/;

  it('lib/admin/logs.ts reaches no other module at runtime', () => {
    const source = readFileSync(resolve(process.cwd(), 'lib/admin/logs.ts'), 'utf8');
    const runtimeImports = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .filter((line) => RUNTIME_IMPORT.test(line.trim()));

    expect(runtimeImports, 'tenancy reaches this module by registration, not import').toEqual([]);
  });

  it('lib/logging/index.ts has no static imports either', () => {
    // The other half of the same invariant: the logger is what the client
    // components import, so anything it pulls in statically is in their
    // bundle too. It is why the buffer is reached by `require` at call time.
    const source = readFileSync(resolve(process.cwd(), 'lib/logging/index.ts'), 'utf8');
    const staticImports = source.split('\n').filter((line) => /^import\s/.test(line.trim()));

    expect(staticImports).toEqual([]);
  });

  it.each([
    ["import { getTenantContext } from '@/lib/tenancy/context';", true],
    ["const { getTenantContext } = require('@/lib/tenancy/context');", true],
    ["const mod = await import('@/lib/tenancy/context');", true],
    ["import type { LogEntry } from '@/types/admin';", false],
  ])('proves it can fail — %s is a hit: %s', (line, expected) => {
    expect(RUNTIME_IMPORT.test(line)).toBe(expected);
  });

  it('agrees with the tenancy module about what multi means', () => {
    // The buffer reads `process.env.TENANCY_MODE` and everything else reads the
    // validated `env` module. One variable, two readers, so pin that they
    // answer the same question — a rename on one side would otherwise make the
    // scope rule silently stop applying.
    setMode('multi');
    expect(isMultiTenant()).toBe(true);
    setMode('single');
    expect(isMultiTenant()).toBe(false);
  });
});

describe('the stamp', () => {
  it('records the org the line was produced in', async () => {
    await runAsOrg(ORG_A, async () => addLogEntry(entry('org A request')));

    const [line] = await runAsOrg(ORG_A, async () => getLogEntries({ limit: 100 }).entries);
    expect(line.orgId).toBe(ORG_A);
  });

  it('is null for a line produced outside any scope', async () => {
    setMode('single');
    addLogEntry(entry('boot line'));

    expect(getLogEntries({ limit: 100 }).entries[0].orgId).toBeNull();
  });

  it('ignores an org the caller supplies, so nobody can write onto another org’s page', async () => {
    // The stamp is the call stack's, never the caller's word for it. An
    // "honour an explicit orgId" branch stood here for one commit, and what it
    // actually provided was a mislabel primitive: code running in org A
    // writing a line that appears on org B's Logs page.
    await runAsOrg(ORG_A, async () => addLogEntry(entry('claims to be B', { orgId: ORG_B })));

    const asB = await runAsOrg(ORG_B, async () =>
      getLogEntries({ limit: 100 }).entries.map((e) => e.message)
    );
    const asA = await runAsOrg(ORG_A, async () =>
      getLogEntries({ limit: 100 }).entries.map((e) => e.message)
    );

    expect(asB).toEqual([]);
    expect(asA).toEqual(['claims to be B']);
  });
});
