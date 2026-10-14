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
 *   • a foreign key to `User`, or a user-id column with no foreign key
 *     (the same column vocabulary the export guard uses), or
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
 * Fork-tier schema files are out of scope until §115 t-804 gives forks a seam
 * to classify their own models; core cannot ask a fork to edit this file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OWNER_CLASSIFICATION,
  ownerClassificationOf,
  personalModels,
  type OwnerClassification,
} from '@/lib/db/owner-classification';

const SCHEMA_DIR = path.join(process.cwd(), 'prisma', 'schema');

/** Sunrise's own schema files — the same allowlist, for the same reason, as export-sources.test.ts. */
const CORE_SCHEMA_FILES = new Set([
  'auth.prisma',
  'base.prisma',
  'mcp.prisma',
  'orchestration-agents.prisma',
  'orchestration-conversations.prisma',
  'orchestration-evaluation.prisma',
  'orchestration-knowledge.prisma',
  'orchestration-ops.prisma',
  'orchestration-providers.prisma',
  'orchestration-workflows.prisma',
  'tenancy.prisma',
  'platform.prisma',
]);

const MODEL_OPEN = /^model\s+(\w+)\s*\{/;
/** `field Target? @relation(... fields: [a, b] ...)` — a relation whose key lives on this model. */
const FK_RELATION = /^\s*(\w+)\s+(\w+)(\?)?\s+@relation\(([^)]*)\)/;
const FK_FIELDS = /\bfields:\s*\[([^\]]*)\]/;
const SCALAR = /^\s*(\w+)\s+(\w+)(\?)?(\s|$)/;
const USER_SCALAR = new Set([
  'userId',
  'createdBy',
  'uploadedBy',
  'ownerId',
  'actorUserId',
  'subjectUserId',
]);

interface Relation {
  target: string;
  optional: boolean;
  keys: string[];
}
interface SchemaModel {
  name: string;
  scalars: Map<string, { type: string; optional: boolean }>;
  relations: Map<string, Relation>;
}

/** Parse model blocks: scalar columns and the foreign-key relations this model holds. */
function parseSchema(texts: string[]): Map<string, SchemaModel> {
  const out = new Map<string, SchemaModel>();
  for (const text of texts) {
    let current: SchemaModel | null = null;
    for (const line of text.split('\n')) {
      const open = MODEL_OPEN.exec(line);
      if (open) {
        current = { name: open[1], scalars: new Map(), relations: new Map() };
        out.set(current.name, current);
        continue;
      }
      if (line.startsWith('}')) {
        current = null;
        continue;
      }
      if (!current || /^\s*(\/\/|@@)/.test(line)) continue;
      const rel = FK_RELATION.exec(line);
      if (rel) {
        const keys = FK_FIELDS.exec(rel[4]);
        if (keys) {
          current.relations.set(rel[1], {
            target: rel[2],
            optional: rel[3] === '?',
            keys: keys[1].split(',').map((k) => k.trim()),
          });
        }
        continue;
      }
      const scalar = SCALAR.exec(line);
      if (scalar && !line.includes('@relation')) {
        current.scalars.set(scalar[1], { type: scalar[2], optional: scalar[3] === '?' });
      }
    }
  }
  return out;
}

function userColumnsOf(model: SchemaModel): Set<string> {
  const cols = new Set<string>();
  for (const rel of model.relations.values()) {
    if (rel.target === 'User') rel.keys.forEach((k) => cols.add(k));
  }
  for (const name of model.scalars.keys()) if (USER_SCALAR.has(name)) cols.add(name);
  return cols;
}

/**
 * Everything wrong with `classification` against `schema`, as messages. Pure,
 * so the rules are exercised on synthetic schemas as well as the real one.
 */
function auditOwnerClassification(
  schema: Map<string, SchemaModel>,
  classification: Record<string, OwnerClassification>
): string[] {
  const problems: string[] = [];
  const personal = new Set(
    Object.entries(classification)
      .filter(([, c]) => c.kind === 'personal')
      .map(([m]) => m)
  );

  const required = new Set<string>();
  for (const model of schema.values()) {
    if (userColumnsOf(model).size > 0) required.add(model.name);
    for (const rel of model.relations.values()) {
      if (personal.has(rel.target) && rel.target !== model.name) required.add(model.name);
    }
  }

  for (const name of [...required].sort()) {
    if (!(name in classification)) {
      problems.push(`${name} links to a user or to a personal model and is not classified`);
    }
  }

  for (const [name, c] of Object.entries(classification)) {
    const model = schema.get(name);
    if (!model) {
      problems.push(`${name} is classified but is not a model in the schema`);
      continue;
    }
    if (!required.has(name)) {
      problems.push(`${name} is classified but links to no user and no personal model`);
    }
    if (c.kind === 'not-personal') {
      if (!c.because.trim()) problems.push(`${name} is not-personal with no reason`);
      continue;
    }

    let ownerOptional: boolean;
    if ('column' in c.owner) {
      const column = c.owner.column;
      if (!userColumnsOf(model).has(column)) {
        problems.push(`${name}.${column} is not a user column on ${name}`);
        continue;
      }
      ownerOptional = model.scalars.get(column)?.optional ?? false;
    } else {
      const { field, parent } = c.owner.through;
      const rel = model.relations.get(field);
      if (!rel || rel.target !== parent) {
        problems.push(`${name}.${field} is not a foreign-key relation to ${parent}`);
        continue;
      }
      if (!personal.has(parent)) {
        problems.push(`${name} is personal through ${parent}, which is not personal`);
        continue;
      }
      ownerOptional = rel.optional;
    }

    if (c.ownerless && !ownerOptional) {
      problems.push(`${name} declares an ownerless arm but its owner can never be missing`);
    }
    if (!c.ownerless && ownerOptional) {
      problems.push(
        `${name}'s owner can be missing but it declares no ownerless arm, so its ownerless rows are readable by no narrowed caller`
      );
    }
    for (const col of ['isSystem', 'isTemplate']) {
      if (model.scalars.has(col))
        problems.push(`${name} is personal but carries platform-row column ${col}`);
    }
    if (model.scalars.get('scope')?.type === 'String') {
      problems.push(`${name} is personal but carries a platform-row scope column`);
    }
  }
  return problems;
}

function coreSchema(): Map<string, SchemaModel> {
  const files = readdirSync(SCHEMA_DIR).filter((f) => CORE_SCHEMA_FILES.has(f));
  return parseSchema(files.map((f) => readFileSync(path.join(SCHEMA_DIR, f), 'utf8')));
}

describe('owner classification', () => {
  const schema = coreSchema();
  const classification = OWNER_CLASSIFICATION as Record<string, OwnerClassification>;

  it('reads the core schema', () => {
    // Every core file listed is present, so a renamed file cannot quietly drop its models.
    const present = new Set(readdirSync(SCHEMA_DIR));
    for (const f of CORE_SCHEMA_FILES) expect(present.has(f), `${f} is missing`).toBe(true);
    expect(schema.get('AiConversation')?.relations.get('user')?.target).toBe('User');
  });

  it('classifies every owner-carrying model, each consistently with the schema', () => {
    expect(
      auditOwnerClassification(schema, classification),
      'Fix lib/db/owner-classification.ts — never by deleting a row (see its header).'
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
  });
});
