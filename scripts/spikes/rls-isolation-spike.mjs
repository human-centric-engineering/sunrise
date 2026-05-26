// RLS isolation spike — throwaway validation for the multi-tenancy playbook.
//
// Proves the load-bearing claim of `.context/architecture/multi-tenancy.md`:
// with a pooled `pg` connection (the exact Pool class `lib/db/client.ts` uses),
// tenant scoping MUST be set per-transaction (`SET LOCAL` inside BEGIN/COMMIT),
// never per-session — because the pool recycles physical connections and a
// session-level `SET` leaks one tenant's context onto the next borrower.
//
// Run against a throwaway pgvector container (NOT the dev DB):
//   docker run -d --name sunrise-rls-spike -e POSTGRES_PASSWORD=postgres -p 5433:5432 pgvector/pgvector:pg15
//   node scripts/spikes/rls-isolation-spike.mjs
//
// Or point it at any throwaway database via env (the table + role are created
// and the role is dropped by the harness around this script):
//   SPIKE_ADMIN_URL=postgresql://me@localhost:5432/rls_spike \
//   SPIKE_APP_URL=postgresql://app_user:app_pw@localhost:5432/rls_spike \
//   node scripts/spikes/rls-isolation-spike.mjs
//
// This is a spike: it is not wired into the app and creates no migration.
import pg from 'pg';

const { Pool } = pg;

const ADMIN_URL =
  process.env.SPIKE_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5433/postgres';
const APP_URL = process.env.SPIKE_APP_URL ?? 'postgresql://app_user:app_pw@localhost:5433/postgres';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const bodies = (rows) => rows.map((r) => r.body);

async function main() {
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });

  // --- Schema + seed, as the superuser (which BYPASSES RLS — this IS the
  //     migration/seed bypass path, point (d)). app_user is a plain LOGIN role
  //     with NO BYPASSRLS, so it is subject to the policy. ---
  await admin.query(`DROP TABLE IF EXISTS spike_notes`);
  await admin.query(`DROP ROLE IF EXISTS app_user`);
  await admin.query(`CREATE ROLE app_user LOGIN PASSWORD 'app_pw'`);
  await admin.query(`
    CREATE TABLE spike_notes (
      id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      body   text NOT NULL
    )
  `);
  await admin.query(`GRANT SELECT, INSERT ON spike_notes TO app_user`);
  await admin.query(`ALTER TABLE spike_notes ENABLE ROW LEVEL SECURITY`);
  // `current_setting(..., true)` = missing_ok: returns NULL when the GUC was
  // NEVER set. BUT once any `SET LOCAL` has touched this placeholder on a
  // pooled connection, it reverts to an EMPTY STRING after the transaction —
  // not NULL — so `''::uuid` would throw (22P02) on the next unscoped query.
  // `NULLIF(..., '')` collapses both unset and reverted-empty to NULL, giving
  // a clean default-deny (no rows) instead of a crash. This is the robust form.
  await admin.query(`
    CREATE POLICY org_isolation ON spike_notes
      USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  `);
  await admin.query(
    `INSERT INTO spike_notes (org_id, body) VALUES ($1,'A-secret-1'),($1,'A-secret-2'),($2,'B-secret-1')`,
    [ORG_A, ORG_B]
  );

  console.log('=== (d) BYPASS PATH: superuser sees every row (migrations/seed) ===');
  const all = await admin.query(`SELECT body FROM spike_notes ORDER BY body`);
  console.log('    superuser sees:', bodies(all.rows), `(${all.rows.length} rows)\n`);

  // --- (a) THE FAILURE MODE: session-level SET leaks across pooled checkouts.
  //     max:1 makes the leak deterministic — checkout #2 reuses the exact
  //     physical connection that checkout #1 left a session GUC on. ---
  console.log('=== (a) FAILURE: session-level SET leaks across a pooled connection ===');
  const leakPool = new Pool({ connectionString: APP_URL, max: 1 });
  {
    const c = await leakPool.connect();
    await c.query(`SET app.current_org = '${ORG_A}'`); // session-level, NO transaction
    const r = await c.query(`SELECT body FROM spike_notes ORDER BY body`);
    console.log('    req#1  SET session org=A           -> app_user sees:', bodies(r.rows));
    c.release(); // returns the SAME connection to the pool; node-postgres does NOT reset it
  }
  {
    const c = await leakPool.connect(); // reuses the leaked connection
    const r = await c.query(`SELECT body FROM spike_notes ORDER BY body`);
    console.log('    req#2  NO set (different "tenant")  -> reused conn sees:', bodies(r.rows));
    console.log(
      r.rows.length > 0
        ? '    >>> LEAK: request #2 read tenant A data it never scoped to.\n'
        : '    >>> (no leak)\n'
    );
    c.release();
  }
  await leakPool.end();

  // --- (b)+(c) THE FIX: SET LOCAL inside a transaction. Scope ends at COMMIT,
  //     so the reused connection carries nothing forward. (c): the SELECT here
  //     is a raw query — the same shape Prisma issues as $queryRawUnsafe for
  //     pgvector search — and RLS enforces it just the same, because the policy
  //     lives in Postgres, below the query API. ---
  console.log('=== (b)+(c) FIX: SET LOCAL per-transaction — no leak, raw query still scoped ===');
  const fixPool = new Pool({ connectionString: APP_URL, max: 1 });
  {
    const c = await fixPool.connect();
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.current_org = '${ORG_B}'`);
    const r = await c.query(`SELECT body FROM spike_notes ORDER BY body`); // raw == $queryRawUnsafe
    console.log('    req#1  BEGIN; SET LOCAL org=B; raw SELECT -> sees:', bodies(r.rows));
    await c.query('COMMIT'); // SET LOCAL scope ends here
    c.release();
  }
  {
    const c = await fixPool.connect(); // reuses the same physical connection
    const r = await c.query(`SELECT body FROM spike_notes ORDER BY body`);
    console.log(
      '    req#2  NO set (different "tenant")         -> reused conn sees:',
      bodies(r.rows)
    );
    console.log(
      r.rows.length === 0
        ? '    >>> NO LEAK: SET LOCAL did not survive the transaction.\n'
        : '    >>> LEAK (unexpected)\n'
    );
    c.release();
  }
  await fixPool.end();

  await admin.end();
}

main().catch((err) => {
  console.error('spike failed:', err);
  process.exit(1);
});
