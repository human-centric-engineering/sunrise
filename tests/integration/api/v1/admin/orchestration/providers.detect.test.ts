/**
 * Integration Test: Admin Orchestration Provider Detection
 *
 * GET /api/v1/admin/orchestration/providers/detect
 *
 * Key assertions:
 *   - Admin auth gate (401 / 403 / 200 paths)
 *   - Detection picks up env vars from `process.env`, never returns the value
 *   - `alreadyConfigured: true` when a provider with the same slug exists
 *   - Local providers (Ollama) report `apiKeyPresent: false` regardless of env
 *
 * @see app/api/v1/admin/orchestration/providers/detect/route.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/admin/orchestration/providers/detect/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: {
      findMany: vi.fn(),
    },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  const url = new URL('http://localhost:3000/api/v1/admin/orchestration/providers/detect');
  return new NextRequest(url);
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

interface DetectionRow {
  slug: string;
  name: string;
  providerType: string;
  defaultBaseUrl: string | null;
  apiKeyEnvVar: string | null;
  apiKeyPresent: boolean;
  alreadyConfigured: boolean;
  isLocal: boolean;
  suggestedDefaultChatModel: string | null;
  suggestedEmbeddingModel: string | null;
}

interface DetectResponseBody {
  success: boolean;
  data: { detected: DetectionRow[] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/providers/detect', () => {
  // Snapshot env vars under test so the suite restores them after each run.
  const ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
    'GOOGLE_AI_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'MISTRAL_API_KEY',
    'GROQ_API_KEY',
    'TOGETHER_API_KEY',
    'FIREWORKS_API_KEY',
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(403);
    });
  });

  describe('Detection logic', () => {
    it('returns the full known-provider catalogue with apiKeyPresent: false when no env vars are set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await GET(makeGetRequest());

      expect(response.status).toBe(200);
      const data = await parseJson<DetectResponseBody>(response);
      expect(data.success).toBe(true);
      expect(data.data.detected.length).toBeGreaterThan(0);

      // Every cloud row reports apiKeyPresent: false; local rows are always false too.
      for (const row of data.data.detected) {
        expect(row.apiKeyPresent).toBe(false);
        if (row.isLocal) {
          expect(row.apiKeyEnvVar).toBeNull();
        }
      }
    });

    it('flags Anthropic as detected when ANTHROPIC_API_KEY is set', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      const response = await GET(makeGetRequest());

      const data = await parseJson<DetectResponseBody>(response);
      const anthropic = data.data.detected.find((r) => r.slug === 'anthropic');
      expect(anthropic).toBeDefined();
      expect(anthropic?.apiKeyPresent).toBe(true);
      expect(anthropic?.apiKeyEnvVar).toBe('ANTHROPIC_API_KEY');
    });

    it('matches Google AI on any of GOOGLE_AI_API_KEY, GOOGLE_API_KEY, or GEMINI_API_KEY', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      process.env.GEMINI_API_KEY = 'gemini-test';

      const response = await GET(makeGetRequest());

      const data = await parseJson<DetectResponseBody>(response);
      const google = data.data.detected.find((r) => r.slug === 'google');
      expect(google?.apiKeyPresent).toBe(true);
      expect(google?.apiKeyEnvVar).toBe('GEMINI_API_KEY');
    });

    it('marks a provider alreadyConfigured: true when a row with the same slug exists', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([
        { slug: 'anthropic' },
      ] as never);

      const response = await GET(makeGetRequest());

      const data = await parseJson<DetectResponseBody>(response);
      const anthropic = data.data.detected.find((r) => r.slug === 'anthropic');
      const openai = data.data.detected.find((r) => r.slug === 'openai');
      expect(anthropic?.alreadyConfigured).toBe(true);
      expect(openai?.alreadyConfigured).toBe(false);
    });

    it('never returns the env-var value, only the name', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const SECRET = 'sk-do-not-leak-12345';
      process.env.OPENAI_API_KEY = SECRET;

      const response = await GET(makeGetRequest());

      const body = await response.text();
      expect(body).not.toContain(SECRET);
    });
  });
});
