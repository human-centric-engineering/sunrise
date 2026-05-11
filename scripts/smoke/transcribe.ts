/* eslint-disable no-console, @typescript-eslint/require-await -- CLI smoke script; fake provider methods need the async signature to match the LlmProvider interface */
/**
 * Audio (speech-to-text) smoke script (`getAudioProvider` + `transcribe`)
 *
 * Exercises the audio resolution path against the real Postgres dev DB
 * with an injected fake `LlmProvider` (no API key, no SDK, no network).
 * Mirrors `scripts/smoke/chat.ts`'s injection pattern.
 *
 * Flow:
 *   1. Inject a fake audio provider via `registerProviderInstance`
 *      whose `transcribe()` returns a known string.
 *   2. Seed a `smoke-test-audio` `AiProviderModel` row bound to the
 *      fake provider's slug (capabilities: ['audio'], isActive: true).
 *   3. Resolve via `getAudioProvider()` — should pick the fake.
 *   4. Call `transcribe()` on it with a silent WAV; print latency.
 *   5. Delete only the row this script created.
 *
 * Safety:
 *   - Single matrix row scoped by `smoke-test-audio` slug — never
 *     touches real data. Stale rows from a previous run are cleaned
 *     up before seeding.
 *   - Read `scripts/smoke/README.md` before adding more smoke scripts.
 *
 * Run with:
 *   npm run smoke:transcribe
 *   # or:
 *   npx tsx --env-file=.env.local scripts/smoke/transcribe.ts
 */

import { prisma } from '@/lib/db/client';
import {
  getAudioProvider,
  registerProviderInstance,
} from '@/lib/orchestration/llm/provider-manager';
import { generateSilentWav } from '@/lib/audio/silent-wav';
import type { LlmProvider } from '@/lib/orchestration/llm/provider';
import type {
  LlmMessage,
  LlmOptions,
  LlmResponse,
  ModelInfo,
  StreamChunk,
  TranscribeOptions,
  TranscribeResponse,
} from '@/lib/orchestration/llm/types';

const SMOKE_PROVIDER_SLUG = 'smoke-test-audio-provider';
const SMOKE_MODEL_ID = 'smoke-whisper';
const SMOKE_ROW_SLUG = 'smoke-test-audio';
const SCRIPTED_TRANSCRIPT = 'hello from the smoke test';

function makeFakeAudioProvider(): LlmProvider {
  return {
    name: SMOKE_PROVIDER_SLUG,
    isLocal: false,
    async chat(_m: LlmMessage[], _o: LlmOptions): Promise<LlmResponse> {
      throw new Error('smoke fake provider does not implement chat()');
    },
    // eslint-disable-next-line require-yield -- async generator stub
    async *chatStream(_m: LlmMessage[], _o: LlmOptions): AsyncIterable<StreamChunk> {
      throw new Error('smoke fake provider does not implement chatStream()');
    },
    async embed(_t: string): Promise<number[]> {
      throw new Error('smoke fake provider does not implement embed()');
    },
    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
    async testConnection() {
      return { ok: true, models: [SMOKE_MODEL_ID] };
    },
    async transcribe(
      audio: Blob | Buffer | ArrayBuffer | Uint8Array,
      options: TranscribeOptions
    ): Promise<TranscribeResponse> {
      const len =
        audio instanceof Blob
          ? audio.size
          : audio instanceof ArrayBuffer
            ? audio.byteLength
            : audio.length;
      console.log(`  [fake provider] transcribe() called: bytes=${len} model=${options.model}`);
      return {
        text: SCRIPTED_TRANSCRIPT,
        durationMs: 1000,
        model: options.model,
      };
    },
  };
}

async function cleanup(): Promise<void> {
  // Idempotent — safe to re-run.
  await prisma.aiProviderModel.deleteMany({ where: { slug: SMOKE_ROW_SLUG } });
}

async function main(): Promise<void> {
  console.log('▶ Audio smoke: starting');

  // 0. Bind to a real user (createdBy FK on AiProviderModel).
  const user = await prisma.user.findFirst();
  if (!user) {
    console.error('✗ No user rows in dev DB — seed a user first.');
    process.exit(1);
  }
  console.log(`  • Using user ${user.id}`);

  // 1. Inject the fake provider so getAudioProvider can resolve it
  //    without a DB-level AiProviderConfig row. registerProviderInstance
  //    bypasses the normal DB-driven provider construction path.
  registerProviderInstance(SMOKE_PROVIDER_SLUG, makeFakeAudioProvider());
  console.log(`  • Injected fake provider as slug "${SMOKE_PROVIDER_SLUG}"`);

  // 2. Seed a matrix row. AiProviderModel doesn't require a matching
  //    AiProviderConfig — the runtime resolver hits providerManager
  //    which we've already pre-populated via registerProviderInstance.
  await cleanup();
  const row = await prisma.aiProviderModel.create({
    data: {
      slug: SMOKE_ROW_SLUG,
      providerSlug: SMOKE_PROVIDER_SLUG,
      modelId: SMOKE_MODEL_ID,
      name: 'Smoke Whisper',
      description: 'Audio smoke fixture — injected fake provider',
      capabilities: ['audio'],
      tierRole: 'worker',
      reasoningDepth: 'none',
      latency: 'fast',
      costEfficiency: 'high',
      contextLength: 'n_a',
      toolUse: 'none',
      bestRole: 'Speech-to-text',
      isDefault: false,
      isActive: true,
      createdBy: user.id,
    },
  });
  console.log(`  • Seeded matrix row id=${row.id}`);

  // 3. Resolve via getAudioProvider — should return the fake.
  const resolved = await getAudioProvider();
  if (!resolved) {
    throw new Error('getAudioProvider returned null — fake provider was not picked up');
  }
  if (resolved.providerSlug !== SMOKE_PROVIDER_SLUG) {
    throw new Error(
      `Wrong provider resolved: expected "${SMOKE_PROVIDER_SLUG}", got "${resolved.providerSlug}"`
    );
  }
  console.log(`  • Resolved: provider=${resolved.providerSlug} model=${resolved.modelId}`);

  // 4. Round-trip a silent WAV through transcribe().
  const wav = generateSilentWav();
  console.log(`  • Posting ${wav.length}-byte silent WAV to transcribe()`);
  const start = Date.now();
  const result = await resolved.provider.transcribe(wav, {
    model: resolved.modelId,
    mimeType: 'audio/wav',
  });
  const latencyMs = Date.now() - start;
  if (result.text !== SCRIPTED_TRANSCRIPT) {
    throw new Error(`Wrong transcript: expected "${SCRIPTED_TRANSCRIPT}", got "${result.text}"`);
  }
  console.log(`  • Transcript: "${result.text}" (latency=${latencyMs}ms)`);

  // 5. Clean up so the next run starts fresh.
  await cleanup();
  console.log('  • Cleaned up matrix row');

  console.log('✅ Audio smoke: PASSED');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('❌ Audio smoke: FAILED');
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
    await prisma.$disconnect();
    process.exit(1);
  });
