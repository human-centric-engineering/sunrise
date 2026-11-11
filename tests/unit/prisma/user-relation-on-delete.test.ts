/**
 * Guard: every relation to `User` says what happens to its rows when the user
 * is erased.
 *
 * Prisma's default `onDelete` is `Restrict`. A relation that leaves it out
 * makes `prisma.user.delete()` throw `P2003` for any user with a row in that
 * table, so erasure fails for exactly the people who used the feature. It has
 * happened twice (`.context/privacy/data-erasure.md`, "Adding a new `User`
 * relation"). The rule:
 *
 * - **`onDelete: Cascade`** for personal data, which goes with the user.
 * - **`onDelete: SetNull`** for retained config, audit or logs, which stay
 *   de-attributed. The relation must be optional (`User?`), or Postgres cannot
 *   null the column and the delete fails all the same.
 *
 * It covers every schema file, core's and every fork tier's, at any depth. A
 * fork relating its model to `User` with a Prisma `@relation`
 * (CUSTOMIZATION.md §5) is held here. A plain `userId` column with no
 * `@relation` is not visible to this guard; its hand-written FK is held by a
 * drift probe in `lib/app/db-drift.ts` instead.
 *
 * @see .context/privacy/data-erasure.md
 */

import { describe, it, expect } from 'vitest';
import { readSchemaFiles, type SchemaFile } from '@/scripts/ci/schema-files';

const BLOCK_OPEN = /^(?:model|view)\s+(\w+)\s*\{/;
/** A field typed `User` or `User?`, with the rest of its line. */
const USER_FIELD = /^\s*(\w+)\s+User(\?)?\s+(.*)$/;
/** The `@relation(...)` attribute's arguments. Field attributes are one line in Prisma. */
const RELATION = /@relation\(([^)]*)\)/;

/** Every relation to `User` that would block or break erasure, as readable lines. */
function unsafeUserRelations(files: SchemaFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    let block: string | null = null;
    for (const raw of file.contents.split('\n')) {
      const open = BLOCK_OPEN.exec(raw);
      if (open) {
        block = open[1];
        continue;
      }
      if (raw.startsWith('}')) {
        block = null;
        continue;
      }
      if (!block) continue;
      // Read the code, not a trailing comment: `// onDelete: Cascade` changes nothing.
      const line = raw.replace(/\/\/.*$/, '');
      const field = USER_FIELD.exec(line);
      if (!field) continue;
      const [, name, optional, rest] = field;
      const relation = RELATION.exec(rest)?.[1];
      // Only the side holding the foreign key (`fields: [...]`) takes `onDelete`.
      if (relation === undefined || !/\bfields\s*:/.test(relation)) continue;
      const onDelete = /\bonDelete\s*:\s*(\w+)/.exec(relation)?.[1];
      const where = `${block}.${name} (prisma/schema/${file.name})`;
      if (onDelete === undefined) {
        problems.push(
          `${where} has no onDelete, so Prisma uses Restrict and erasing the user fails. Add ` +
            `onDelete: Cascade (personal data) or onDelete: SetNull on an optional relation ` +
            `(retained config, audit or logs).`
        );
      } else if (onDelete === 'SetNull' && optional !== '?') {
        problems.push(
          `${where} uses onDelete: SetNull on a required relation, so the column cannot be ` +
            `nulled and erasing the user fails. Make it \`User?\` with a nullable column, or ` +
            `use Cascade.`
        );
      } else if (onDelete !== 'Cascade' && onDelete !== 'SetNull') {
        problems.push(
          `${where} uses onDelete: ${onDelete}, which blocks erasing the user. Use Cascade ` +
            `(personal data) or SetNull on an optional relation (retained config, audit or logs).`
        );
      }
    }
  }
  return problems;
}

describe('relations to User say what erasure does to their rows', () => {
  it('holds for every schema file, core and fork, at any depth', () => {
    expect(unsafeUserRelations(readSchemaFiles())).toEqual([]);
  });

  describe('the rule itself', () => {
    const file = (body: string[]): SchemaFile[] => [
      { name: 'app/widgets.prisma', contents: ['model AppWidget {', ...body, '}'].join('\n') },
    ];

    it('accepts Cascade, SetNull on an optional relation, and the back-relation side', () => {
      expect(
        unsafeUserRelations(
          file([
            '  owner   User  @relation("Owner", fields: [ownerId], references: [id], onDelete: Cascade)',
            '  editor  User? @relation("Editor", fields: [editorId], references: [id], onDelete: SetNull)',
            '  viewers User[] @relation("Viewers")',
          ])
        )
      ).toEqual([]);
    });

    it('rejects a relation with no onDelete, even with one in a comment', () => {
      const v = unsafeUserRelations(
        file(['  user User @relation(fields: [userId], references: [id]) // onDelete: Cascade'])
      );
      expect(v).toEqual([
        expect.stringContaining(
          'AppWidget.user (prisma/schema/app/widgets.prisma) has no onDelete'
        ),
      ]);
    });

    it('rejects SetNull on a required relation', () => {
      const v = unsafeUserRelations(
        file(['  user User @relation(fields: [userId], references: [id], onDelete: SetNull)'])
      );
      expect(v).toEqual([expect.stringContaining('SetNull on a required relation')]);
    });

    it('rejects Restrict and NoAction', () => {
      const v = unsafeUserRelations(
        file([
          '  a User @relation("A", fields: [aId], references: [id], onDelete: Restrict)',
          '  b User @relation("B", fields: [bId], references: [id], onDelete: NoAction)',
        ])
      );
      expect(v).toEqual([
        expect.stringContaining('onDelete: Restrict, which blocks'),
        expect.stringContaining('onDelete: NoAction, which blocks'),
      ]);
    });
  });
});
