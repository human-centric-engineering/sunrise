/**
 * Seed-ownership guard smoke script (#598).
 *
 * Proves the one thing a mocked test cannot: that a `functionDefinition`
 * round-tripped through Postgres comes back with its keys in a DIFFERENT order
 * from the one it was written in, and that the guard both write paths use is
 * unmoved by that.
 *
 * `functionDefinition` is `jsonb`. Postgres does not store the document you
 * sent — it stores a parsed form and re-emits object keys in its own canonical
 * order (shortest key first, then bytewise). Zod, meanwhile, rebuilds a parsed
 * body in schema-declaration order. So the value the admin form echoes back and
 * the value read from the row serialise to two different strings, and a
 * `JSON.stringify` comparison calls a byte-identical definition "changed" —
 * 403ing every save of every built-in.
 *
 * That happened once already, on #596. A unit test did not catch it because the
 * fixture and the payload shared an author and therefore shared a key order.
 * The assertion below deliberately depends on Postgres's behaviour rather than
 * on anyone's belief about it: step 2 FAILS if the reordering does not occur,
 * so if a future Postgres starts preserving insertion order this script says so
 * instead of quietly passing.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to invoke
 * anywhere — it only does real work where a DB exists.
 *
 * Self-cleaning: creates one `smoke-test-seed-ownership_*` capability and
 * removes it on every path, plus a prefix-scoped sweep at startup for the one
 * path `finally` cannot cover — a signal between the create and the delete.
 * Never touches seed data.
 *
 * Run with:
 *   npm run smoke:capability-ownership
 *   npx tsx --env-file=.env.local scripts/smoke/capability-seed-ownership.ts
 */

import { prisma } from '@/lib/db/client';
import { changedSeedOwnedFields } from '@/lib/orchestration/capabilities/seed-owned';

const PREFIX = 'smoke-test-seed-ownership';
const stamp = Date.now();
const SLUG = `${PREFIX}_${stamp}`;

/**
 * Written with the LONGEST key first, which is the opposite of the order
 * Postgres canonicalises to — so a round trip is guaranteed to move it, and
 * step 2 is a real assertion rather than a coincidence.
 */
const WRITTEN_DEFINITION = {
  description: 'A capability used only by the seed-ownership smoke script.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query' } },
    required: ['query'],
  },
  name: SLUG,
};

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log(
      'smoke:capability-ownership skipped — no database reachable (DATABASE_URL unset or DB down).'
    );
    return;
  }

  // 0. Sweep any row a previous run left behind. `finally` covers a thrown
  //    assertion but not a Ctrl-C or a SIGTERM between the create and the
  //    delete — and what it would strand is an `isSystem` capability that NO
  //    application path can remove: DELETE refuses `isSystem`, PATCH refuses
  //    `isActive: false` on it, and the guard this script exists to prove
  //    refuses its seed-owned fields. It would sit in the admin list and in
  //    `getCapabilityDefinitions` until someone reached for psql. Scoped to the
  //    script's own prefix, per `scripts/smoke/README.md` safety rule 2.
  const swept = await prisma.aiCapability.deleteMany({
    where: { slug: { startsWith: `${PREFIX}_` } },
  });
  if (swept.count > 0) {
    console.log(`  swept ${swept.count} stranded row(s) from an interrupted run`);
  }

  let capabilityId: string | null = null;

  try {
    // 1. Write a system capability whose definition is in non-canonical order.
    const created = await prisma.aiCapability.create({
      data: {
        name: 'Seed ownership smoke',
        slug: SLUG,
        description: 'smoke',
        category: 'smoke',
        functionDefinition: WRITTEN_DEFINITION,
        executionType: 'internal',
        executionHandler: 'SmokeCapability',
        isSystem: true,
      },
    });
    capabilityId = created.id;
    console.log(`\nsmoke:capability-ownership — capability ${created.id}\n`);

    // 2. Read it back and confirm Postgres moved the keys. If this fails, the
    //    premise of the whole guard has changed and the comparison strategy
    //    needs re-deciding — it does NOT mean the guard is fine.
    const stored = await prisma.aiCapability.findUniqueOrThrow({ where: { id: created.id } });
    const writtenKeys = Object.keys(WRITTEN_DEFINITION);
    const storedKeys = Object.keys(stored.functionDefinition as Record<string, unknown>);

    console.log(`  written key order: ${writtenKeys.join(', ')}`);
    console.log(`  stored  key order: ${storedKeys.join(', ')}`);
    check(
      JSON.stringify(writtenKeys) !== JSON.stringify(storedKeys),
      'Postgres re-orders jsonb keys on a round trip (the premise of the guard)'
    );
    check(
      JSON.stringify(stored.functionDefinition) !== JSON.stringify(WRITTEN_DEFINITION),
      'a JSON.stringify comparison would call the unchanged definition "changed"'
    );

    // 3. The guard sees through it: echoing the definition back unchanged —
    //    which is exactly what the capability form does on every save — must
    //    not read as a change.
    check(
      changedSeedOwnedFields(stored, {
        slug: stored.slug,
        functionDefinition: WRITTEN_DEFINITION,
        executionType: stored.executionType,
        executionHandler: stored.executionHandler,
      }).length === 0,
      'a full-form resubmit of the stored values reports no seed-owned change'
    );

    // 4. …and it still catches a genuine edit, nested one level down, where the
    //    only difference is a value rather than a key.
    const tampered = {
      ...WRITTEN_DEFINITION,
      parameters: {
        ...WRITTEN_DEFINITION.parameters,
        properties: { query: { type: 'number', description: 'The search query' } },
      },
    };
    check(
      changedSeedOwnedFields(stored, { functionDefinition: tampered }).join(',') ===
        'functionDefinition',
      'a changed nested parameter type is still reported'
    );
    check(
      changedSeedOwnedFields(stored, { slug: `${SLUG}_renamed` }).join(',') === 'slug',
      'a slug rename is still reported'
    );

    console.log('\nsmoke:capability-ownership PASSED\n');
  } finally {
    if (capabilityId) {
      await prisma.aiCapability.delete({ where: { id: capabilityId } }).catch(() => {
        console.warn(`  ! could not remove smoke capability ${capabilityId} — remove it by hand`);
      });
    }
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
