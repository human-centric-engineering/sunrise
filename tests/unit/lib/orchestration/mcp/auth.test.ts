import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    createdBy: string;
    isActive: boolean;
    expiresAt: Date | null;
  }> = {}
) {
  return {
    id: 'key-id-1',
    name: 'Test Key',
    keyHash: 'hash',
    keyPrefix: 'smcp_abc',
    scopes: ['tools:list', 'tools:execute'],
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
});

describe('hasScope', () => {
  const auth: McpAuthContext = {
    apiKeyId: 'key-1',
    apiKeyName: 'Test',
    scopes: ['tools:list', 'tools:execute'],
    createdBy: 'user-1',
    clientIp: '127.0.0.1',
    userAgent: 'test',
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
