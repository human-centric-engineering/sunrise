import { describe, it, expect, vi, beforeEach } from 'vitest';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpApiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';
import {
  generateApiKey,
  hashApiKey,
  authenticateMcpRequest,
  hasScope,
} from '@/lib/orchestration/mcp/auth';
import type { McpAuthContext } from '@/types/mcp';

const CLIENT_IP = '127.0.0.1';
const USER_AGENT = 'test-agent/1.0';

function makeMcpApiKey(
  overrides: Partial<{
    id: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    scopes: string[];
    scopedAgentId: string | null;
    scope: unknown;
    createdBy: string;
    isActive: boolean;
    expiresAt: Date | null;
    orgId: string | null;
    org: { status: string } | null;
  }> = {}
) {
  return {
    orgId: null,
    org: null,
    id: 'key-id-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'smcp_abc',
    scopes: ['tools:list', 'tools:execute'],
    scopedAgentId: null,
    scope: null,
    createdBy: 'user-id-1',
    isActive: true,
    expiresAt: null,
    ...overrides,
  };
}

describe('generateApiKey', () => {
  it('returns plaintext, hash, and prefix', () => {
    const result = generateApiKey();
    expect(result).toHaveProperty('plaintext');
    expect(result).toHaveProperty('hash');
    expect(result).toHaveProperty('prefix');
  });

  it('plaintext starts with smcp_ prefix', () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.startsWith('smcp_')).toBe(true);
  });

  it('prefix is the first 12 characters of plaintext', () => {
    const { plaintext, prefix } = generateApiKey();
    expect(prefix).toBe(plaintext.slice(0, 12));
  });

  it('prefix starts with smcp_', () => {
    const { prefix } = generateApiKey();
    expect(prefix.startsWith('smcp_')).toBe(true);
  });

  it('hash is a 64-character hex string (SHA-256)', () => {
    const { hash } = generateApiKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash matches SHA-256 of the plaintext', () => {
    const { plaintext, hash } = generateApiKey();
    expect(hashApiKey(plaintext)).toBe(hash);
  });

  it('generates unique keys on each call', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it('plaintext uses only base62 characters after the prefix', () => {
    const { plaintext } = generateApiKey();
    const encoded = plaintext.slice('smcp_'.length);
    expect(encoded).toMatch(/^[0-9A-Za-z]+$/);
  });

  it('encodes a 32-character base62 body (rejection sampling preserves length)', () => {
    const { plaintext } = generateApiKey();
    expect(plaintext.slice('smcp_'.length)).toHaveLength(32);
  });
});

describe('hashApiKey', () => {
  it('returns a 64-character hex string', () => {
    expect(hashApiKey('smcp_test')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const input = 'smcp_deterministic';
    expect(hashApiKey(input)).toBe(hashApiKey(input));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashApiKey('smcp_aaa')).not.toBe(hashApiKey('smcp_bbb'));
  });
});

describe('authenticateMcpRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TENANCY_MODE = 'single';
  });

  it('returns null when bearer token is empty', async () => {
    const result = await authenticateMcpRequest('', CLIENT_IP, USER_AGENT);
    expect(result).toBeNull();
  });

  it('returns null when token does not start with smcp_', async () => {
    const result = await authenticateMcpRequest('sk_live_abc123', CLIENT_IP, USER_AGENT);
    expect(result).toBeNull();
  });

  it('returns null when key is not found in DB', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);
    const result = await authenticateMcpRequest('smcp_unknownkey', CLIENT_IP, USER_AGENT);
    expect(result).toBeNull();
  });

  it('returns null when key is inactive', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ isActive: false }) as never
    );
    const result = await authenticateMcpRequest('smcp_validtoken', CLIENT_IP, USER_AGENT);
    expect(result).toBeNull();
  });

  it('returns null when key is expired', async () => {
    const past = new Date(Date.now() - 1000);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ expiresAt: past }) as never
    );
    const result = await authenticateMcpRequest('smcp_validtoken', CLIENT_IP, USER_AGENT);
    expect(result).toBeNull();
  });

  it('returns auth context for a valid, active, non-expired key', async () => {
    const future = new Date(Date.now() + 86_400_000);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ expiresAt: future }) as never
    );
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue({} as never);

    const result = await authenticateMcpRequest('smcp_validtoken', CLIENT_IP, USER_AGENT);
    expect(result).not.toBeNull();
    expect(result?.apiKeyId).toBe('key-id-1');
    expect(result?.apiKeyName).toBe('Test Key');
    expect(result?.scopes).toEqual(['tools:list', 'tools:execute']);
    expect(result?.clientIp).toBe(CLIENT_IP);
    expect(result?.userAgent).toBe(USER_AGENT);
  });

  it('returns auth context for a key with no expiry', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ expiresAt: null }) as never
    );
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue({} as never);

    const result = await authenticateMcpRequest('smcp_noexpiry', CLIENT_IP, USER_AGENT);
    expect(result).not.toBeNull();
    expect(result?.createdBy).toBe('user-id-1');
  });

  it('fires lastUsedAt update as fire-and-forget', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(makeMcpApiKey() as never);
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue({} as never);

    await authenticateMcpRequest('smcp_validtoken', CLIENT_IP, USER_AGENT);

    expect(prisma.mcpApiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'key-id-1' },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      })
    );
  });

  it('still returns auth context even if lastUsedAt update fails', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(makeMcpApiKey() as never);
    vi.mocked(prisma.mcpApiKey.update).mockRejectedValue(new Error('DB write failed'));

    const result = await authenticateMcpRequest('smcp_validtoken', CLIENT_IP, USER_AGENT);
    expect(result).not.toBeNull();
  });

  it('looks up key by SHA-256 hash of the bearer token', async () => {
    const token = 'smcp_testtoken123';
    const expectedHash = hashApiKey(token);
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(null);

    await authenticateMcpRequest(token, CLIENT_IP, USER_AGENT);

    expect(prisma.mcpApiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { keyHash: expectedHash } })
    );
  });

  it('surfaces a valid persisted key scope on the auth context', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ scope: { projectId: 'proj-42' } }) as never
    );
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue({} as never);

    const result = await authenticateMcpRequest('smcp_scoped', CLIENT_IP, USER_AGENT);
    expect(result?.scope).toEqual({ projectId: 'proj-42' });
  });

  it('omits scope from the context when the key carries none (null)', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ scope: null }) as never
    );
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue({} as never);

    const result = await authenticateMcpRequest('smcp_unscoped', CLIENT_IP, USER_AGENT);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('scope');
  });

  it('drops a malformed persisted scope (non-string values) and authenticates unscoped', async () => {
    const { logger } = await import('@/lib/logging');
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ scope: { projectId: 42 } }) as never
    );
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue({} as never);

    const result = await authenticateMcpRequest('smcp_badscope', CLIENT_IP, USER_AGENT);
    // Auth still succeeds — a bad row must not lock the caller out.
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('scope');
    expect(logger.warn).toHaveBeenCalledWith(
      'MCP auth: dropped malformed key scope',
      expect.objectContaining({ keyPrefix: 'smcp_abc' })
    );
  });
});

describe('authenticateMcpRequest — the org the key acts for (§106, t-673)', () => {
  const OTHER = 'cmorg000000000000000other';

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TENANCY_MODE = 'single';
    vi.mocked(prisma.mcpApiKey.update).mockResolvedValue({} as never);
  });

  it('reads the org’s status with the key — one query, no second read', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ orgId: OTHER, org: { status: 'ACTIVE' } }) as never
    );
    const result = await authenticateMcpRequest('smcp_bound', CLIENT_IP, USER_AGENT);
    expect(result?.orgId).toBe(OTHER);
    expect(prisma.mcpApiKey.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.mcpApiKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ include: { org: { select: { status: true } } } })
    );
  });

  it('a key minted before the column was written is the install org at single', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(makeMcpApiKey() as never);
    const result = await authenticateMcpRequest('smcp_interim', CLIENT_IP, USER_AGENT);
    expect(result?.orgId).toBe(INSTALL_ORG_ID);
  });

  it('… and is refused at multi', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(makeMcpApiKey() as never);
    expect(await authenticateMcpRequest('smcp_interim', CLIENT_IP, USER_AGENT)).toBeNull();
    // Refused before the key counts as used.
    expect(prisma.mcpApiKey.update).not.toHaveBeenCalled();
  });

  it('a suspended org’s key is refused, and not marked used', async () => {
    vi.mocked(prisma.mcpApiKey.findUnique).mockResolvedValue(
      makeMcpApiKey({ orgId: OTHER, org: { status: 'SUSPENDED' } }) as never
    );
    expect(await authenticateMcpRequest('smcp_suspended', CLIENT_IP, USER_AGENT)).toBeNull();
    expect(prisma.mcpApiKey.update).not.toHaveBeenCalled();
  });
});

describe('hasScope', () => {
  const auth: McpAuthContext = {
    apiKeyId: 'key-1',
    apiKeyName: 'Test',
    scopes: ['tools:list', 'tools:execute'],
    createdBy: 'user-1',
    clientIp: '127.0.0.1',
    userAgent: 'test',
    scopedAgentId: null,
    orgId: INSTALL_ORG_ID,
  };

  it('returns true when the scope is present', () => {
    expect(hasScope(auth, 'tools:list')).toBe(true);
  });

  it('returns true for a second scope', () => {
    expect(hasScope(auth, 'tools:execute')).toBe(true);
  });

  it('returns false when the scope is absent', () => {
    expect(hasScope(auth, 'resources:read')).toBe(false);
  });

  it('returns false when scopes array is empty', () => {
    const noScopes: McpAuthContext = { ...auth, scopes: [] };
    expect(hasScope(noScopes, 'tools:list')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(hasScope(auth, 'Tools:List')).toBe(false);
  });
});
