/**
 * Asserts that the seed unit assigns `vision` and `documents` capabilities
 * to the right rows. Source-driven assertions — parses the seed file's
 * model array rather than invoking the seeder against a DB, so we can
 * statically verify capability assignment per slug without spinning up
 * Prisma.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SEED_PATH = resolve(__dirname, '../../../../prisma/seeds/009-provider-models.ts');
const SEED_SOURCE = readFileSync(SEED_PATH, 'utf8');

/**
 * Extract `capabilities: [...]` for a given slug by anchoring to the
 * slug literal and matching the next capabilities entry within ~30
 * lines. Returns the capability strings found, or `null` if the slug
 * isn't in the seed.
 */
function capabilitiesFor(slug: string): string[] | null {
  const slugIndex = SEED_SOURCE.indexOf(`slug: '${slug}'`);
  if (slugIndex < 0) return null;
  const window = SEED_SOURCE.slice(slugIndex, slugIndex + 2000);
  const match = window.match(/capabilities:\s*\[([^\]]+)\]/);
  if (!match) return null;
  return match[1]
    .split(',')
    .map((token) => token.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

describe('seed 009 — provider-models capability assignment', () => {
  describe('vision-capable chat models', () => {
    const visionSlugs = [
      'openai-gpt-5',
      'openai-gpt-4-1',
      'openai-gpt-4o',
      'openai-gpt-4o-mini',
      'google-gemini-2-5-pro',
      'google-gemini-2-5-flash',
      'xai-grok-3',
      'microsoft-azure-gpt-4o',
    ];
    for (const slug of visionSlugs) {
      it(`${slug} carries the vision capability`, () => {
        const caps = capabilitiesFor(slug);
        expect(caps).not.toBeNull();
        expect(caps).toContain('vision');
      });
    }
  });

  describe('Claude models — vision and documents', () => {
    const claudeSlugs = [
      'anthropic-claude-opus-4',
      'anthropic-claude-sonnet-4',
      'anthropic-claude-haiku-4-5',
      'amazon-bedrock-claude',
    ];
    for (const slug of claudeSlugs) {
      it(`${slug} carries both vision and documents capabilities`, () => {
        const caps = capabilitiesFor(slug);
        expect(caps).not.toBeNull();
        expect(caps).toContain('vision');
        expect(caps).toContain('documents');
      });
    }
  });

  describe('OpenAI / Azure — vision and documents (Phase 6)', () => {
    // OpenAI Chat Completions gained inline PDF support late 2024 via
    // the `file` content part. The provider conversion in
    // `openai-compatible.ts` now emits that shape for application/pdf
    // attachments, so the seed enables `documents` on every OpenAI
    // model row in the GPT-4o / GPT-4.1 / GPT-5 family + Azure mirror.
    const openaiDocSlugs = [
      'openai-gpt-5',
      'openai-gpt-4-1',
      'openai-gpt-4o',
      'openai-gpt-4o-mini',
      'microsoft-azure-gpt-4o',
    ];
    for (const slug of openaiDocSlugs) {
      it(`${slug} carries both vision and documents`, () => {
        const caps = capabilitiesFor(slug);
        expect(caps).not.toBeNull();
        expect(caps).toContain('vision');
        expect(caps).toContain('documents');
      });
    }
  });

  describe('OpenRouter — documents (best-effort, route-dependent)', () => {
    // OpenRouter forwards through whichever underlying model it picks;
    // not every route accepts the OpenAI `file` content part shape.
    // The seed marks documents anyway so operators who target
    // OpenRouter can attempt PDF chat — the gate accepts the request,
    // and if the chosen route doesn't support it, OpenRouter surfaces
    // a provider error rather than silently dropping the attachment.
    it('openrouter-auto carries documents', () => {
      const caps = capabilitiesFor('openrouter-auto');
      expect(caps).not.toBeNull();
      expect(caps).toContain('documents');
    });
  });

  describe('Vision-only chat models — documents explicitly OFF', () => {
    // Locks in the conservative scope: these providers have
    // vision-capable models in the seed, but their OpenAI-compatible
    // adapters either don't accept the `file` content part shape, or
    // we haven't verified the wire-format yet. Leaving documents off
    // makes the gate reject PDFs cleanly with PDF_NOT_SUPPORTED
    // instead of letting OpenAI's shape leak to a provider that won't
    // parse it.
    const visionOnlySlugs = ['google-gemini-2-5-pro', 'google-gemini-2-5-flash', 'xai-grok-3'];
    for (const slug of visionOnlySlugs) {
      it(`${slug} has vision but NOT documents`, () => {
        const caps = capabilitiesFor(slug);
        expect(caps).not.toBeNull();
        expect(caps).toContain('vision');
        expect(caps).not.toContain('documents');
      });
    }
  });

  describe('text-only chat models should not carry vision or documents', () => {
    const textOnlySlugs = [
      'mistral-mistral-large',
      'mistral-mistral-small',
      'cohere-command-r-plus',
      'deepseek-deepseek-chat',
      'perplexity-sonar-pro',
      'groq-llama-3-3-70b',
      'meta-llama-3-3-70b',
      'meta-llama-3-2-8b',
    ];
    for (const slug of textOnlySlugs) {
      it(`${slug} does not carry vision or documents`, () => {
        const caps = capabilitiesFor(slug);
        expect(caps).not.toBeNull();
        expect(caps).not.toContain('vision');
        expect(caps).not.toContain('documents');
      });
    }
  });

  describe('embedding / audio / reasoning models do not get vision or documents', () => {
    const nonChatSlugs = [
      'openai-whisper-1',
      'openai-o3-mini',
      'openai-text-embedding-3-small',
      'openai-text-embedding-3-large',
      'voyage-voyage-3',
      'google-text-embedding-004',
    ];
    for (const slug of nonChatSlugs) {
      it(`${slug} is not vision/documents-tagged`, () => {
        const caps = capabilitiesFor(slug);
        expect(caps).not.toBeNull();
        expect(caps).not.toContain('vision');
        expect(caps).not.toContain('documents');
      });
    }
  });
});
