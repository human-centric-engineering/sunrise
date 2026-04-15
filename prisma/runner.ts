import { readdir, readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
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
  const contentHash = createHash('sha256').update(source).digest('hex');
  const name = file.replace(/\.ts$/, '');

  const existing = await prisma.seedHistory.findUnique({ where: { name } });
  if (existing && existing.contentHash === contentHash) {
    logger.info(`⏭  ${name} (unchanged, skipping)`);
    return;
  }

  const mod = (await import(pathToFileURL(filePath).href)) as { default?: SeedUnit };
  const unit = mod.default;
  if (!unit || typeof unit.run !== 'function') {
    throw new Error(`Seed file ${file} must default-export a SeedUnit { name, run }`);
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
