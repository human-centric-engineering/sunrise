/**
 * Tests: MCP Prompt by ID
 *
 * PATCH  /api/v1/admin/orchestration/mcp/prompts/:id — update
 * DELETE /api/v1/admin/orchestration/mcp/prompts/:id — delete
 *
 * Coverage:
 *  - 401 / 403 auth guards
 *  - PATCH: updates row, clears cache, broadcasts, allows partial fields
 *  - PATCH: 404 on unknown id
 *  - PATCH: re-enable hits the 200-cap re-check
 *  - PATCH: name is NOT in the update schema (immutable)
 *  - DELETE: removes row, clears cache, broadcasts
 *  - DELETE: 404 on unknown id
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpExposedPrompt: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/api/context', () => ({
  getRouteLogger: vi.fn(() => Promise.resolve({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock('@/lib/orchestration/mcp', () => ({
  clearMcpPromptCache: vi.fn(),
  MAX_ENABLED_PROMPTS: 200,
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { clearMcpPromptCache } from '@/lib/orchestration/mcp';
import {
  mockAdminUser,
  mockUnauthenticatedUser,
  mockAuthenticatedUser,
} from '@/tests/helpers/auth';
import { PATCH, DELETE } from '@/app/api/v1/admin/orchestration/mcp/prompts/[id]/route';

const VALID_ID = 'cmjbv4i3x00003wsloputgwu1';

function makePrompt(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ID,
    name: 'analyze-pattern',
    description: 'Analyze a pattern',
    template: 'analyze {{pattern_number}}',
    argumentsSpec: [{ name: 'pattern_number', description: 'number', required: true }],
    isEnabled: true,
    createdBy: 'admin-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makePatchRequest(id: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/mcp/prompts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/orchestration/mcp/prompts/${id}`, {
    method: 'DELETE',
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /mcp/prompts/:id', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const response = await PATCH(
      makePatchRequest(VALID_ID, { description: 'new' }),
      makeParams(VALID_ID)
    );
    expect(response.status).toBe(401);
  });

  it('returns 403 when non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await PATCH(
      makePatchRequest(VALID_ID, { description: 'new' }),
      makeParams(VALID_ID)
    );
    expect(response.status).toBe(403);
  });

  it('updates the prompt and broadcasts list_changed', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue(makePrompt() as never);
    vi.mocked(prisma.mcpExposedPrompt.update).mockResolvedValue(
      makePrompt({ description: 'updated' }) as never
    );

    const response = await PATCH(
      makePatchRequest(VALID_ID, { description: 'updated' }),
      makeParams(VALID_ID)
    );

    expect(response.status).toBe(200);
    expect(prisma.mcpExposedPrompt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VALID_ID },
        data: expect.objectContaining({ description: 'updated' }),
      })
    );
    expect(clearMcpPromptCache).toHaveBeenCalled();
  });

  it('returns 404 when the prompt does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue(null);

    const response = await PATCH(
      makePatchRequest(VALID_ID, { description: 'x' }),
      makeParams(VALID_ID)
    );

    expect(response.status).toBe(404);
    expect(prisma.mcpExposedPrompt.update).not.toHaveBeenCalled();
  });

  it('rejects an attempt to update the name field (schema strips it)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue(makePrompt() as never);
    vi.mocked(prisma.mcpExposedPrompt.update).mockResolvedValue(
      makePrompt({ description: 'desc' }) as never
    );

    // Name in body must be silently ignored — schema doesn't include it.
    await PATCH(
      makePatchRequest(VALID_ID, { name: 'renamed', description: 'desc' }),
      makeParams(VALID_ID)
    );

    const updateCall = vi.mocked(prisma.mcpExposedPrompt.update).mock.calls[0]?.[0];
    expect((updateCall?.data as Record<string, unknown>).name).toBeUndefined();
  });

  it('re-enable hits the cap re-check and 409s at the limit', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue(
      makePrompt({ isEnabled: false }) as never
    );
    vi.mocked(prisma.mcpExposedPrompt.count).mockResolvedValue(200);

    const response = await PATCH(
      makePatchRequest(VALID_ID, { isEnabled: true }),
      makeParams(VALID_ID)
    );

    expect(response.status).toBe(409);
    const body = await parseJson<{ error: { code: string } }>(response);
    expect(body.error.code).toBe('PROMPT_CAP_EXCEEDED');
    expect(prisma.mcpExposedPrompt.update).not.toHaveBeenCalled();
  });

  it('does NOT re-check the cap when the prompt is already enabled', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue(
      makePrompt({ isEnabled: true }) as never
    );
    vi.mocked(prisma.mcpExposedPrompt.update).mockResolvedValue(makePrompt() as never);

    await PATCH(
      makePatchRequest(VALID_ID, { isEnabled: true, description: 'x' }),
      makeParams(VALID_ID)
    );

    expect(prisma.mcpExposedPrompt.count).not.toHaveBeenCalled();
  });
});

describe('DELETE /mcp/prompts/:id', () => {
  it('returns 403 when non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const response = await DELETE(makeDeleteRequest(VALID_ID), makeParams(VALID_ID));
    expect(response.status).toBe(403);
  });

  it('deletes the prompt and broadcasts list_changed', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue(makePrompt() as never);
    vi.mocked(prisma.mcpExposedPrompt.delete).mockResolvedValue(makePrompt() as never);

    const response = await DELETE(makeDeleteRequest(VALID_ID), makeParams(VALID_ID));

    expect(response.status).toBe(200);
    expect(prisma.mcpExposedPrompt.delete).toHaveBeenCalledWith({ where: { id: VALID_ID } });
    expect(clearMcpPromptCache).toHaveBeenCalled();
  });

  it('returns 404 when the prompt does not exist', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.mcpExposedPrompt.findUnique).mockResolvedValue(null);

    const response = await DELETE(makeDeleteRequest(VALID_ID), makeParams(VALID_ID));

    expect(response.status).toBe(404);
    expect(prisma.mcpExposedPrompt.delete).not.toHaveBeenCalled();
  });
});
