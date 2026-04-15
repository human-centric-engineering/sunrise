import { readdir, readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logging';

export interface SeedContext {
  prisma: PrismaClient;
  logger: typeof logger;
}

export interface SeedUnit {
  name: string;
  run(ctx: SeedContext): Promise<void>;
  /**
   * Optional list of extra files (paths relative to the seed file's directory)
   * whose contents are folded into the unit's content hash. Use this when the
   * seed delegates to a loader that reads data from a sibling/nearby file —
   * editing that data file should trigger a re-run.
   *
   * Order is preserved: hash = sha256(seedSource + '\n' + file0 + '\n' + file1 ...).
   */
  hashInputs?: string[];
}

const SEED_FILE_PATTERN = /^\d{3}-[a-z0-9-]+\.ts$/;

/**
 * Discover seed units under `seedsDir`, skip those whose source hash
 * matches the stored `SeedHistory.contentHash`, and run the rest in
 * filename order. Each successful run upserts a `SeedHistory` row.
 *
 * Seed files must default-export a `SeedUnit { name, run(ctx) }`.
 * Filenames must match `NNN-slug.ts` (e.g. `001-test-users.ts`) —
 * the numeric prefix fixes execution order across the team.
 */
export async function runSeeds(prisma: PrismaClient, seedsDir: string): Promise<void> {
  const entries = await readdir(seedsDir);
  const files = entries.filter((f) => SEED_FILE_PATTERN.test(f)).sort();

  if (files.length === 0) {
    logger.warn('No seed units found', { seedsDir });
    return;
  }

  logger.info(`Discovered ${files.length} seed units`);

  for (const file of files) {
    await applySeed(prisma, seedsDir, file);
  }
}

async function applySeed(prisma: PrismaClient, seedsDir: string, file: string): Promise<void> {
  const filePath = join(seedsDir, file);
  const source = await readFile(filePath, 'utf-8');
  const name = file.replace(/\.ts$/, '');

  // Import first so we can read the unit's hashInputs (if any) before hashing.
  // The import cost is negligible vs. the value of catching data-file edits.
  const mod = (await import(pathToFileURL(filePath).href)) as { default?: SeedUnit };
  const unit = mod.default;
  if (!unit || typeof unit.run !== 'function') {
    throw new Error(`Seed file ${file} must default-export a SeedUnit { name, run }`);
  }

  const hasher = createHash('sha256').update(source);
  if (Array.isArray(unit.hashInputs) && unit.hashInputs.length > 0) {
    const fileDir = dirname(filePath);
    for (const rel of unit.hashInputs) {
      const extraPath = resolve(fileDir, rel);
      let extra: string;
      try {
        extra = await readFile(extraPath, 'utf-8');
      } catch {
        throw new Error(
          `Seed unit ${name} declares hashInput "${rel}" but file not found at ${extraPath}`
        );
      }
      hasher.update('\n').update(extra);
    }
  }
  const contentHash = hasher.digest('hex');

  const existing = await prisma.seedHistory.findUnique({ where: { name } });
  if (existing && existing.contentHash === contentHash) {
    logger.info(`⏭  ${name} (unchanged, skipping)`);
    return;
  }

  const verb = existing ? 'updating' : 'applying';
  logger.info(`▶  ${name} (${verb})`);

  const start = Date.now();
  await unit.run({ prisma, logger });
  const durationMs = Date.now() - start;

  await prisma.seedHistory.upsert({
    where: { name },
    update: { contentHash, appliedAt: new Date(), durationMs },
    create: { name, contentHash, durationMs },
  });

  logger.info(`✓  ${name} (applied in ${durationMs}ms)`);
}
