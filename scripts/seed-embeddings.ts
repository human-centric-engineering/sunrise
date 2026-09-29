import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import { logger } from '@/lib/logging';
import { embedChunks } from '@/lib/orchestration/knowledge/seeder';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';

/**
 * Generate vector embeddings for the install org's knowledge-base chunks with
 * `embedding IS NULL`. Opt-in and separate from `db:seed` because it
 * requires an active embedding provider (Voyage / OpenAI / Ollama) and
 * costs money or requires a local install.
 *
 * The install org's: the seeded patterns knowledge is its alone (§116 t-733),
 * and at `TENANCY_MODE=multi` a query with no org fails. Another org embeds
 * its own chunks from its knowledge page (`POST /knowledge/embed`).
 */
async function main() {
  logger.info('🧠 Generating embeddings for the install org’s pending chunks...');
  const { processed, total, alreadyEmbedded } = await runAsOrg(INSTALL_ORG_ID, () => embedChunks());
  logger.info('✅ Embeddings complete', { processed, total, alreadyEmbedded });
}

main().catch((err) => {
  logger.error('❌ Embedding run failed', err);
  process.exit(1);
});
