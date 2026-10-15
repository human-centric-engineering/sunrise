/**
 * The seed scanner must see a capability whose `functionDefinition` is an
 * identifier rather than an inline literal (#646).
 *
 * A seed that hoists the code-owned half into a `*_IMPL` const — the shape
 * #545's "re-apply on the update branch" guidance encourages — contributed no
 * name to `definedNames` and nothing to `unparseable`, so
 * `capability-class-seed-parity`'s completeness check passed over it in
 * silence.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanCapabilitySeeds } from '@/tests/helpers/seed-capabilities';

const HOISTED_IMPL_SEED = `
const withdrawTaskFunctionDefinition = {
  name: 'withdraw_task',
  description: 'Withdraw a task.',
  parameters: { type: 'object', properties: { name: { type: 'string' } } },
};

const WITHDRAW_TASK_IMPL = {
  executionType: 'internal',
  executionHandler: 'WithdrawTaskCapability',
  functionDefinition: withdrawTaskFunctionDefinition,
};

export async function run(prisma) {
  await prisma.aiCapability.upsert({
    where: { slug: 'withdraw_task' },
    update: { isSystem: true, ...WITHDRAW_TASK_IMPL },
    create: { slug: 'withdraw_task', ...WITHDRAW_TASK_IMPL, isActive: true, isSystem: true },
  });
}
`;

function upsertSeed(update: string): string {
  return `
export async function run(prisma) {
  for (const cap of ALL) {
    await prisma.aiCapability.upsert({
      where: { slug: cap.slug },
      update: { isSystem: true, ${update} },
      create: { slug: cap.slug, isActive: true, isSystem: true, ${update} },
    });
  }
}
`;
}

describe('scanCapabilitySeeds — identifier functionDefinition (#646)', () => {
  let dir: string;
  const write = (name: string, src: string) => writeFileSync(join(dir, name), src);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seed-scan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sees the upsert itself', () => {
    write('900-withdraw-task.ts', HOISTED_IMPL_SEED);
    const { upserts } = scanCapabilitySeeds(dir);
    expect(upserts).toEqual([
      {
        file: '900-withdraw-task.ts',
        slug: 'withdraw_task',
        update: ['isSystem', 'executionType', 'executionHandler', 'functionDefinition'],
      },
    ]);
  });

  it('names a capability whose definition is a same-file const', () => {
    write('900-withdraw-task.ts', HOISTED_IMPL_SEED);
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definitions).toEqual([{ file: '900-withdraw-task.ts', name: 'withdraw_task' }]);
    expect(scan.definedNames).toEqual(['withdraw_task']);
    expect(scan.opaqueDefinitions).toEqual([]);
    expect(scan.unparseable).toEqual([]);
  });

  it('names the shorthand `{ functionDefinition }` form', () => {
    write(
      '901-shorthand.ts',
      `const functionDefinition = { name: 'short_hand', parameters: {} };
const IMPL = { executionType: 'internal', functionDefinition };
${upsertSeed('...IMPL')}`
    );
    expect(scanCapabilitySeeds(dir).definedNames).toEqual(['short_hand']);
  });

  it('reports an imported definition as opaque instead of dropping it', () => {
    write(
      '902-imported.ts',
      `import { taskDefinition } from '@/lib/tasks/definition';
const IMPL = { executionType: 'internal', functionDefinition: taskDefinition };
${upsertSeed('...IMPL')}`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual([]);
    expect(scan.opaqueDefinitions).toEqual([{ file: '902-imported.ts', expr: 'taskDefinition' }]);
  });

  it('reports a const whose name is computed (the old 019 shape) as opaque', () => {
    write(
      '903-computed.ts',
      `${upsertSeed('...codeOwned')}
const functionDefinition: Prisma.InputJsonValue = { name: cap.slug, parameters: {} };
const codeOwned = { executionType: 'internal', functionDefinition: functionDefinition };`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual([]);
    expect(scan.opaqueDefinitions).toEqual([
      { file: '903-computed.ts', expr: 'functionDefinition' },
    ]);
  });

  it('reports a definition read off a class instance as opaque', () => {
    write(
      '904-instance.ts',
      `const codeOwned = { executionType: 'internal', functionDefinition: cap.capability.functionDefinition };
${upsertSeed('...codeOwned')}`
    );
    expect(scanCapabilitySeeds(dir).opaqueDefinitions).toEqual([
      { file: '904-instance.ts', expr: 'cap.capability.functionDefinition' },
    ]);
  });

  it('does not read a type-only field as a definition', () => {
    write(
      '905-typed.ts',
      `interface Cap { slug: string; functionDefinition: CapabilityFunctionDefinition }
type Row = { functionDefinition: Prisma.InputJsonValue };
const IMPL = { executionType: 'internal', functionDefinition: { name: 'typed_one', parameters: {} } };
${upsertSeed('...IMPL')}`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual(['typed_one']);
    expect(scan.opaqueDefinitions).toEqual([]);
  });

  it('names a same-file const behind an `as` cast', () => {
    write(
      '906-cast.ts',
      `const FOO_DEF = { name: 'foo_cast', parameters: {} };
const IMPL = { executionType: 'internal', functionDefinition: FOO_DEF as Prisma.InputJsonValue };
${upsertSeed('...IMPL')}`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual(['foo_cast']);
    expect(scan.opaqueDefinitions).toEqual([]);
  });

  it('names a const whose identifier contains `$`', () => {
    write(
      '907-dollar.ts',
      `const DEF$ = { name: 'dollar_def', parameters: {} };
const IMPL$ = { executionType: 'internal', functionDefinition: DEF$ };
${upsertSeed('...IMPL$')}`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual(['dollar_def']);
    expect(scan.unparseable).toEqual([]);
  });

  it('reports a name shared by consts in two scopes as opaque rather than guessing', () => {
    write(
      '908-scopes.ts',
      `function one() { const def = { name: 'first_cap' }; return { functionDefinition: def }; }
function two() { const def = { name: 'second_cap' }; return { functionDefinition: def }; }
${upsertSeed('isActive: true')}`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual([]);
    expect(scan.opaqueDefinitions).toEqual([
      { file: '908-scopes.ts', expr: 'def' },
      { file: '908-scopes.ts', expr: 'def' },
    ]);
  });

  it('does not read a destructuring as a shorthand definition', () => {
    write(
      '909-destructure.ts',
      `const DEF = { name: 'destructured', parameters: {} };
for (const { functionDefinition } of [{ functionDefinition: DEF }]) {
  ${upsertSeed('functionDefinition').trim()}
}`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual(['destructured']);
    expect(scan.opaqueDefinitions.filter((o) => o.expr === 'functionDefinition')).toEqual([
      { file: '909-destructure.ts', expr: 'functionDefinition' },
      { file: '909-destructure.ts', expr: 'functionDefinition' },
    ]);
  });

  it('does not split an identifier that merely ends in `as`', () => {
    write(
      '910-suffix.ts',
      `const foo = { name: 'wrong_one', parameters: {} };
const IMPL = { executionType: 'internal', functionDefinition: fooas.def };
${upsertSeed('...IMPL')}`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual([]);
    expect(scan.opaqueDefinitions).toEqual([{ file: '910-suffix.ts', expr: 'fooas.def' }]);
  });

  it.each([
    ['an arrow parameter', 'rows.map(({ functionDefinition }) => functionDefinition);'],
    [
      'a long multi-line destructuring',
      `const {
  slug,
  name,
  description,
  executionType,
  executionHandler,
  category,
  functionDefinition,
} = row;`,
    ],
    ['a renaming destructuring', 'const { functionDefinition: fd } = row;'],
    [
      'a query select',
      'prisma.aiCapability.findMany({ select: { slug: true, functionDefinition: true } });',
    ],
    [
      'a query filter',
      'prisma.aiCapability.findMany({ where: { functionDefinition: Prisma.JsonNull } });',
    ],
  ])('does not read %s as a definition', (_label, code) => {
    write(
      '911-reads.ts',
      `const IMPL = { executionType: 'internal', functionDefinition: { name: 'only_one', parameters: {} } };
${code}
${upsertSeed('...IMPL')}`
    );
    const scan = scanCapabilitySeeds(dir);
    expect(scan.definedNames).toEqual(['only_one']);
    expect(scan.opaqueDefinitions).toEqual([]);
  });
});
