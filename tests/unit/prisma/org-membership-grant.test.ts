/**
 * Tests: `OrgMembershipGrant` goes with its membership (t-1123).
 *
 * A grant is erased by the database, not by a manifest walk: removing a
 * member, erasing a user (whose memberships cascade) and erasing an org
 * (likewise) all delete the membership row, and the grant must go with it.
 * So this pins the schema's relation and the migration's constraint, both of
 * which a later `migrate dev` or a hand edit could change without any other
 * test noticing, and that a membership has at most one grant.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const schema = readFileSync(join(ROOT, 'prisma/schema/tenancy.prisma'), 'utf8');

/** The body of one model block in the schema. */
function modelBody(name: string): string {
  const match = new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  expect(match, `model ${name} is in tenancy.prisma`).not.toBeNull();
  return match![1];
}

describe('OrgMembershipGrant (t-1123)', () => {
  const body = modelBody('OrgMembershipGrant');

  it('is deleted with its membership: the relation cascades', () => {
    expect(body).toMatch(
      /membership\s+OrgMembership\s+@relation\(fields: \[membershipId\], references: \[id\], onDelete: Cascade\)/
    );
  });

  it('is one per membership', () => {
    expect(body).toMatch(/membershipId\s+String\s+@unique/);
  });

  it('carries no orgId or userId of its own: it is the membership’s', () => {
    expect(body).not.toMatch(/^\s*orgId\s/m);
    expect(body).not.toMatch(/^\s*userId\s/m);
  });

  it('is created in a migration with ON DELETE CASCADE on the membership', () => {
    const dir = join(ROOT, 'prisma/migrations');
    const sql = readdirSync(dir)
      .filter((name) => name.endsWith('_org_membership_grant'))
      .map((name) => readFileSync(join(dir, name, 'migration.sql'), 'utf8'))
      .join('\n');
    expect(sql).toMatch(
      /FOREIGN KEY \("membershipId"\) REFERENCES "org_membership"\("id"\) ON DELETE CASCADE/
    );
  });
});
