import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import { logger } from '@/lib/logging';
import { embedChunks } from '@/lib/orchestration/knowledge/seeder';

/**
 * Generate vector embeddings for every knowledge-base chunk with
 * `embedding IS NULL`. Opt-in and separate from `db:seed` because it
 * requires an active embedding provider (Voyage / OpenAI / Ollama) and
 * costs money or requires a local install.
 */
async function main() {
  logger.info('🧠 Generating embeddings for pending chunks...');
  const { processed, total, alreadyEmbedded } = await embedChunks();
  logger.info('✅ Embeddings complete', { processed, total, alreadyEmbedded });
}

main().catch((err) => {
  logger.error('❌ Embedding run failed', err);
  process.exit(1);
});
