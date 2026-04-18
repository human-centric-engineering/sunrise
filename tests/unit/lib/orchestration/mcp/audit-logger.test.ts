import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpAuditLog: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
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
import { logMcpAudit, queryMcpAuditLogs } from '@/lib/orchestration/mcp/audit-logger';

function flushPromises() {
  return new Promise((r) => setTimeout(r, 0));
}

describe('logMcpAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls prisma.mcpAuditLog.create with the entry fields', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockResolvedValue({} as never);

    logMcpAudit({
      apiKeyId: 'key-1',
      method: 'tools/call',
      toolSlug: 'search_kb',
      responseCode: 'success',
      durationMs: 42,
      clientIp: '10.0.0.1',
      userAgent: 'test/1.0',
    });

    await flushPromises();

    expect(prisma.mcpAuditLog.create).toHaveBeenCalledOnce();
    expect(prisma.mcpAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          apiKeyId: 'key-1',
          method: 'tools/call',
          toolSlug: 'search_kb',
          responseCode: 'success',
          durationMs: 42,
          clientIp: '10.0.0.1',
          userAgent: 'test/1.0',
        }),
      })
    );
  });

  it('stores Prisma.JsonNull when requestParams is undefined', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockResolvedValue({} as never);

    logMcpAudit({
      apiKeyId: null,
      method: 'ping',
      responseCode: 'success',
      durationMs: 1,
    });

    await flushPromises();

    const call = vi.mocked(prisma.mcpAuditLog.create).mock.calls[0][0];
    expect(call.data.requestParams).toBe(Prisma.JsonNull);
  });

  it('stores Prisma.JsonNull when requestParams is null', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockResolvedValue({} as never);

    logMcpAudit({
      apiKeyId: null,
      method: 'ping',
      requestParams: null,
      responseCode: 'success',
      durationMs: 1,
    });

    await flushPromises();

    const call = vi.mocked(prisma.mcpAuditLog.create).mock.calls[0][0];
    expect(call.data.requestParams).toBe(Prisma.JsonNull);
  });

  it('redacts password fields in requestParams', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockResolvedValue({} as never);

    logMcpAudit({
      apiKeyId: 'key-1',
      method: 'tools/call',
      requestParams: { username: 'alice', password: 'hunter2' },
      responseCode: 'success',
      durationMs: 5,
    });

    await flushPromises();

    const call = vi.mocked(prisma.mcpAuditLog.create).mock.calls[0][0];
    const stored = call.data.requestParams as Record<string, unknown>;
    expect(stored.password).toBe('[REDACTED]');
    expect(stored.username).toBe('alice');
  });

  it('redacts secret fields in requestParams', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockResolvedValue({} as never);

    logMcpAudit({
      apiKeyId: 'key-1',
      method: 'tools/call',
      requestParams: { apiSecret: 'shh', value: 'ok' },
      responseCode: 'success',
      durationMs: 5,
    });

    await flushPromises();

    const call = vi.mocked(prisma.mcpAuditLog.create).mock.calls[0][0];
    const stored = call.data.requestParams as Record<string, unknown>;
    expect(stored.apiSecret).toBe('[REDACTED]');
    expect(stored.value).toBe('ok');
  });

  it('redacts token fields in requestParams', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockResolvedValue({} as never);

    logMcpAudit({
      apiKeyId: 'key-1',
      method: 'tools/call',
      requestParams: { accessToken: 'tok123', data: 'fine' },
      responseCode: 'success',
      durationMs: 5,
    });

    await flushPromises();

    const call = vi.mocked(prisma.mcpAuditLog.create).mock.calls[0][0];
    const stored = call.data.requestParams as Record<string, unknown>;
    expect(stored.accessToken).toBe('[REDACTED]');
    expect(stored.data).toBe('fine');
  });

  it('redacts key fields in requestParams', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockResolvedValue({} as never);

    logMcpAudit({
      apiKeyId: 'key-1',
      method: 'tools/call',
      requestParams: { apiKey: 'smcp_abc', safe: 'data' },
      responseCode: 'success',
      durationMs: 5,
    });

    await flushPromises();

    const call = vi.mocked(prisma.mcpAuditLog.create).mock.calls[0][0];
    const stored = call.data.requestParams as Record<string, unknown>;
    expect(stored.apiKey).toBe('[REDACTED]');
    expect(stored.safe).toBe('data');
  });

  it('does not throw when prisma.mcpAuditLog.create rejects', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockRejectedValue(new Error('DB error'));

    expect(() =>
      logMcpAudit({
        apiKeyId: null,
        method: 'ping',
        responseCode: 'error',
        durationMs: 0,
      })
    ).not.toThrow();

    await flushPromises();
  });

  it('stores null for optional fields when not provided', async () => {
    vi.mocked(prisma.mcpAuditLog.create).mockResolvedValue({} as never);

    logMcpAudit({
      apiKeyId: null,
      method: 'ping',
      responseCode: 'success',
      durationMs: 1,
    });

    await flushPromises();

    const call = vi.mocked(prisma.mcpAuditLog.create).mock.calls[0][0];
    expect(call.data.toolSlug).toBeNull();
    expect(call.data.resourceUri).toBeNull();
    expect(call.data.errorMessage).toBeNull();
    expect(call.data.clientIp).toBeNull();
    expect(call.data.userAgent).toBeNull();
  });
});

describe('queryMcpAuditLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns items and total from prisma', async () => {
    const fakeItems = [{ id: 'log-1', method: 'tools/call' }];
    vi.mocked(prisma.mcpAuditLog.findMany).mockResolvedValue(fakeItems as never);
    vi.mocked(prisma.mcpAuditLog.count).mockResolvedValue(1);

    const result = await queryMcpAuditLogs({ page: 1, limit: 10 });

    expect(result.items).toEqual(fakeItems);
    expect(result.total).toBe(1);
  });

  it('applies method filter', async () => {
    vi.mocked(prisma.mcpAuditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpAuditLog.count).mockResolvedValue(0);

    await queryMcpAuditLogs({ page: 1, limit: 10, method: 'tools/call' });

    expect(prisma.mcpAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ method: 'tools/call' }) })
    );
  });

  it('applies toolSlug filter', async () => {
    vi.mocked(prisma.mcpAuditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpAuditLog.count).mockResolvedValue(0);

    await queryMcpAuditLogs({ page: 1, limit: 10, toolSlug: 'search_kb' });

    expect(prisma.mcpAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ toolSlug: 'search_kb' }) })
    );
  });

  it('applies pagination skip correctly', async () => {
    vi.mocked(prisma.mcpAuditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpAuditLog.count).mockResolvedValue(0);

    await queryMcpAuditLogs({ page: 3, limit: 20 });

    expect(prisma.mcpAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 40, take: 20 })
    );
  });

  it('applies dateFrom and dateTo filters', async () => {
    vi.mocked(prisma.mcpAuditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpAuditLog.count).mockResolvedValue(0);

    const from = new Date('2026-01-01');
    const to = new Date('2026-02-01');

    await queryMcpAuditLogs({ page: 1, limit: 10, dateFrom: from, dateTo: to });

    expect(prisma.mcpAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: from, lte: to },
        }),
      })
    );
  });

  it('does not include createdAt filter when neither dateFrom nor dateTo is given', async () => {
    vi.mocked(prisma.mcpAuditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpAuditLog.count).mockResolvedValue(0);

    await queryMcpAuditLogs({ page: 1, limit: 10 });

    const call = vi.mocked(prisma.mcpAuditLog.findMany).mock.calls[0]?.[0];
    expect((call?.where as Record<string, unknown>).createdAt).toBeUndefined();
  });

  it('orders results by createdAt desc', async () => {
    vi.mocked(prisma.mcpAuditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.mcpAuditLog.count).mockResolvedValue(0);

    await queryMcpAuditLogs({ page: 1, limit: 10 });

    expect(prisma.mcpAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } })
    );
  });

  it('propagates prisma errors', async () => {
    vi.mocked(prisma.mcpAuditLog.findMany).mockRejectedValue(new Error('Query failed'));
    vi.mocked(prisma.mcpAuditLog.count).mockResolvedValue(0);

    await expect(queryMcpAuditLogs({ page: 1, limit: 10 })).rejects.toThrow('Query failed');
  });
});
