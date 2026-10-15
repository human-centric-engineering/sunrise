/**
 * Tests: who may set an MCP key's own rate limit, and to what (§111 t-811)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/orchestration/mcp/config', () => ({
  getMcpServerConfig: vi.fn().mockResolvedValue({ globalRateLimit: 60 }),
}));
vi.mock('@/lib/auth/admin-viewer', () => ({ administersPlatform: vi.fn() }));

import { assertKeyRateLimitAllowed } from '@/lib/orchestration/mcp/key-rate-limit';
import { administersPlatform } from '@/lib/auth/admin-viewer';
import { getMcpServerConfig } from '@/lib/orchestration/mcp/config';
import { ValidationError } from '@/lib/api/errors';
import type { AuthorizationPrincipal } from '@/lib/auth/authorization';

const orgAdmin: AuthorizationPrincipal = {
  userId: 'u',
  role: 'USER',
  credential: 'session',
  orgId: 'cmorg0000000000000000orgb',
  orgRole: 'ADMIN',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(administersPlatform).mockResolvedValue(false);
});

describe('assertKeyRateLimitAllowed', () => {
  it('passes the server default (no override) without asking anyone', async () => {
    await expect(assertKeyRateLimitAllowed(orgAdmin, null)).resolves.toBeUndefined();
    await expect(assertKeyRateLimitAllowed(orgAdmin, undefined)).resolves.toBeUndefined();
    expect(administersPlatform).not.toHaveBeenCalled();
  });

  it('lets an org admin lower a key to, or below, the server limit', async () => {
    await expect(assertKeyRateLimitAllowed(orgAdmin, 60)).resolves.toBeUndefined();
    await expect(assertKeyRateLimitAllowed(orgAdmin, 5)).resolves.toBeUndefined();
  });

  it('refuses an org admin an override above the server limit, naming it', async () => {
    const attempt = assertKeyRateLimitAllowed(orgAdmin, 61);
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toThrow(/60 requests a minute/);
  });

  it('lets a platform admin set any override, without reading the server limit', async () => {
    vi.mocked(administersPlatform).mockResolvedValue(true);
    await expect(assertKeyRateLimitAllowed(orgAdmin, 10000)).resolves.toBeUndefined();
    expect(getMcpServerConfig).not.toHaveBeenCalled();
  });
});
