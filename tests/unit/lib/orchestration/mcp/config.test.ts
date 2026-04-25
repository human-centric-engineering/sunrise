import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpServerConfig: {
      upsert: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { getMcpServerConfig, invalidateMcpConfigCache } from '@/lib/orchestration/mcp/config';

function makeConfigRow(
  overrides: Partial<{
    isEnabled: boolean;
    serverName: string;
    serverVersion: string;
    maxSessionsPerKey: number;
    globalRateLimit: number;
    auditRetentionDays: number;
  }> = {}
) {
  return {
    id: 'config-1',
    slug: 'global',
    isEnabled: false,
    serverName: 'Sunrise MCP Server',
    serverVersion: '1.0.0',
    maxSessionsPerKey: 5,
    globalRateLimit: 60,
    auditRetentionDays: 90,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('getMcpServerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateMcpConfigCache();
  });

  it('calls prisma.mcpServerConfig.upsert with slug global', async () => {
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(makeConfigRow() as never);

    await getMcpServerConfig();

    expect(prisma.mcpServerConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'global' } })
    );
  });

  it('passes the correct create defaults', async () => {
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(makeConfigRow() as never);

    await getMcpServerConfig();

    expect(prisma.mcpServerConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          slug: 'global',
          isEnabled: false,
          serverName: 'Sunrise MCP Server',
          serverVersion: '1.0.0',
          maxSessionsPerKey: 5,
          globalRateLimit: 60,
          auditRetentionDays: 90,
        }),
      })
    );
  });

  it('passes an empty update object to avoid overwriting existing config', async () => {
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(makeConfigRow() as never);

    await getMcpServerConfig();

    expect(prisma.mcpServerConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} })
    );
  });

  it('returns the mapped McpServerState from the DB row', async () => {
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(
      makeConfigRow({ isEnabled: true, serverName: 'Custom MCP', globalRateLimit: 120 }) as never
    );

    const result = await getMcpServerConfig();

    // test-review:accept tobe_true — boolean schema field `isEnabled`; structural assertion on config row
    expect(result.isEnabled).toBe(true);
    expect(result.serverName).toBe('Custom MCP');
    expect(result.globalRateLimit).toBe(120);
    expect(result.serverVersion).toBe('1.0.0');
    expect(result.maxSessionsPerKey).toBe(5);
    expect(result.auditRetentionDays).toBe(90);
  });

  it('returns cached result on second call within TTL', async () => {
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(makeConfigRow() as never);

    await getMcpServerConfig();
    await getMcpServerConfig();

    expect(prisma.mcpServerConfig.upsert).toHaveBeenCalledOnce();
  });

  it('re-fetches after cache is invalidated', async () => {
    vi.mocked(prisma.mcpServerConfig.upsert).mockResolvedValue(makeConfigRow() as never);

    await getMcpServerConfig();
    invalidateMcpConfigCache();
    await getMcpServerConfig();

    expect(prisma.mcpServerConfig.upsert).toHaveBeenCalledTimes(2);
  });

  it('propagates prisma upsert errors', async () => {
    vi.mocked(prisma.mcpServerConfig.upsert).mockRejectedValue(new Error('DB unavailable'));

    await expect(getMcpServerConfig()).rejects.toThrow('DB unavailable');
  });
});

describe('invalidateMcpConfigCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateMcpConfigCache();
  });

  it('forces a fresh DB read on the next getMcpServerConfig call', async () => {
    vi.mocked(prisma.mcpServerConfig.upsert)
      .mockResolvedValueOnce(makeConfigRow({ serverName: 'First' }) as never)
      .mockResolvedValueOnce(makeConfigRow({ serverName: 'Second' }) as never);

    const first = await getMcpServerConfig();
    expect(first.serverName).toBe('First');

    invalidateMcpConfigCache();

    const second = await getMcpServerConfig();
    expect(second.serverName).toBe('Second');
  });
});
