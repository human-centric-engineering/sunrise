/**
 * Tests: the scrubbed-column write detector behind the stale-writer manifest
 * (§122 t-887).
 *
 * Each case is a source shape, and what the scanner must report for it. The
 * negative cases matter as much: a write to a column erasure does not touch
 * cannot put a person back, and a manifest full of those is a manifest nobody
 * reads.
 *
 * @see scripts/ci/scrubbed-column-writes.ts
 */

import { describe, it, expect } from 'vitest';
import { createScanner, relationsOf } from '@/scripts/ci/scrubbed-column-writes';
import type { ScrubbedModel } from '@/lib/privacy/stale-writers';

const SCRUBBED: ScrubbedModel[] = [
  { model: 'AiWorkflow', table: 'ai_workflow', columns: ['draftDefinition'] },
  { model: 'AiWorkflowVersion', table: 'ai_workflow_version', columns: ['snapshot'] },
  {
    model: 'AiWorkflowExecution',
    table: 'ai_workflow_execution',
    columns: ['inputData', 'errorMessage'],
  },
];

const SCHEMA = `
model AiWorkflow {
  id               String @id
  draftDefinition  Json?
  versions         AiWorkflowVersion[] @relation("WorkflowVersions")
}

model AiWorkflowVersion {
  id         String @id
  snapshot   Json
  workflow   AiWorkflow @relation("WorkflowVersions", fields: [workflowId], references: [id])
}

model AiAgent {
  id        String @id
  versions  AiAgentVersion[]
}

model AiAgentVersion {
  id        String @id
}

model AiWorkflowExecution {
  id            String @id
  inputData     Json
  errorMessage  String?
  status        String
}
`;

const { scan } = createScanner(SCRUBBED, relationsOf([SCHEMA]));

/** `model:via` for each write found in `source`. */
function found(source: string): string[] {
  return scan({ path: 'lib/fixture.ts', source })
    .map((w) => `${w.model}:${w.via}`)
    .sort();
}

describe('Prisma writes', () => {
  it('reports a write to a scrubbed column, on any receiver', () => {
    expect(found(`prisma.aiWorkflow.update({ where, data: { draftDefinition: d } })`)).toEqual([
      'AiWorkflow:prisma',
    ]);
    expect(found(`tx?.aiWorkflowVersion.create({ data: { snapshot } })`)).toEqual([
      'AiWorkflowVersion:prisma',
    ]);
    expect(
      found(`db['aiWorkflow'].upsert({ where, create: {}, update: { draftDefinition } })`)
    ).toEqual(['AiWorkflow:prisma']);
  });

  it('ignores a write that touches only other columns', () => {
    expect(
      found(`prisma.aiWorkflowExecution.updateMany({ where, data: { status: 'x' } })`)
    ).toEqual([]);
  });

  it('ignores reads and deletes', () => {
    expect(
      found(`prisma.aiWorkflow.findMany({ where }); prisma.aiWorkflow.delete({ where })`)
    ).toEqual([]);
  });

  it('reads both arms of a conditional spread', () => {
    expect(
      found(
        `tx.aiWorkflowExecution.update({ where, data: { status, ...(c ? { leaseToken } : {}) } })`
      )
    ).toEqual([]);
    expect(
      found(
        `tx.aiWorkflowExecution.update({ where, data: { status, ...(c ? {} : { errorMessage }) } })`
      )
    ).toEqual(['AiWorkflowExecution:prisma']);
  });

  it('counts a write whose columns cannot be read', () => {
    expect(found(`prisma.aiWorkflowExecution.update({ where, data: patch })`)).toEqual([
      'AiWorkflowExecution:prisma',
    ]);
    expect(found(`prisma.aiWorkflowExecution.update({ where, data: { ...patch } })`)).toEqual([
      'AiWorkflowExecution:prisma',
    ]);
    expect(found(`prisma.aiWorkflowExecution.update(args)`)).toEqual([
      'AiWorkflowExecution:prisma',
    ]);
  });

  it('follows a local const used only as a write argument', () => {
    const claim = `
      const claim = { where, data: { status: 'claimed' } };
      await prisma.aiWorkflowExecution.updateMany(claim);
      await tx.aiWorkflowExecution.updateMany(claim);
    `;
    expect(found(claim)).toEqual([]);
  });

  it('follows a const passed as the shorthand `{ where, data }`', () => {
    const shorthand = `
      const data = { status: 'x' };
      await prisma.aiWorkflowExecution.update({ where, data });
    `;
    expect(found(shorthand)).toEqual([]);
  });

  it('does not follow a const that is changed after it is declared', () => {
    // How the settings route builds its write: the literal is empty.
    const mutated = `
      const data = {};
      data.errorMessage = body.reason;
      await prisma.aiWorkflowExecution.update({ where, data });
    `;
    expect(found(mutated)).toEqual(['AiWorkflowExecution:prisma']);
  });
});

describe('nested writes', () => {
  it('reports a write through a relation to a scrubbed model', () => {
    expect(
      found(`prisma.aiWorkflow.create({ data: { name, versions: { create: { snapshot } } } })`)
    ).toEqual(['AiWorkflowVersion:nested']);
  });

  it('reads the relation on the parent model, not the field name alone', () => {
    // AiAgent.versions is AiAgentVersion, which erasure does not scrub.
    expect(
      found(`prisma.aiAgent.create({ data: { versions: { create: { snapshot } } } })`)
    ).toEqual([]);
  });

  it('ignores a relation that is only read, under include, select or where', () => {
    expect(
      found(
        `prisma.aiWorkflow.update({ where: { versions: filt }, data: { name }, include: { versions: true } })`
      )
    ).toEqual([]);
  });

  it('ignores a relation that is only connected', () => {
    expect(
      found(
        `prisma.aiWorkflowVersion.create({ data: { snapshot, workflow: { connect: { id } } } })`
      )
    ).toEqual(['AiWorkflowVersion:prisma']);
  });
});

describe('raw SQL', () => {
  it('reports UPDATE, INSERT INTO and MERGE INTO on a scrubbed table', () => {
    expect(found('tx.$executeRaw`UPDATE ai_workflow SET x = 1`')).toEqual(['AiWorkflow:sql']);
    expect(
      found('db.$executeRawUnsafe(\'insert into "public"."ai_workflow_version" (id) values ($1)\')')
    ).toEqual(['AiWorkflowVersion:sql']);
    expect(found('tx.$executeRaw`MERGE INTO\n  ai_workflow_execution AS e USING ...`')).toEqual([
      'AiWorkflowExecution:sql',
    ]);
  });

  it('reads SQL in any case, and UPDATE ONLY', () => {
    expect(found('tx.$executeRaw`UPDATE AI_WORKFLOW SET x = 1`')).toEqual(['AiWorkflow:sql']);
    expect(found('tx.$executeRaw`update only ai_workflow set x = 1`')).toEqual(['AiWorkflow:sql']);
  });

  it('ignores a read', () => {
    expect(found('tx.$queryRaw`SELECT id FROM ai_workflow FOR UPDATE`')).toEqual([]);
  });

  it('reports a write to a table named through Prisma.raw', () => {
    const viaRaw = `
      const t = Prisma.raw('ai_workflow_execution');
      await tx.$executeRaw\`UPDATE \${t} AS e SET "inputData" = '{}'\`;
    `;
    expect(found(viaRaw)).toEqual(['AiWorkflowExecution:sql']);
  });

  it('reports a write to a table held in a const, a quoted name or an argument', () => {
    const viaConst = `
      const T = '"ai_workflow_execution"';
      await db.$executeRawUnsafe(\`UPDATE \${T} SET "inputData" = '{}'\`);
    `;
    expect(found(viaConst)).toEqual(['AiWorkflowExecution:sql']);
    const viaArgument = `
      async function seed(table: 'ai_workflow' | 'ai_workflow_version') {
        await db.$executeRawUnsafe(\`INSERT INTO \${table} (id) VALUES ($1)\`, id);
      }
    `;
    expect(found(viaArgument)).toEqual(['AiWorkflow:sql', 'AiWorkflowVersion:sql']);
  });

  it('does not report a Prisma.raw table that is only read', () => {
    const readOnly = `
      const t = Prisma.raw('ai_workflow_execution');
      await tx.$queryRaw\`SELECT id FROM \${t}\`;
    `;
    expect(found(readOnly)).toEqual([]);
  });
});

describe('delegates the scan cannot follow', () => {
  it('reports a stored, destructured or passed delegate as unresolved', () => {
    expect(found(`const d = tx.aiWorkflow;`)).toEqual(['AiWorkflow:unresolved']);
    expect(found(`const { aiWorkflowVersion } = prisma;`)).toEqual([
      'AiWorkflowVersion:unresolved',
    ]);
    expect(found(`run(prisma.aiWorkflowExecution);`)).toEqual(['AiWorkflowExecution:unresolved']);
  });

  it('does not count a model named in a type', () => {
    expect(found(`type C = Pick<Prisma.TransactionClient, 'aiWorkflow'>;`)).toEqual([]);
  });

  it('lets a definite write outrank an unresolved reference to the same model', () => {
    expect(
      found(
        `const d = tx.aiWorkflow; await tx.aiWorkflow.update({ where, data: { draftDefinition } });`
      )
    ).toEqual(['AiWorkflow:prisma']);
  });
});

describe('relationsOf', () => {
  it('maps each parent model’s relation fields to the model they point at', () => {
    const relations = relationsOf([SCHEMA]);
    expect(relations.get('AiWorkflow')?.get('versions')).toBe('AiWorkflowVersion');
    expect(relations.get('AiAgent')?.get('versions')).toBe('AiAgentVersion');
    // A scalar field is not a relation.
    expect(relations.get('AiWorkflow')?.has('draftDefinition')).toBe(false);
  });
});
