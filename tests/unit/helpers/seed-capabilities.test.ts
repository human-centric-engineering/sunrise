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

describe('scanCapabilitySeeds — identifier functionDefinition (#646)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seed-scan-'));
    writeFileSync(join(dir, '900-withdraw-task.ts'), HOISTED_IMPL_SEED);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sees the upsert itself', () => {
    const { upserts } = scanCapabilitySeeds(dir);
    expect(upserts).toEqual([
      {
        file: '900-withdraw-task.ts',
        slug: 'withdraw_task',
        update: ['isSystem', 'executionType', 'executionHandler', 'functionDefinition'],
      },
    ]);
  });

  it('either names the capability or reports it as unparseable — never neither', () => {
    const { definedNames, unparseable } = scanCapabilitySeeds(dir);
    const seen =
      definedNames.includes('withdraw_task') ||
      unparseable.some((u) => u.file === '900-withdraw-task.ts');
    expect(seen).toBe(true);
  });
});
