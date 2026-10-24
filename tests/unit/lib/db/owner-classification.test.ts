/**
 * Coverage guard: every owner-carrying model is classified (§115 t-800)
 *
 * `lib/db/owner-classification.ts` is what §115's data-layer assertion reads to
 * decide which models it guards and how each row's owner is reached. A model
 * missing from it is a model the assertion will not guard — silently — so the
 * list is derived from the schema and checked against it here, the way
 * `export-sources.test.ts` checks the subject-access manifest.
 *
 * A model must be classified when it has:
 *   • a foreign key to `User`, or a user-id column with no foreign key:
 *     `userId`, `createdBy`, `uploadedBy`, `ownerId`, any `String` named
 *     `…UserId`, or a field under a `/// owner-classification: user-id` doc
 *     line (for a user id named any other way), or
 *   • a foreign key to a model classified personal — a child of a private row
 *     is either private through it, or says why not.
 *
 * And every classification must match the schema: a `column` owner is a user
 * column on the model, a `through` owner is a foreign-key relation to a
 * personal parent, an `ownerless` arm sits on an owner that can be missing —
 * and an owner that can be missing declares one (t-801: otherwise its
 * ownerless rows are readable by no narrowed caller, silently) — and no
 * personal model carries the platform-row columns of §116. A `through` child
 * whose relation is required inherits its parent's arms, so it needs none.
 *
 * If this test names a model you just added, decide whether its rows are
 * private to one person (routes scope reads to the owner) or record who did
 * something (say why, in `because`). Never delete a row to go green.
 *
 * ---------------------------------------------------------------------------
 * FORK NOTE — your schema files are checked too, against your own seam
 * ---------------------------------------------------------------------------
 * Every schema file that is not one of Sunrise's own (`CORE_SCHEMA_FILES`
 * below) — `app.prisma`, `framework-*.prisma`, whatever you named it — is
 * audited by the same rules, against core's classification merged with what
 * your tier registers through `registerAppOwnerClassification()` from
 * `lib/app/owner-classification.ts` (t-807). This file reads that seam for
 * real, through the registry's lazy init: classify a user-linked model there
 * and the failure here clears, with nothing in this file to edit. The fork-tier
 * fixtures, and the proof the readers are neutral with nothing registered, are
 * in `owner-classification-fork.test.ts`, which mocks the seam empty so that
 * filling yours does not fail them.
 */
import { readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allOwnerClassifications,
  appOwnerClassifications,
  ownerClassificationOf,
  personalModels,
  __resetAppOwnerClassificationForTests,
} from '@/lib/db/owner-classification';
import {
  CORE_SCHEMA_FILES,
  SCHEMA_DIR,
  auditOwnerClassification,
  fullSchema,
  parseSchema,
} from '@/tests/helpers/owner-classification-audit';

/** The models a fork tier has classified, for the audit's fork-only rules. */
const forkRows = () => new Set(Object.keys(appOwnerClassifications()));

describe('owner classification', () => {
  const schema = fullSchema();

  beforeEach(() => {
    // Drive the REAL seam: the lazy init runs against
    // `lib/app/owner-classification.ts` as shipped (or as your fork filled it).
    __resetAppOwnerClassificationForTests();
  });

  it('reads the core schema', () => {
    // Every core file listed is present, so a renamed file cannot quietly drop its models.
    const present = new Set(readdirSync(SCHEMA_DIR));
    for (const f of CORE_SCHEMA_FILES) expect(present.has(f), `${f} is missing`).toBe(true);
    expect(schema.get('AiConversation')?.relations.get('user')?.target).toBe('User');
  });

  it('classifies every owner-carrying model, each consistently with the schema', () => {
    expect(
      auditOwnerClassification(schema, allOwnerClassifications(), forkRows()),
      'Fix lib/db/owner-classification.ts for a core model, or classify a fork model through ' +
        'lib/app/owner-classification.ts — never by deleting a row (see its header).'
    ).toEqual([]);
  });

  it('guards the models the plan names, through the paths the routes use', () => {
    expect(ownerClassificationOf('AiConversation')).toMatchObject({
      kind: 'personal',
      owner: { column: 'userId' },
      ownerless: 'conversation',
      alsoVisible: ['active-share'],
    });
    expect(ownerClassificationOf('AiMessage')).toMatchObject({
      owner: { through: { field: 'conversation', parent: 'AiConversation' } },
    });
    expect(ownerClassificationOf('AiWorkflowExecution')).toMatchObject({
      kind: 'personal',
      ownerless: 'execution',
    });
    expect(ownerClassificationOf('AiUserMemory')?.kind).toBe('personal');
    // §105's exemplar: webhook subscriptions are owner-scoped at the routes, so
    // the backup exporter's org-wide read must be an admitted crossing.
    expect(ownerClassificationOf('AiWebhookSubscription')).toMatchObject({
      kind: 'personal',
      owner: { column: 'createdBy' },
    });
    expect(ownerClassificationOf('AiAgent')?.kind).toBe('not-personal');
    expect(ownerClassificationOf('Org')).toBeNull();
    expect(personalModels()).toContain('AiConversation');
    expect(personalModels()).not.toContain('AiCostLog');
  });

  describe('the audit itself', () => {
    const base = `
model User {
  id String @id
}
model Thread {
  id     String  @id
  userId String?
  user   User?   @relation(fields: [userId], references: [id])
  isSystem Boolean
}
model Post {
  id       String @id
  threadId String
  thread   Thread @relation(fields: [threadId], references: [id])
}
`;
    const fixture = parseSchema([base]);

    it('names a model linked to a user that nobody classified', () => {
      expect(auditOwnerClassification(fixture, {})).toEqual([
        'Thread links to a user or to a personal model and is not classified',
      ]);
    });

    it('then names the child of a personal model, and the platform-row column', () => {
      const problems = auditOwnerClassification(fixture, {
        Thread: { kind: 'personal', owner: { column: 'userId' }, ownerless: 'conversation' },
      });
      expect(problems).toContain(
        'Post links to a user or to a personal model and is not classified'
      );
      expect(problems).toContain('Thread is personal but carries platform-row column isSystem');
    });

    it('rejects a path the schema does not have, and an ownerless arm on a required owner', () => {
      const problems = auditOwnerClassification(fixture, {
        Thread: { kind: 'personal', owner: { column: 'createdBy' } },
        Post: {
          kind: 'personal',
          owner: { through: { field: 'thread', parent: 'Thread' } },
          ownerless: 'dataset',
        },
      });
      expect(problems).toContain('Thread.createdBy is not a user column on Thread');
      expect(problems).toContain(
        'Post declares an ownerless arm but its owner can never be missing'
      );
    });

    it('rejects an owner that can be missing with no ownerless arm', () => {
      const problems = auditOwnerClassification(fixture, {
        Thread: { kind: 'personal', owner: { column: 'userId' } },
        Post: { kind: 'personal', owner: { through: { field: 'thread', parent: 'Thread' } } },
      });
      expect(problems).toContain(
        "Thread's owner can be missing but it declares no ownerless arm, so its ownerless rows are readable by no narrowed caller"
      );
      // Post's relation is required: it inherits Thread's arms and needs none.
      expect(problems.some((p) => p.startsWith("Post's owner"))).toBe(false);
    });

    it('rejects a stale row and a through-path to a parent that is not personal', () => {
      const problems = auditOwnerClassification(fixture, {
        Thread: { kind: 'not-personal', because: 'authorship' },
        Post: { kind: 'personal', owner: { through: { field: 'thread', parent: 'Thread' } } },
        Gone: { kind: 'not-personal', because: 'x' },
      });
      expect(problems).toContain('Gone is classified but is not a model in the schema');
      expect(problems).toContain('Post is personal through Thread, which is not personal');
    });

    describe('which columns hold a user id', () => {
      const columns = parseSchema([
        `
model User {
  id String @id
}
model Session {
  id               String  @id
  respondentUserId String?
}
model Meeting {
  id String @id
  /// Who ran the meeting.
  /// owner-classification: user-id
  facilitator String
}
model Note {
  id       String @id
  authorId String // a user id, but kept off @relation on purpose
}
model Lease {
  id       String  @id
  lockedBy String?
  homepage String  @default("https://example.com") // not a @relation
}
model Ticket {
  id        String  @id
  /// owner-classification: user-id
  assignee  String?
  // The marker above covers assignee only.
  watcher   String?
  reporterUserId Int
}
model Thread {
  id     String  @id
  userId String?
  user   User?   @relation(fields: [userId], references: [id]) // the real link
}
model SlackUser {
  id String @id
}
model SlackLink {
  id          String    @id
  slackUserId String
  slackUser   SlackUser @relation(fields: [slackUserId], references: [id])
  /// owner-classification: user-id
  @@index([slackUserId])
  label       String    @default("a \\"quoted\\" // label") // not a @relation
}
`,
      ]);

      it('asks about a model whose user column is named for its role or marked', () => {
        const problems = auditOwnerClassification(columns, {});
        for (const model of ['Session', 'Meeting', 'Ticket', 'Thread']) {
          expect(problems).toContain(
            `${model} links to a user or to a personal model and is not classified`
          );
        }
        // A lease holder, a URL default, a comment mentioning @relation, a key of a
        // relation to another model and a marker spent on a block attribute are not user links.
        for (const model of ['Note', 'Lease', 'SlackLink']) {
          expect(problems.some((p) => p.startsWith(`${model} `))).toBe(false);
        }
      });

      it('accepts those columns as owners, and nothing the marker or suffix does not cover', () => {
        const problems = auditOwnerClassification(columns, {
          Session: { kind: 'not-personal', because: 'who answered' },
          Meeting: { kind: 'personal', owner: { column: 'facilitator' } },
          Ticket: { kind: 'personal', owner: { column: 'watcher' }, ownerless: 'conversation' },
          Thread: { kind: 'not-personal', because: 'authorship' },
          Lease: { kind: 'not-personal', because: 'worker lease' },
        });
        expect(problems).not.toContain(
          'Session is classified but links to no user and no personal model'
        );
        expect(problems.some((p) => p.startsWith('Meeting'))).toBe(false);
        // The marker covered assignee, not watcher; reporterUserId is not a String.
        expect(problems).toContain('Ticket.watcher is not a user column on Ticket');
        expect(problems).toContain(
          'Lease is classified but links to no user and no personal model'
        );
      });

      it('still reads the scalar behind a comment and the relation behind its key', () => {
        expect(columns.get('Note')?.scalars.get('authorId')).toMatchObject({ type: 'String' });
        expect(columns.get('Lease')?.scalars.has('homepage')).toBe(true);
        expect(columns.get('SlackLink')?.scalars.get('label')).toMatchObject({
          type: 'String',
          userMarked: false,
        });
        expect(columns.get('Thread')?.relations.get('user')).toMatchObject({
          target: 'User',
          keys: ['userId'],
        });
        expect(columns.get('Thread')?.scalars.has('user')).toBe(false);
      });
    });
  });
});
