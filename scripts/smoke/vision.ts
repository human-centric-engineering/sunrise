/* eslint-disable no-console -- CLI smoke script */
/**
 * Vision capability smoke script
 *
 * Exercises `assertModelSupportsAttachments` + `hasModelWithCapability`
 * end-to-end against the real Postgres dev DB without making any
 * network calls. Mirrors `scripts/smoke/transcribe.ts`'s injection
 * pattern.
 *
 * Flow:
 *   1. Seed two AiProviderModel rows under the `smoke-test-vision-*`
 *      slug namespace — one with `'vision'`, one without. No real
 *      provider config required because the script never invokes
 *      `getProvider`; only the capability lookup is exercised.
 *   2. Assert that `assertModelSupportsAttachments` accepts the
 *      vision-tagged row and rejects the chat-only row with
 *      `CAPABILITY_NOT_SUPPORTED`.
 *   3. Assert that `hasModelWithCapability('vision')` returns true.
 *   4. Clean up only the rows the script created.
 *
 * Safety:
 *   - Rows are scoped to the `smoke-test-vision-` slug prefix; never
 *     touches real data. Stale rows from a previous run are cleaned
 *     before seeding.
 *
 * Run with:
 *   npm run smoke:vision
 *   # or:
 *   npx tsx --env-file=.env.local scripts/smoke/vision.ts
 */

import { prisma } from '@/lib/db/client';
import {
  assertModelSupportsAttachments,
  hasModelWithCapability,
} from '@/lib/orchestration/llm/provider-manager';
import { ProviderError } from '@/lib/orchestration/llm/provider';

const VISION_ROW_SLUG = 'smoke-test-vision-capable';
const NO_VISION_ROW_SLUG = 'smoke-test-vision-textonly';
const PROVIDER_SLUG = 'smoke-test-vision-provider';

async function cleanup(): Promise<void> {
  await prisma.aiProviderModel.deleteMany({
    where: { slug: { in: [VISION_ROW_SLUG, NO_VISION_ROW_SLUG] } },
  });
}

async function main(): Promise<void> {
  console.log('▶ Vision smoke: starting');

  const user = await prisma.user.findFirst();
  if (!user) {
    console.error('✗ No user rows in dev DB — seed a user first.');
    process.exit(1);
  }

  await cleanup();

  // 1. Seed two rows under a shared fake provider slug — one vision-
  //    capable, one not. Capability gate operates purely on the
  //    capabilities array, so no real `AiProviderConfig` row is needed.
  await prisma.aiProviderModel.createMany({
    data: [
      {
        slug: VISION_ROW_SLUG,
        providerSlug: PROVIDER_SLUG,
        modelId: 'smoke-vision-model',
        name: 'Smoke Vision Model',
        description: 'Vision smoke fixture — vision-capable row',
        capabilities: ['chat', 'vision'],
        tierRole: 'worker',
        reasoningDepth: 'medium',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'moderate',
        bestRole: 'Multimodal worker',
        isDefault: false,
        isActive: true,
        createdBy: user.id,
      },
      {
        slug: NO_VISION_ROW_SLUG,
        providerSlug: PROVIDER_SLUG,
        modelId: 'smoke-textonly-model',
        name: 'Smoke Text-Only Model',
        description: 'Vision smoke fixture — chat-only row',
        capabilities: ['chat'],
        tierRole: 'worker',
        reasoningDepth: 'medium',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'moderate',
        bestRole: 'Text-only worker',
        isDefault: false,
        isActive: true,
        createdBy: user.id,
      },
    ],
  });
  console.log('  • Seeded smoke vision rows (capable + text-only)');

  // 2a. Vision-capable row passes the gate.
  await assertModelSupportsAttachments(PROVIDER_SLUG, 'smoke-vision-model', ['vision']);
  console.log('  • Vision-capable row: gate passes ✓');

  // 2b. Text-only row fails with CAPABILITY_NOT_SUPPORTED.
  let caught: unknown = null;
  try {
    await assertModelSupportsAttachments(PROVIDER_SLUG, 'smoke-textonly-model', ['vision']);
  } catch (err) {
    caught = err;
  }
  if (!(caught instanceof ProviderError) || caught.code !== 'CAPABILITY_NOT_SUPPORTED') {
    throw new Error(`Expected CAPABILITY_NOT_SUPPORTED ProviderError, got ${String(caught)}`);
  }
  console.log('  • Text-only row: gate rejects with CAPABILITY_NOT_SUPPORTED ✓');

  // 3. Capability discovery: at least one active row in the matrix
  //    carries `'vision'`. Returns true even when the seed-managed
  //    rows are present, so this is robust against a freshly seeded DB.
  const found = await hasModelWithCapability('vision');
  if (!found) {
    throw new Error('hasModelWithCapability("vision") returned false despite smoke row');
  }
  console.log('  • hasModelWithCapability("vision") returned true ✓');

  // 4. Clean up.
  await cleanup();
  console.log('  • Cleaned up smoke rows');

  console.log('✅ Vision smoke: PASSED');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('❌ Vision smoke: FAILED');
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
    process.exit(1);
  });
