/**
 * Tests for the Prisma format check CLI.
 *
 * The rules are covered against real files in `prisma-format.test.ts`; this
 * file covers only the wiring — that the entry point checks the platform's
 * schema directory and reports the result as an exit code. The module under
 * test is mocked here precisely because the real one must NOT be: importing
 * `prisma-format.ts` has no side effects, which is the property this split
 * exists to preserve.
 *
 * @see scripts/ci/check-prisma-format.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCheckPrismaFormat = vi.fn();

vi.mock('@/scripts/ci/prisma-format', () => ({
  checkPrismaFormat: mockCheckPrismaFormat,
  SCHEMA_DIR: 'prisma/schema',
}));

describe('scripts/ci/check-prisma-format', () => {
  let originalExitCode: typeof process.exitCode;

  async function run(): Promise<void> {
    vi.resetModules();
    await import('@/scripts/ci/check-prisma-format');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    originalExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    // Restore, or a test asserting a failure hands vitest's own process a
    // non-zero code. Captured in `beforeEach` rather than at module scope
    // because the import below is what assigns it.
    process.exitCode = originalExitCode;
  });

  it('checks the platform schema directory by its relative path', async () => {
    // Relative, not resolved: `readdirSync` treats them the same, and it is
    // the spelling the failure messages should show.
    mockCheckPrismaFormat.mockReturnValue(0);

    await run();

    expect(mockCheckPrismaFormat).toHaveBeenCalledWith('prisma/schema');
    expect(process.exitCode).toBe(0);
  });

  it('reports a failure as the exit code', async () => {
    mockCheckPrismaFormat.mockReturnValue(1);

    await run();

    expect(process.exitCode).toBe(1);
  });
});
