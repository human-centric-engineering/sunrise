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
 * The requirement is therefore DERIVED, not listed: `getAuthTables()` is
 * better-auth's own schema authority, the same one its CLI generates from. A
 * future release adding another column fails this test on the version bump
 * rather than in production. Do not replace it with a hand-written field list —
 * that reintroduces the exact gap it exists to close, one column at a time.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * A better-auth upgrade changed the auth schema. Add the reported column(s) or
 * index to the named model in `prisma/schema/auth.prisma`, then write a
 * migration that BACKFILLS existing rows — a required column cannot be added
 * bare to a populated table. Check the release's upgrade guide for the value
 * each existing row should get; `20260825120000_add_account_issuer` is the
 * worked example.
 *
 * @see .context/auth/oauth.md
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getAuthTables } from '@better-auth/core/db';

const SCHEMA_PATH = path.join(process.cwd(), 'prisma/schema/auth.prisma');

interface ParsedModel {
  /** Prisma model name, e.g. `Account`. */
  name: string;
  /** Database column names, honouring `@map`. */
  columns: Set<string>;
  /** Field groups from `@@unique([...])`, each normalised to column names. */
  uniques: string[][];
}

/** Parse the model blocks of a Prisma schema, keyed by their `@@map` table name. */
function parseModelsByTable(source: string): Map<string, ParsedModel> {
  const byTable = new Map<string, ParsedModel>();
  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const [, name, body] of source.matchAll(modelBlock)) {
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    const columns = new Set<string>();

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      // Skip attributes, comments, blanks, and closing braces.
      if (!line || line.startsWith('@@') || line.startsWith('//')) continue;
      const field = /^(\w+)\s+\S/.exec(line)?.[1];
      if (!field) continue;
      columns.add(/@map\("([^"]+)"\)/.exec(line)?.[1] ?? field);
    }

    const uniques = [...body.matchAll(/@@unique\(\[([^\]]+)\]\)/g)].map(([, group]) =>
      group.split(',').map((f) => f.trim())
    );

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
    it.each(Object.entries(table.fields).map(([field, attr]) => attr.fieldName ?? field))(
      'declares column %s',
      (fieldName) => {
        expect(
          model?.columns.has(fieldName),
          `${model?.name ?? table.modelName} is missing "${fieldName}", which better-auth ` +
            `${key === 'account' ? 'selects on every sign-in' : 'reads'}. Add the field and a ` +
            `backfilling migration.`
        ).toBe(true);
      }
    );

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

describe('Account identity is keyed on (issuer, accountId)', () => {
  // The specific regression 0.11.0 shipped, pinned by name so the failure says
  // what broke rather than only which column is absent.
  it('has issuer, and does not key identity on providerId', () => {
    const account = parsed.get('account');
    expect(account?.columns.has('issuer')).toBe(true);
    expect(account?.uniques).toContainEqual(['issuer', 'accountId']);
    expect(
      account?.uniques.some((group) => group.includes('providerId')),
      'providerId is local configuration in better-auth >= 1.7, never an identity key'
    ).toBe(false);
  });
});
