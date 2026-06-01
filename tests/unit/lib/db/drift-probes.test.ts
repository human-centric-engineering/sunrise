/**
 * Drift-probe primitives + app-extension registry.
 *
 * Verifies the behaviour forks and CI depend on:
 * - each factory queries the correct Postgres catalog and maps a row count /
 *   constraint definition to the right ProbeResult (including the
 *   `predicateContains` definition assertion);
 * - the app registry adds in order, returns a defensive copy, rejects duplicate
 *   names, and resets;
 * - `mergeDriftProbes` concatenates platform + app and refuses an app probe that
 *   shadows a platform (A-series) name;
 * - the shipped `lib/app/db-drift.ts` scaffold registers nothing (Sunrise ships
 *   it empty — a stray committed probe should fail this test).
 *
 * @see lib/db/drift-probes.ts
 * @see lib/app/db-drift.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The factories close over the prisma singleton; mock it so probes run without a DB.
vi.mock('@/lib/db/client', () => ({
  prisma: { $queryRaw: vi.fn() },
}));

import { registerAppDriftProbes } from '@/lib/app/db-drift';
import { prisma } from '@/lib/db/client';
import {
  columnExists,
  constraintExists,
  getAppDriftProbes,
  indexExists,
  mergeDriftProbes,
  registerAppDriftProbe,
  resetAppDriftProbes,
  type DriftObject,
} from '@/lib/db/drift-probes';

const queryRaw = vi.mocked(prisma.$queryRaw);

/** Static SQL of the most recent $queryRaw call (the tagged-template strings, joined). */
function lastSql(): string {
  const call = queryRaw.mock.calls.at(-1);
  return (call?.[0] as unknown as TemplateStringsArray).join('');
}

/** Interpolated values of the most recent $queryRaw call. */
function lastValues(): unknown[] {
  return queryRaw.mock.calls.at(-1)?.slice(1) ?? [];
}

function probe(name: string): DriftObject {
  return { name, kind: 'test', table: 't', probe: async () => ({ ok: true }) };
}

beforeEach(() => {
  resetAppDriftProbes();
  queryRaw.mockReset();
});

describe('indexExists', () => {
  it('queries pg_indexes by name and reports ok when exactly one row exists', async () => {
    queryRaw.mockResolvedValue([{ count: 1n }]);

    const result = await indexExists('idx_knowledge_embedding')();

    expect(result).toEqual({ ok: true });
    expect(lastSql()).toContain('pg_indexes');
    expect(lastValues()).toEqual(['idx_knowledge_embedding']);
  });

  it('reports not-ok when the index is absent (count 0)', async () => {
    queryRaw.mockResolvedValue([{ count: 0n }]);
    expect(await indexExists('missing')()).toEqual({ ok: false });
  });

  it('treats an empty result set as absent rather than crashing', async () => {
    queryRaw.mockResolvedValue([]);
    expect(await indexExists('missing')()).toEqual({ ok: false });
  });
});

describe('columnExists', () => {
  it('queries information_schema.columns by table + column', async () => {
    queryRaw.mockResolvedValue([{ count: 1n }]);

    const result = await columnExists('ai_knowledge_chunk', 'searchVector')();

    expect(result).toEqual({ ok: true });
    expect(lastSql()).toContain('information_schema.columns');
    expect(lastValues()).toEqual(['ai_knowledge_chunk', 'searchVector']);
  });

  it('reports not-ok when the column is absent', async () => {
    queryRaw.mockResolvedValue([{ count: 0n }]);
    expect(await columnExists('t', 'c')()).toEqual({ ok: false });
  });

  it('treats an empty result set as absent rather than crashing', async () => {
    queryRaw.mockResolvedValue([]);
    expect(await columnExists('t', 'c')()).toEqual({ ok: false });
  });
});

describe('constraintExists', () => {
  it('queries pg_constraint and reports ok when a definition is returned', async () => {
    queryRaw.mockResolvedValue([
      { def: 'FOREIGN KEY (userId) REFERENCES "User"(id) ON DELETE CASCADE' },
    ]);

    const result = await constraintExists('AppUserProfile_userId_fkey')();

    expect(result).toEqual({ ok: true });
    expect(lastSql()).toContain('pg_constraint');
    expect(lastValues()).toEqual(['AppUserProfile_userId_fkey']);
  });

  it('reports not-ok when the constraint is missing', async () => {
    queryRaw.mockResolvedValue([]);
    expect(await constraintExists('missing')()).toEqual({ ok: false });
  });

  it('passes when the definition contains the asserted substring', async () => {
    queryRaw.mockResolvedValue([
      { def: 'FOREIGN KEY (userId) REFERENCES "User"(id) ON DELETE CASCADE' },
    ]);

    const result = await constraintExists('fk', 'ON DELETE CASCADE')();

    expect(result.ok).toBe(true);
  });

  it('fails with a diagnostic note when the definition lacks the asserted substring', async () => {
    queryRaw.mockResolvedValue([
      { def: 'FOREIGN KEY (userId) REFERENCES "User"(id) ON DELETE SET NULL' },
    ]);

    const result = await constraintExists('fk', 'ON DELETE CASCADE')();

    expect(result.ok).toBe(false);
    // The note must surface BOTH the missing assertion and what was actually seen,
    // so an operator can tell a wrong-policy FK from an absent one.
    expect(result.note).toContain('ON DELETE CASCADE');
    expect(result.note).toContain('ON DELETE SET NULL');
  });

  it('treats a null definition (no row) as not-ok even with a predicate', async () => {
    queryRaw.mockResolvedValue([{ def: null }]);
    expect(await constraintExists('fk', 'anything')()).toEqual({ ok: false });
  });
});

describe('app drift-probe registry', () => {
  it('registers probes and returns them in registration order', () => {
    registerAppDriftProbe(probe('first'));
    registerAppDriftProbe(probe('second'));

    expect(getAppDriftProbes().map((p) => p.name)).toEqual(['first', 'second']);
  });

  it('returns a defensive copy — mutating it does not corrupt the registry', () => {
    registerAppDriftProbe(probe('only'));

    getAppDriftProbes().push(probe('sneaky'));

    expect(getAppDriftProbes().map((p) => p.name)).toEqual(['only']);
  });

  it('throws on a duplicate probe name', () => {
    registerAppDriftProbe(probe('dup'));
    expect(() => registerAppDriftProbe(probe('dup'))).toThrow(
      /Duplicate app drift probe name: "dup"/
    );
  });

  it('resetAppDriftProbes clears the registry', () => {
    registerAppDriftProbe(probe('x'));
    resetAppDriftProbes();
    expect(getAppDriftProbes()).toEqual([]);
  });
});

describe('mergeDriftProbes', () => {
  it('concatenates platform probes before app probes', () => {
    const merged = mergeDriftProbes([probe('A1'), probe('A2')], [probe('app1')]);
    expect(merged.map((p) => p.name)).toEqual(['A1', 'A2', 'app1']);
  });

  it('throws when an app probe reuses a platform probe name (anti-shadowing)', () => {
    expect(() => mergeDriftProbes([probe('A3')], [probe('A3')])).toThrow(
      /App drift probe "A3" collides with a platform/
    );
  });

  it('allows an empty app set', () => {
    const merged = mergeDriftProbes([probe('A1')], []);
    expect(merged.map((p) => p.name)).toEqual(['A1']);
  });
});

describe('shipped lib/app/db-drift.ts scaffold', () => {
  it('registers zero probes by default (Sunrise ships the scaffold empty)', () => {
    registerAppDriftProbes();
    expect(getAppDriftProbes()).toEqual([]);
  });
});
