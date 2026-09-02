/**
 * Drift-probe primitives + app-extension registry.
 *
 * Verifies the behaviour forks and CI depend on:
 * - each factory queries the correct Postgres catalog and maps a row count /
 *   constraint definition to the right ProbeResult (including the
 *   `predicateContains` definition assertion);
 * - `generatedColumnExists` separates "missing" from "present but not
 *   GENERATED" — the second is the case `columnExists` cannot see;
 * - `rlsEnabled` separates "missing table" / "RLS off" / "enabled but not
 *   FORCED" — the last fails open for the table owner, which is why FORCE is
 *   the default requirement — and `policyExists` finds one named policy;
 * - the app registry adds in order, returns a defensive copy, rejects duplicate
 *   names, and resets;
 * - `mergeDriftProbes` concatenates platform + app and refuses an app probe that
 *   shadows a platform (A-series) name;
 * - the shipped `lib/app/db-drift.ts` scaffold registers nothing (Sunrise ships
 *   it empty — a stray committed probe should fail this test).
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — one case here asserts your seam is EMPTY
 * ---------------------------------------------------------------------------
 * `the shipped lib/app/db-drift.ts scaffold registers nothing` reads the real
 * seam, so registering your first probe is expected to fail it. Pin your own
 * probe names rather than deleting the case: what it protects is that a probe
 * committed to core by accident applies to every install, and that protection
 * is worth keeping once you have probes of your own to assert instead.
 *
 * Everything else in this file drives the registry directly and is unaffected.
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
  generatedColumnExists,
  getAppDriftProbes,
  indexExists,
  mergeDriftProbes,
  policyExists,
  rlsEnabled,
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

describe('generatedColumnExists', () => {
  it('reports ok when the column is GENERATED ALWAYS', async () => {
    queryRaw.mockResolvedValue([{ is_generated: 'ALWAYS' }]);

    const result = await generatedColumnExists('ai_knowledge_chunk', 'searchVector')();

    expect(result).toEqual({ ok: true });
    expect(lastSql()).toContain('is_generated');
    expect(lastValues()).toEqual(['ai_knowledge_chunk', 'searchVector']);
  });

  it('reports not-ok, and says so, when the column exists but is NOT generated', async () => {
    // The whole reason this factory exists. `columnExists` passes here: a
    // migration that recreated the column as a plain tsvector leaves a row in
    // information_schema.columns, so existence is satisfied while the column is
    // never populated again.
    queryRaw.mockResolvedValue([{ is_generated: 'NEVER' }]);

    const result = await generatedColumnExists('ai_knowledge_chunk', 'searchVector')();

    expect(result.ok).toBe(false);
    expect(result.note).toContain('not GENERATED');
    expect(result.note).toContain('NEVER');
  });

  it('distinguishes a missing column from a non-generated one', async () => {
    // Both are failures, but they need different remediation — recreate the
    // column vs re-add the GENERATED expression — so the note must say which.
    queryRaw.mockResolvedValue([]);

    const result = await generatedColumnExists('t', 'c')();

    expect(result.ok).toBe(false);
    expect(result.note).toBe('column missing entirely');
  });

  it('treats a null is_generated as missing rather than crashing', async () => {
    queryRaw.mockResolvedValue([{ is_generated: null }]);
    expect(await generatedColumnExists('t', 'c')()).toEqual({
      ok: false,
      note: 'column missing entirely',
    });
  });
});

describe('rlsEnabled', () => {
  it('queries pg_class by table name and reports ok when RLS is enabled AND forced', async () => {
    queryRaw.mockResolvedValue([{ enabled: true, forced: true }]);

    const result = await rlsEnabled('AiConversation')();

    expect(result).toEqual({ ok: true });
    expect(lastSql()).toContain('pg_class');
    expect(lastSql()).toContain('relrowsecurity');
    // Scoped to the live schema and admitting partitioned parents: a same-named
    // table in a backup schema must not answer for the real one (rows[0] would
    // make that a silent green), and relkind 'p' supports RLS fully.
    expect(lastSql()).toContain('relnamespace = current_schema()::regnamespace');
    expect(lastSql()).toContain("relkind IN ('r', 'p')");
    expect(lastValues()).toEqual(['AiConversation']);
  });

  it('reports not-ok, and says so, when RLS is enabled but NOT forced (the default posture)', async () => {
    // The whole reason FORCE is the default. An unforced table fails OPEN for
    // its owner: every query works, nothing errors, and the drift check is the
    // only thing that can say the boundary has a hole in it.
    queryRaw.mockResolvedValue([{ enabled: true, forced: false }]);

    const result = await rlsEnabled('AiConversation')();

    expect(result.ok).toBe(false);
    expect(result.note).toContain('not FORCED');
    expect(result.note).toContain('owner bypasses');
  });

  it('accepts enabled-but-unforced when requireForced is explicitly waived', async () => {
    queryRaw.mockResolvedValue([{ enabled: true, forced: false }]);

    const result = await rlsEnabled('AiConversation', { requireForced: false })();

    expect(result).toEqual({ ok: true });
  });

  it('reports not-ok when RLS is not enabled at all, whatever the force flag says', async () => {
    queryRaw.mockResolvedValue([{ enabled: false, forced: false }]);

    const result = await rlsEnabled('AiConversation')();

    expect(result.ok).toBe(false);
    expect(result.note).toContain('not enabled');
  });

  it('distinguishes a missing table from a table without RLS', async () => {
    // Different remediation — the table was dropped/renamed vs RLS was never
    // (or no longer is) enabled — so the note must say which.
    queryRaw.mockResolvedValue([]);

    const result = await rlsEnabled('gone')();

    expect(result.ok).toBe(false);
    expect(result.note).toBe('table missing entirely');
  });
});

describe('policyExists', () => {
  it('queries pg_policies by table + policy name and reports ok on exactly one row', async () => {
    queryRaw.mockResolvedValue([{ count: 1n }]);

    const result = await policyExists('AiConversation', 'org_isolation')();

    expect(result).toEqual({ ok: true });
    expect(lastSql()).toContain('pg_policies');
    // Same-schema scoping: a same-named policy in a backup schema must neither
    // stand in for a dropped live policy nor inflate the exact ===1 count.
    expect(lastSql()).toContain('schemaname = current_schema()');
    expect(lastValues()).toEqual(['AiConversation', 'org_isolation']);
  });

  it('reports not-ok when the policy is absent (count 0)', async () => {
    // The DROP POLICY case: `prisma migrate dev` emits it for any policy, the
    // same way it drops the HNSW indexes this registry was built around.
    queryRaw.mockResolvedValue([{ count: 0n }]);
    expect(await policyExists('AiConversation', 'org_isolation')()).toEqual({ ok: false });
  });

  it('treats an empty result set as absent rather than crashing', async () => {
    queryRaw.mockResolvedValue([]);
    expect(await policyExists('t', 'p')()).toEqual({ ok: false });
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
