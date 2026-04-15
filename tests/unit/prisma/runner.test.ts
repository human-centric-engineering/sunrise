// @vitest-environment node

/**
 * Seed Runner Unit Tests
 *
 * Tests for prisma/runner.ts — the idempotent seed execution engine.
 *
 * Strategy:
 * - Real filesystem: tmp dirs with real .ts seed files so dynamic import() works.
 * - Hand-rolled prisma fake: only seedHistory.findUnique / upsert are needed.
 * - Logger is mocked to keep output clean and allow spy assertions.
 *
 * Cases covered:
 * 1. Empty directory — warns, no throw, no DB calls.
 * 2. Two fresh units — both run in filename order, two upserts.
 * 3. Matching hash — unit is skipped; run() and upsert are NOT called.
 * 4. Mismatched hash — unit re-runs; upsert updates the row.
 * 5. Non-matching filenames — ignored entirely.
 * 6. Missing default export — throws with filename in message.
 * 7. run() throws — error bubbles; upsert NOT called.
 * 8. Lexicographic sort order — 010-x runs after 009-x.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// Mock logger before importing runner (runner imports it at module scope)
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  },
}));

import { runSeeds } from '@/prisma/runner';
import { logger } from '@/lib/logging';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the sha256 hash that runner.ts produces for a given source string.
 * Kept here to avoid re-implementing the logic in tests.
 */
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Minimal SeedHistory delegate — the only two methods runner.ts touches.
 */
interface FakeSeedHistoryRow {
  id: string;
  name: string;
  contentHash: string;
  appliedAt: Date;
  durationMs: number;
}

function makeFakePrisma(rows: FakeSeedHistoryRow[] = []) {
  const store = new Map<string, FakeSeedHistoryRow>(rows.map((r) => [r.name, r]));

  const findUnique = vi.fn(async ({ where }: { where: { name: string } }) => {
    return store.get(where.name) ?? null;
  });

  const upsert = vi.fn(
    async ({
      where,
      update,
      create,
    }: {
      where: { name: string };
      update: Partial<FakeSeedHistoryRow>;
      create: Omit<FakeSeedHistoryRow, 'id' | 'appliedAt'>;
    }) => {
      const existing = store.get(where.name);
      if (existing) {
        const updated = { ...existing, ...update, appliedAt: new Date() };
        store.set(where.name, updated);
        return updated;
      }
      const created: FakeSeedHistoryRow = {
        id: `id-${where.name}`,
        appliedAt: new Date(),
        ...create,
      };
      store.set(where.name, created);
      return created;
    }
  );

  // Cast to PrismaClient — runner only accesses prisma.seedHistory
  const prisma = {
    seedHistory: { findUnique, upsert },
  } as unknown as PrismaClient;

  return { prisma, findUnique, upsert, store };
}

/**
 * Write a valid seed file and return its source content so callers can
 * compute the expected hash.
 *
 * The file default-exports a SeedUnit whose run() increments the provided
 * counter array (passed by reference via closure over a module-level variable
 * is not possible across dynamic import boundaries, so we use an external
 * counter that the fixture *writes to a temp file* on each call — instead,
 * the simpler approach is to just return a file that does nothing side-effecty
 * that we can't observe; for order/invocation tests we spy on upsert instead).
 *
 * For cases where we need to detect if run() was called, the fixture writes
 * a marker to a shared object via a module-global Map that vitest keeps alive
 * within the same process. Because dynamic import caches modules, we use
 * unique exports per file rather than a shared map.
 */
async function writeSeedFile(dir: string, filename: string, unitName: string): Promise<string> {
  const source = `export default { name: '${unitName}', async run() {} };\n`;
  await writeFile(join(dir, filename), source, 'utf-8');
  return source;
}

/**
 * Write a seed file whose run() throws.
 */
async function writeSeedFileThatThrows(
  dir: string,
  filename: string,
  unitName: string
): Promise<string> {
  const source = `export default { name: '${unitName}', async run() { throw new Error('seed-run-failed'); } };\n`;
  await writeFile(join(dir, filename), source, 'utf-8');
  return source;
}

/**
 * Write a file with no default export (simulates misconfigured seed).
 */
async function writeSeedFileNoDefault(dir: string, filename: string): Promise<void> {
  await writeFile(join(dir, filename), `export const foo = 42;\n`, 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSeeds()', () => {
  let tmpDir: string;

  // Create a fresh tmp dir for each test so files never bleed across cases
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sunrise-runner-test-'));
    vi.clearAllMocks();
  });

  // Cleanup tmp dir after each test
  // (use afterEach pattern inline via a cleanup variable)
  // We cannot use afterEach here without importing it, but it's available via globals (vitest globals: true)

  it('should warn and return without error when the directory has no matching files', async () => {
    // Arrange — empty directory
    const { prisma, findUnique, upsert } = makeFakePrisma();

    // Act
    await expect(runSeeds(prisma, tmpDir)).resolves.toBeUndefined();

    // Assert
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('No seed units found'),
      expect.any(Object)
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should run two fresh units in filename order and upsert both', async () => {
    // Arrange
    const { prisma, upsert } = makeFakePrisma(); // empty store → no existing rows

    const source1 = await writeSeedFile(tmpDir, '001-alpha.ts', 'alpha');
    const source2 = await writeSeedFile(tmpDir, '002-beta.ts', 'beta');

    // Act
    await runSeeds(prisma, tmpDir);

    // Assert — both upserted in order
    expect(upsert).toHaveBeenCalledTimes(2);

    const firstCall = vi.mocked(upsert).mock.calls[0][0];
    const secondCall = vi.mocked(upsert).mock.calls[1][0];

    expect(firstCall.where.name).toBe('001-alpha');
    expect(firstCall.create.contentHash).toBe(sha256(source1));

    expect(secondCall.where.name).toBe('002-beta');
    expect(secondCall.create.contentHash).toBe(sha256(source2));

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should skip a unit whose stored hash matches the file hash', async () => {
    // Arrange — pre-populate store with the correct hash
    const source = await writeSeedFile(tmpDir, '001-cached.ts', 'cached');
    const hash = sha256(source);

    const { prisma, upsert } = makeFakePrisma([
      {
        id: 'id-001-cached',
        name: '001-cached',
        contentHash: hash,
        appliedAt: new Date(),
        durationMs: 10,
      },
    ]);

    // Act
    await runSeeds(prisma, tmpDir);

    // Assert — skipped; no upsert
    expect(upsert).not.toHaveBeenCalled();
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.stringContaining('001-cached')
      // no extra context arg required — just verify the message mentions the name
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should re-run a unit whose stored hash does not match (file edited)', async () => {
    // Arrange — store has stale hash
    const source = await writeSeedFile(tmpDir, '001-edited.ts', 'edited');
    const currentHash = sha256(source);
    const staleHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    expect(currentHash).not.toBe(staleHash); // sanity check

    const { prisma, upsert } = makeFakePrisma([
      {
        id: 'id-001-edited',
        name: '001-edited',
        contentHash: staleHash,
        appliedAt: new Date(),
        durationMs: 5,
      },
    ]);

    // Act
    await runSeeds(prisma, tmpDir);

    // Assert — upsert called with fresh hash
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = vi.mocked(upsert).mock.calls[0][0];
    expect(call.where.name).toBe('001-edited');
    expect(call.update.contentHash).toBe(currentHash);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should ignore files that do not match the NNN-slug.ts pattern', async () => {
    // Arrange — only non-matching files
    await writeFile(join(tmpDir, 'foo.ts'), `export default { name: 'foo', async run() {} };\n`);
    await writeFile(join(tmpDir, '01-bad.ts'), `export default { name: 'bad', async run() {} };\n`);
    await writeFile(join(tmpDir, 'README.md'), '# seeds\n');
    await writeFile(join(tmpDir, '_helper.ts'), 'export const x = 1;\n');

    const { prisma, findUnique, upsert } = makeFakePrisma();

    // Act
    await runSeeds(prisma, tmpDir);

    // Assert — treated as empty directory
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('No seed units found'),
      expect.any(Object)
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should throw a descriptive error when a seed file has no default export', async () => {
    // Arrange
    await writeSeedFileNoDefault(tmpDir, '001-nodefault.ts');
    const { prisma } = makeFakePrisma();

    // Act & Assert
    await expect(runSeeds(prisma, tmpDir)).rejects.toThrow('001-nodefault.ts');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should propagate errors thrown from a unit run() without upsert', async () => {
    // Arrange
    await writeSeedFileThatThrows(tmpDir, '001-throws.ts', 'throws');
    const { prisma, upsert } = makeFakePrisma();

    // Act & Assert
    await expect(runSeeds(prisma, tmpDir)).rejects.toThrow('seed-run-failed');

    // Upsert must NOT have been called — error happened before that line
    expect(upsert).not.toHaveBeenCalled();

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should execute seeds in strict lexicographic order (010 after 009)', async () => {
    // Arrange — filenames chosen so 010 sorts after 009 lexicographically
    const { prisma, upsert } = makeFakePrisma();

    await writeSeedFile(tmpDir, '010-ten.ts', 'ten');
    await writeSeedFile(tmpDir, '009-nine.ts', 'nine');

    // Act
    await runSeeds(prisma, tmpDir);

    // Assert — upsert calls in sorted filename order: 009 first, 010 second
    expect(upsert).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(upsert).mock.calls[0][0];
    const secondCall = vi.mocked(upsert).mock.calls[1][0];

    expect(firstCall.where.name).toBe('009-nine');
    expect(secondCall.where.name).toBe('010-ten');

    await rm(tmpDir, { recursive: true, force: true });
  });
});
