/**
 * Tests: the identity migration and the invariant it establishes (§106 t-669)
 *
 * "Every install has an org, and every user belongs to one" is two writes in
 * two places — SQL for the rows that already exist, `userCreateAfterHook` for
 * the rows created afterwards — and they must apply ONE rule. A mocked unit
 * test cannot run the SQL, and `npm run smoke:tenancy` runs it but only on a
 * database somebody has. So this reads the migration file and asserts the
 * statements are there, are idempotent, and apply the same role rule as
 * `initialMembershipFor()`; the smoke proves them against Postgres.
 *
 * The `auth-schema-parity.test.ts` precedent: the migration text is a
 * contract the tree can check without a database.
 *
 * @see prisma/migrations/20260917120000_org_identity/migration.sql
 * @see lib/tenancy/membership.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { INSTALL_ORG_ID, INSTALL_ORG_SLUG } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE, DEFAULT_ORG_ROLE } from '@/lib/tenancy/roles';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { initialMembershipFor } from '@/lib/tenancy/membership';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

const MIGRATION = readFileSync(
  path.join(process.cwd(), 'prisma/migrations/20260917120000_org_identity/migration.sql'),
  'utf8'
);

/** The SQL with comments stripped, so an assertion cannot pass on prose. */
const sql = MIGRATION.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('the install org', () => {
  it('is inserted with the fixed id and slug the constants name', () => {
    // The literal in the SQL and the literal in lib/tenancy/constants.ts are
    // the same row; nothing else ties them together.
    expect(sql).toMatch(
      new RegExp(
        `INSERT INTO "org" \\("id", "slug", "name", "status", "createdAt", "updatedAt"\\)\\s*VALUES \\('${INSTALL_ORG_ID}', '${INSTALL_ORG_SLUG}', '[^']+', 'ACTIVE'`
      )
    );
  });

  it('is idempotent — a re-run or a hand-created row does not fail the deploy', () => {
    expect(sql).toMatch(/INSERT INTO "org"[\s\S]*?ON CONFLICT \("id"\) DO NOTHING;/);
  });
});

describe('the membership backfill', () => {
  const backfill =
    /INSERT INTO "org_membership"[\s\S]*?ON CONFLICT \("orgId", "userId"\) DO NOTHING;/.exec(
      sql
    )?.[0];

  it('exists, selects every user, and is idempotent on the (orgId, userId) unique', () => {
    expect(backfill).toBeDefined();
    expect(backfill).toMatch(/FROM "user" u/);
  });

  it('lands every user in the install org', () => {
    expect(backfill).toContain(`'${INSTALL_ORG_ID}',`);
  });

  it('applies the same role rule as initialMembershipFor()', () => {
    // The SQL: a HUMAN platform ADMIN → OWNER, everyone else → MEMBER.
    expect(backfill).toMatch(
      new RegExp(
        `CASE WHEN u\\."role" = '${PLATFORM_ADMIN_ROLE}' AND u\\."accountType" = 'HUMAN' THEN '${ORG_OWNER_ROLE}'::"OrgRole" ELSE '${DEFAULT_ORG_ROLE}'::"OrgRole" END`
      )
    );
    // The function: the same three cases, in the same direction. If either
    // side changes alone, one of these four assertions fails.
    expect(initialMembershipFor({ role: PLATFORM_ADMIN_ROLE, accountType: 'HUMAN' })).toEqual({
      orgId: INSTALL_ORG_ID,
      role: ORG_OWNER_ROLE,
    });
    expect(initialMembershipFor({ role: PLATFORM_ADMIN_ROLE, accountType: 'SERVICE' })).toEqual({
      orgId: INSTALL_ORG_ID,
      role: DEFAULT_ORG_ROLE,
    });
    expect(initialMembershipFor({ role: 'USER', accountType: 'HUMAN' })).toEqual({
      orgId: INSTALL_ORG_ID,
      role: DEFAULT_ORG_ROLE,
    });
    expect(initialMembershipFor({ role: null, accountType: null })).toEqual({
      orgId: INSTALL_ORG_ID,
      role: DEFAULT_ORG_ROLE,
    });
  });
});

describe('the credential and session columns', () => {
  const CREDENTIAL_TABLES = [
    'ai_api_key',
    'ai_agent_embed_token',
    'ai_agent_invite_token',
    'mcp_api_key',
  ];

  it('adds a nullable orgId, an index and a cascading FK to each of the four credential tables', () => {
    for (const table of CREDENTIAL_TABLES) {
      expect(sql, table).toMatch(new RegExp(`ALTER TABLE "${table}" ADD COLUMN\\s+"orgId" TEXT;`));
      expect(sql, table).toMatch(
        new RegExp(`CREATE INDEX "${table}_orgId_idx" ON "${table}"\\("orgId"\\);`)
      );
      expect(sql, table).toMatch(
        new RegExp(
          `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_orgId_fkey" FOREIGN KEY \\("orgId"\\) REFERENCES "org"\\("id"\\) ON DELETE CASCADE`
        )
      );
    }
  });

  it('backfills each credential table to the install org, guarded on NULL so a re-run rewrites nothing', () => {
    for (const table of CREDENTIAL_TABLES) {
      expect(sql, table).toMatch(
        new RegExp(`UPDATE "${table}"\\s+SET "orgId" = '${INSTALL_ORG_ID}' WHERE "orgId" IS NULL`)
      );
    }
  });

  it("leaves an admin-scoped API key unbound — a platform credential's orgId is NULL", () => {
    // Reconciliation finding 13 / t-673's mint rule: an org-bound `admin` key
    // cannot exist. The backfill must not create one.
    expect(sql).toMatch(
      /UPDATE "ai_api_key"\s+SET "orgId" = 'install' WHERE "orgId" IS NULL AND NOT \('admin' = ANY\("scopes"\)\);/
    );
    // And only that table has the exemption: the other three carry no scopes.
    for (const table of CREDENTIAL_TABLES.filter((t) => t !== 'ai_api_key')) {
      expect(sql, table).toMatch(
        new RegExp(`UPDATE "${table}"\\s+SET "orgId" = 'install' WHERE "orgId" IS NULL;`)
      );
    }
  });

  it('adds session.activeOrgId as a nullable scalar with no FK', () => {
    // t-670 wires it; the column lands here so the feature ships one
    // migration. No FK on purpose — better-auth owns this table's shape.
    expect(sql).toMatch(/ALTER TABLE "session" ADD COLUMN\s+"activeOrgId" TEXT;/);
    expect(sql).not.toMatch(/ALTER TABLE "session" ADD CONSTRAINT/);
  });
});

describe('hand-folding', () => {
  it('carries none of the drift prisma migrate diff regenerates', () => {
    // The three raw-SQL indexes the baseline creates and the generated
    // column's DROP DEFAULT — every migration in this repo strips them, and
    // the second fails at apply time.
    expect(sql).not.toMatch(/DROP INDEX/);
    expect(sql).not.toMatch(/"searchVector" DROP DEFAULT/);
  });
});

describe('the credential backfill re-run (t-673)', () => {
  // Every credential minted between the identity migration and t-673 carries orgId = NULL —
  // the column existed, nothing wrote it. The re-run is the identity
  // migration's four statements, again; holding them byte-equal is what
  // makes "re-run" a fact rather than a paraphrase, and what keeps the
  // `admin` exemption from being lost in the copy.
  const RERUN = readFileSync(
    path.join(
      process.cwd(),
      'prisma/migrations/20260918120000_credential_org_backfill/migration.sql'
    ),
    'utf8'
  );
  const statements = (text: string) =>
    text
      .split('\n')
      .filter((line) => line.startsWith('UPDATE "'))
      .sort();

  it('is exactly the four UPDATE statements of the identity migration, and nothing else', () => {
    const rerun = statements(RERUN);
    expect(rerun).toHaveLength(4);
    expect(rerun).toEqual(statements(MIGRATION));
    // Data only: no DDL rides along with a backfill.
    const sqlOnly = RERUN.split('\n').filter(
      (line) => line.trim() !== '' && !line.trimStart().startsWith('--')
    );
    expect(sqlOnly).toHaveLength(4);
  });
});
