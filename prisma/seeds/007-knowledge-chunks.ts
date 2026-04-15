import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { seedChunks } from '@/lib/orchestration/knowledge/seeder';
import type { SeedUnit } from '../runner';

/**
 * Seed the "Agentic Design Patterns" knowledge base document and its
 * chunks from the pre-parsed `lib/orchestration/seed/chunks.json`.
 *
 * Embeddings are intentionally NOT generated here — that requires a live
 * embedding provider and is out of scope for CLI seeding. Run the
 * separate embedding job from the admin UI or a dedicated script.
 */
const unit: SeedUnit = {
  name: '007-knowledge-chunks',
  // Fold the chunk data file into the content hash so edits re-trigger this unit.
  hashInputs: ['../../lib/orchestration/seed/chunks.json'],
  async run({ logger }) {
    logger.info('📖 Seeding knowledge base chunks...');

    // __dirname equivalent for ESM: .../prisma/seeds
    const here = dirname(fileURLToPath(import.meta.url));
    // Repo root is two levels up from prisma/seeds
    const chunksPath = resolve(here, '..', '..', 'lib', 'orchestration', 'seed', 'chunks.json');

    await seedChunks(chunksPath);

    logger.info('✅ Knowledge base chunk seed complete');
  },
};

export default unit;
