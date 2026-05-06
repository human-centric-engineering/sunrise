/**
 * Integration Test: Admin Orchestration — Workflow Dry-Run
 *
 * POST /api/v1/admin/orchestration/workflows/:id/dry-run
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/dry-run/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/workflows/[id]/dry-run/route';
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
    aiWorkflow: {
      findUnique: vi.fn(),
    },
    aiWorkflowVersion: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('@/lib/orchestration/workflows', () => ({
  validateWorkflow: vi.fn(() => ({ errors: [] })),
  semanticValidateWorkflow: vi.fn(async () => ({ errors: [] })),
  extractTemplateVariables: vi.fn(() => []),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import {
  validateWorkflow,
  semanticValidateWorkflow,
  extractTemplateVariables,
} from '@/lib/orchestration/workflows';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwu2';
const INVALID_ID = 'not-a-cuid';
const BASE_URL = `http://localhost:3000/api/v1/admin/orchestration/workflows/${WORKFLOW_ID}/dry-run`;

/**
 * A well-formed workflow definition that passes workflowDefinitionSchema.
 */
function makeValidDefinition() {
  return {
    steps: [
      {
        id: 'step-1',
        type: 'llm_call',
        name: 'Ask AI',
        config: { prompt: 'Say hello to {{input.name}}' },
        nextSteps: [],
      },
    ],
    entryStepId: 'step-1',
    errorStrategy: 'fail' as const,
  };
}

function makeWorkflowRow(overrides: { workflowDefinition?: unknown } = {}) {
  // The dry-run route now reads the snapshot from `publishedVersion`, not a
  // top-level `workflowDefinition` column. The fixture keeps the override
  // ergonomics by translating the legacy field name into the new shape.
  const { workflowDefinition: snapshotOverride, ...rest } = overrides;
  const snapshot = snapshotOverride === undefined ? makeValidDefinition() : snapshotOverride;
  return {
    id: WORKFLOW_ID,
    name: 'Test Workflow',
    slug: 'test-workflow',
    draftDefinition: null,
    publishedVersionId: snapshot === null ? null : 'wfv-1',
    publishedVersion: snapshot === null ? null : { id: 'wfv-1', version: 1, snapshot },
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...rest,
  };
}

function makeRequest(body: Record<string, unknown> = { inputData: {} }): NextRequest {
  const bodyStr = JSON.stringify(body);
  const base = {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
    url: BASE_URL,
  };
  return {
    ...base,
    clone: () => ({ ...base }),
  } as unknown as NextRequest;
}

function makeParams(id: string = WORKFLOW_ID) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/workflows/:id/dry-run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(validateWorkflow).mockReturnValue({ ok: true, errors: [] });
    vi.mocked(semanticValidateWorkflow).mockResolvedValue({ ok: true, errors: [] });
    vi.mocked(extractTemplateVariables).mockReturnValue([]);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(403);
    });
  });

  describe('Rate limiting', () => {
    it('returns 429 when rate limit is exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makeRequest(), makeParams());

      expect(response.status).toBe(429);
    });
  });

  describe('Validation', () => {
    it('returns 400 when id is not a valid CUID', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makeRequest(), makeParams(INVALID_ID));

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when inputData is missing from body', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);

      const response = await POST(makeRequest({}), makeParams());

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when the stored workflow definition is malformed', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflowRow({ workflowDefinition: { invalid: true } }) as never
      );

      const response = await POST(makeRequest({ inputData: {} }), makeParams());

      expect(response.status).toBe(400);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('Not found', () => {
    it('returns 404 when workflow does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null);

      const response = await POST(makeRequest({ inputData: {} }), makeParams());

      expect(response.status).toBe(404);
      const data = await parseJson<{ error: { code: string } }>(response);
      expect(data.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Successful dry-run', () => {
    it('returns 200 with ok=true and empty errors when validation passes', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);

      const response = await POST(makeRequest({ inputData: { name: 'Alice' } }), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        success: boolean;
        data: { ok: boolean; errors: string[]; warnings: string[]; extractedVariables: string[] };
      }>(response);

      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.success).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.ok).toBe(true);
      expect(data.data.errors).toHaveLength(0);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(Array.isArray(data.data.warnings)).toBe(true);
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(Array.isArray(data.data.extractedVariables)).toBe(true);
    });

    it('returns ok=false when structural validation finds errors', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(validateWorkflow).mockReturnValue({
        ok: false,
        errors: [{ code: 'CYCLE_DETECTED', message: 'Cycle detected in step graph' }],
      });

      const response = await POST(makeRequest({ inputData: {} }), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { ok: boolean; errors: Array<{ code: string; message: string }> };
      }>(response);
      expect(data.data.ok).toBe(false);
      expect(data.data.errors[0].message).toContain('Cycle detected in step graph');
    });

    it('returns ok=false when semantic validation finds errors', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(semanticValidateWorkflow).mockResolvedValue({
        ok: false,
        errors: [
          {
            code: 'UNKNOWN_MODEL_OVERRIDE' as const,
            message: 'Model gpt-99 not found for provider openai',
            stepId: 'step-1',
          },
        ],
      });

      const response = await POST(makeRequest({ inputData: {} }), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { ok: boolean; errors: Array<{ code: string; message: string }> };
      }>(response);
      expect(data.data.ok).toBe(false);
      expect(data.data.errors[0].message).toContain('gpt-99');
    });

    it('adds a warning when a template variable is not covered by inputData', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(extractTemplateVariables).mockReturnValue(['name', 'city']);

      // inputData provides 'name' but not 'city'
      const response = await POST(makeRequest({ inputData: { name: 'Alice' } }), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{
        data: { ok: boolean; warnings: string[]; extractedVariables: string[] };
      }>(response);

      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.ok).toBe(true); // warnings don't set ok=false
      // test-review:accept tobe_true — structural boolean assertion on API response field
      expect(data.data.warnings.some((w) => w.includes('city'))).toBe(true);
      expect(data.data.extractedVariables).toContain('name');
      expect(data.data.extractedVariables).toContain('city');
    });

    it('skips the __whole__ sentinel variable when checking inputData coverage', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(extractTemplateVariables).mockReturnValue(['__whole__']);

      const response = await POST(makeRequest({ inputData: {} }), makeParams());

      expect(response.status).toBe(200);
      const data = await parseJson<{ data: { warnings: string[] } }>(response);
      // __whole__ should NOT generate a warning
      expect(data.data.warnings).toHaveLength(0);
    });
  });

  describe('target selector', () => {
    const ALT_DEF = {
      steps: [
        {
          id: 'step-2',
          name: 'Alt step',
          type: 'chain',
          config: { prompt: 'alt' },
          nextSteps: [],
        },
      ],
      entryStepId: 'step-2',
      errorStrategy: 'retry' as const,
    };

    it('target=draft validates the draftDefinition column instead of the published version', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflowRow({ workflowDefinition: ALT_DEF }) as never
      );
      // Override the helper with a workflow that has a draft.
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValueOnce({
        ...makeWorkflowRow({ workflowDefinition: ALT_DEF }),
        draftDefinition: makeValidDefinition(),
      } as never);

      const response = await POST(makeRequest({ inputData: {}, target: 'draft' }), makeParams());

      expect(response.status).toBe(200);
      // semanticValidateWorkflow should have been called with the DRAFT
      // definition (entryStepId='step-1' from makeValidDefinition), not the
      // published one (entryStepId='step-2' from ALT_DEF).
      const arg = vi.mocked(semanticValidateWorkflow).mock.calls[0]?.[0] as
        | { entryStepId?: string }
        | undefined;
      expect(arg?.entryStepId).toBe('step-1');
    });

    it('target=draft 400s when the workflow has no draft', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(
        makeWorkflowRow() as never // draftDefinition is null by default
      );

      const response = await POST(makeRequest({ inputData: {}, target: 'draft' }), makeParams());

      expect(response.status).toBe(400);
    });

    it('target=version reads the snapshot from the requested version row', async () => {
      const VERSION_ID = 'cmjbv4i3x00003wsloputvv01';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue({
        id: VERSION_ID,
        workflowId: WORKFLOW_ID,
        version: 2,
        snapshot: ALT_DEF,
      } as never);

      const response = await POST(
        makeRequest({ inputData: {}, target: 'version', versionId: VERSION_ID }),
        makeParams()
      );

      expect(response.status).toBe(200);
      const arg = vi.mocked(semanticValidateWorkflow).mock.calls[0]?.[0] as
        | { entryStepId?: string }
        | undefined;
      expect(arg?.entryStepId).toBe('step-2');
    });

    it('target=version 404s when the version row is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue(null);

      const response = await POST(
        makeRequest({
          inputData: {},
          target: 'version',
          versionId: 'cmjbv4i3x00003wsloputvv99',
        }),
        makeParams()
      );

      expect(response.status).toBe(404);
    });

    it('target=version 404s when the version belongs to a different workflow', async () => {
      const OTHER_WORKFLOW = 'cmjbv4i3x00003wsloputaaaa';
      const VERSION_ID = 'cmjbv4i3x00003wsloputvv01';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue({
        id: VERSION_ID,
        workflowId: OTHER_WORKFLOW,
        version: 1,
        snapshot: ALT_DEF,
      } as never);

      const response = await POST(
        makeRequest({ inputData: {}, target: 'version', versionId: VERSION_ID }),
        makeParams()
      );

      expect(response.status).toBe(404);
    });

    it('target=version accepts UUID-format versionId (backfilled rows)', async () => {
      const UUID_VERSION_ID = '90740b81-9e64-4839-8036-e800bb2ed143';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(makeWorkflowRow() as never);
      vi.mocked(prisma.aiWorkflowVersion.findUnique).mockResolvedValue({
        id: UUID_VERSION_ID,
        workflowId: WORKFLOW_ID,
        version: 1,
        snapshot: makeValidDefinition(),
      } as never);

      const response = await POST(
        makeRequest({ inputData: {}, target: 'version', versionId: UUID_VERSION_ID }),
        makeParams()
      );

      expect(response.status).toBe(200);
    });

    it('target=version 400s when versionId is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const response = await POST(makeRequest({ inputData: {}, target: 'version' }), makeParams());
      expect(response.status).toBe(400);
    });

    it('target=published (default) 400s when the workflow has no published version', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
        ...makeWorkflowRow(),
        publishedVersion: null,
        publishedVersionId: null,
      } as never);

      const response = await POST(makeRequest({ inputData: {} }), makeParams());

      expect(response.status).toBe(400);
    });
  });
});
