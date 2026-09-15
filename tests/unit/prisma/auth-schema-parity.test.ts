/**
 * Parity guard: prisma/schema/auth.prisma vs better-auth's own table definitions.
 *
 * better-auth owns the shape of `user`, `session`, `account` and `verification`;
 * Sunrise owns the migrations that create them. Nothing in the toolchain
 * connects the two — the Prisma adapter never inspects the schema, so a
 * better-auth upgrade that adds a column type-checks, lints, builds, and
 * deploys clean, then fails at the first sign-in against a database that has
 * not grown the column.
 *
 * That is exactly what 0.11.0 shipped. The 1.6.29 → 1.7.1 bump re-keyed account
 * identity from `(providerId, accountId)` to `(issuer, accountId)`, and with no
 * `Account.issuer` column **both** sign-in paths failed closed in production:
 * the Google callback threw `Unknown argument 'issuer'` out of
 * `findAccountOwnerByKey`, and email/password sign-in failed selecting the same
 * column. Dev never saw it — `.test` domains cannot be used with Google, so
 * nobody exercised the callback, and the credential path only broke once
 * `node_modules` actually caught up to the locked version.
 *
 * Then 1.7.3 reverted the re-keying. Identity is `(providerId, accountId)`
 * again, better-auth never writes `issuer`, and the column #672 added to
 * survive 1.7.1 became the opposite defect: a REQUIRED column nothing supplies,
 * which fails every insert into `account` — sign-up, first social sign-in,
 * account link — on the NOT NULL constraint. The same bump, the same silence
 * from the toolchain, the outage one layer down.
 *
 * Both directions are therefore DERIVED, not listed. `getAuthTables()` is
 * better-auth's own schema authority, the same one its CLI generates from, and
 * `diffSchema()` is the comparison its adapters run at init. A future release
 * adding a column fails here on the version bump rather than in production; so
 * does one that stops writing a column this schema still requires. Do not
 * replace either with a hand-written field list — that reintroduces the exact
 * gap it exists to close, one column at a time.
 *
 * Why the second direction lives here and not in better-auth's own init check:
 * since 1.7.3 the Prisma adapter diffs the generated client's
 * `_runtimeDataModel`, and Prisma 7 emits that model in a compact form with no
 * `isRequired`, so the adapter — by its own docblock — "reports missing tables
 * and columns but never a required column". It could not see `issuer`. This
 * test feeds the same `diffSchema()` the Prisma SOURCE, which can.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * A better-auth upgrade changed the auth schema, in one of two directions:
 *
 * - **"missing"** — it now reads a column or index this schema lacks. Add it to
 *   the named model in `prisma/schema/auth.prisma`, then write a migration that
 *   BACKFILLS existing rows — a required column cannot be added bare to a
 *   populated table. Check the release's upgrade guide for the value each
 *   existing row should get; `20260825120000_add_account_issuer` is the worked
 *   example (and `20260915180000_drop_account_issuer` is what removing it
 *   again looked like when 1.7.3 stopped reading it).
 * - **"required but Better Auth never writes it"** — this schema requires a
 *   column the release no longer supplies. Make it optional, give it a default,
 *   or drop it with a migration. Do NOT silence it with
 *   `advanced.database.validateSchema: false` — that hides the finding, not
 *   the constraint violation.
 *
 * @see .context/auth/oauth.md
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getAuthTables } from '@better-auth/core/db';
import {
  diffSchema,
  formatSchemaFinding,
  getExpectedSchema,
  type IntrospectedTable,
} from '@better-auth/core/db/internal';

const SCHEMA_PATH = path.join(process.cwd(), 'prisma/schema/auth.prisma');
const MIGRATION_PATH = path.join(
  process.cwd(),
  'prisma/migrations/20260915180000_drop_account_issuer/migration.sql'
);

/** What better-auth can require of a single column, read off the Prisma field. */
interface ParsedColumn {
  /** `true` when the Prisma type carries `?`. better-auth's `required` is its inverse. */
  optional: boolean;
  /** Inline `@unique`. Table-level `@@unique([one])` is folded in below. */
  unique: boolean;
  /**
   * `@default(...)` or `@updatedAt` — an insert may omit the column. The only
   * thing that stops a required column better-auth never writes from failing
   * every insert, so it is read for the reverse check below.
   */
  hasDefault: boolean;
}

interface ParsedModel {
  /** Prisma model name, e.g. `Account`. */
  name: string;
  /** Column name (honouring `@map`) -> what the schema says about it. */
  columns: Map<string, ParsedColumn>;
  /**
   * Field groups from `@@unique([...])`, as raw Prisma field names — which is
   * what better-auth's `index.fields` is compared against.
   */
  uniques: string[][];
}

/** Parse the model blocks of a Prisma schema, keyed by their `@@map` table name. */
function parseModelsByTable(source: string): Map<string, ParsedModel> {
  const byTable = new Map<string, ParsedModel>();
  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const [, name, body] of source.matchAll(modelBlock)) {
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    const columns = new Map<string, ParsedColumn>();

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      // Skip attributes, comments, blanks, and closing braces.
      if (!line || line.startsWith('@@') || line.startsWith('//')) continue;
      const field = /^(\w+)\s+(\S+)/.exec(line);
      if (!field) continue;
      const [, fieldName, fieldType] = field;
      // A relation field is not a column. `user User @relation(...)` is
      // required and has no default, which the reverse check below would read
      // as a column better-auth never writes — a finding about nothing.
      if (fieldType.endsWith('[]') || /@relation\(/.test(line)) continue;
      columns.set(/@map\("([^"]+)"\)/.exec(line)?.[1] ?? fieldName, {
        optional: fieldType.endsWith('?'),
        unique: /(^|\s)@unique(\s|$|\()/.test(line),
        hasDefault: /(^|\s)@(default\(|updatedAt(\s|$))/.test(line),
      });
    }

    // Not `\]\)` — `@@unique([a, b], map: "…")` is a form this repo already
    // uses, and requiring the close paren would report a present constraint as
    // absent the moment someone pins its name.
    const uniques = [...body.matchAll(/@@unique\(\[([^\]]+)\]/g)].map(([, group]) =>
      group.split(',').map((f) => f.trim())
    );

    // A single-column `@@unique([x])` constrains x exactly as inline `@unique`
    // does, and this schema uses both spellings — `User.email` is table-level,
    // `Session.token` is inline. Fold them together so the check below reads
    // the constraint rather than the syntax.
    for (const [only] of uniques.filter((group) => group.length === 1).map((g) => g)) {
      const column = columns.get(only);
      if (column) column.unique = true;
    }

    byTable.set(table, { name, columns, uniques });
  }

  return byTable;
}

// `{}` asks for better-auth's baseline requirement — the columns it needs from
// any Sunrise database, independent of the additional fields Sunrise layers on
// top in `lib/auth/config.ts`. Extra columns in the schema are fine; missing
// ones are not.
const requiredTables = getAuthTables({});
const parsed = parseModelsByTable(readFileSync(SCHEMA_PATH, 'utf8'));

describe('prisma/schema/auth.prisma satisfies better-auth', () => {
  it('parses the auth schema (guards the parser itself against a syntax change)', () => {
    // If the regexes ever stop matching, every assertion below would vacuously
    // pass on empty sets. Anchor on the models better-auth is known to need.
    expect([...parsed.keys()]).toEqual(
      expect.arrayContaining(['user', 'session', 'account', 'verification'])
    );
    expect(parsed.get('account')?.columns.size).toBeGreaterThan(5);
  });

  describe.each(Object.entries(requiredTables))('%s', (key, table) => {
    const model = parsed.get(table.modelName);

    it('has a model mapped to the table better-auth reads', () => {
      expect(model, `no model maps to table "${table.modelName}"`).toBeDefined();
    });

    // `fieldName` is the column name when it differs from the field key.
    // Presence is only one of the three things better-auth declares per field:
    // a column that exists but is nullable where better-auth requires a value,
    // or non-unique where it requires uniqueness, fails at runtime just as a
    // missing one does. Checking only presence is what would let a release
    // that TIGHTENS an existing column land exactly the way 1.7 did.
    it.each(
      Object.entries(table.fields).map(([field, attr]) => [attr.fieldName ?? field, attr] as const)
    )('declares column %s as better-auth requires', (fieldName, attr) => {
      const column = model?.columns.get(fieldName);
      expect(
        column,
        `${model?.name ?? table.modelName} is missing "${fieldName}", which better-auth ` +
          `${key === 'account' ? 'selects on every sign-in' : 'reads'}. Add the field and a ` +
          `backfilling migration.`
      ).toBeDefined();

      if (attr.required) {
        expect(
          column?.optional,
          `${model?.name ?? table.modelName}.${fieldName} is optional, but better-auth ` +
            `declares it required. Drop the \`?\` and backfill existing rows.`
        ).toBe(false);
      }

      if (attr.unique) {
        expect(
          column?.unique,
          `${model?.name ?? table.modelName}.${fieldName} is not unique, but better-auth ` +
            `declares it unique — it relies on that to keep one row per value. Add ` +
            `\`@unique\` (or \`@@unique([${fieldName}])\`) and de-duplicate first.`
        ).toBe(true);
      }
    });

    for (const index of table.indexes ?? []) {
      if (!index.unique) continue;
      it(`declares @@unique([${index.fields.join(', ')}])`, () => {
        const found = model?.uniques.some(
          (group) =>
            group.length === index.fields.length &&
            index.fields.every((field) => group.includes(field))
        );
        expect(
          found,
          `${model?.name ?? table.modelName} must declare @@unique([${index.fields.join(', ')}]). ` +
            `better-auth relies on it to keep one external identity per subject.`
        ).toBe(true);
      });
    }
  });
});

describe('nothing this schema requires is something better-auth never writes', () => {
  // better-auth's own comparison, fed the input its Prisma adapter cannot get.
  // `IntrospectedTable` is the adapter's shape: one entry per table, columns
  // with nullability and default-ness — which is all `diffSchema` reads.
  const actual: IntrospectedTable[] = [...parsed].map(([table, model]) => ({
    name: table,
    columns: [...model.columns].map(([name, column]) => ({
      name,
      nullable: column.optional,
      hasDefault: column.hasDefault,
    })),
  }));

  it('parsed defaults (guards the parser against a syntax change)', () => {
    // Without this, a parser that stopped seeing `@default(` would report
    // every defaulted column as an unexpected required one and the failure
    // would blame the schema rather than the regex. Anchor on columns known to
    // carry each spelling.
    const user = parsed.get('user');
    expect(user?.columns.get('createdAt')?.hasDefault, '@default(now())').toBe(true);
    expect(user?.columns.get('updatedAt')?.hasDefault, '@updatedAt').toBe(true);
    expect(user?.columns.get('email')?.hasDefault, 'a bare required column').toBe(false);
    // And relation fields are not columns.
    expect(parsed.get('account')?.columns.has('user')).toBe(false);
  });

  it('reports no findings from better-auth’s own diff', () => {
    // `{}` again: options only WIDEN the written set (additional fields,
    // plugins), so the baseline is the stricter input for this direction. A
    // required column that only an additional field writes would fail here
    // and would need this test to pass the real options — say so if it does.
    const findings = diffSchema(getExpectedSchema({}), actual);
    expect(
      findings,
      findings.map((finding) => formatSchemaFinding(finding, 'prisma')).join('\n')
    ).toEqual([]);
  });
});

describe('Account identity is keyed on (providerId, accountId), as in 1.6', () => {
  // The specific regression 0.11.0 shipped and 0.12.0 unshipped, pinned by
  // name so the failure says what broke rather than only which column moved.
  // 1.7.0–1.7.2 keyed identity on `issuer`; 1.7.3 reverted it and better-auth
  // has said the core schema stays stable for the rest of v1. If `issuer`
  // comes back, it comes back through the derived checks above, with a
  // backfill — not by reviving this column.
  it('has no issuer column and no unique index on it', () => {
    const account = parsed.get('account');
    expect(account?.columns.has('issuer')).toBe(false);
    expect(
      account?.uniques.some((group) => group.includes('issuer')),
      'no @@unique may name issuer — the column is gone'
    ).toBe(false);
  });

  it('the drop migration removes the column and the index Prisma actually named', () => {
    // Prisma names a `@@unique([issuer, accountId])` index
    // `account_issuer_accountId_key`; the upstream cleanup recipe drops
    // `account_issuer_accountId_uidx`, which never existed here. A migration
    // that copied the recipe would be a no-op and leave the index in place.
    const migration = readFileSync(MIGRATION_PATH, 'utf8');
    expect(migration).toMatch(/DROP INDEX IF EXISTS "account_issuer_accountId_key"/);
    expect(migration).toMatch(/ALTER TABLE "account" DROP COLUMN IF EXISTS "issuer"/);
  });
});
