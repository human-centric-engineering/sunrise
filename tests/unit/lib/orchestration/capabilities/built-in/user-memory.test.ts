/**
 * Tests for ReadUserMemoryCapability and WriteUserMemoryCapability.
 *
 * Both capabilities depend on prisma.aiUserMemory. The DB client is fully
 * mocked here — no real database connection is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB client before any module under test is imported.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiUserMemory: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { ReadUserMemoryCapability } =
  await import('@/lib/orchestration/capabilities/built-in/user-memory');
const { WriteUserMemoryCapability } =
  await import('@/lib/orchestration/capabilities/built-in/user-memory');

const findMany = prisma.aiUserMemory.findMany as ReturnType<typeof vi.fn>;
const findUnique = prisma.aiUserMemory.findUnique as ReturnType<typeof vi.fn>;
const upsert = prisma.aiUserMemory.upsert as ReturnType<typeof vi.fn>;

const context = { userId: 'user-1', agentId: 'agent-1' };

/** Build a raw DB row as Prisma would return it. */
function makeRow(key: string, value: string, updatedAt = new Date('2025-01-01T00:00:00Z')) {
  return { key, value, updatedAt };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── ReadUserMemoryCapability ──────────────────────────────────────────────────

describe('ReadUserMemoryCapability', () => {
  it('returns all memories when no key is specified', async () => {
    const rows = [makeRow('language', 'TypeScript'), makeRow('topic', 'agents')];
    findMany.mockResolvedValue(rows);

    const cap = new ReadUserMemoryCapability();
    const result = await cap.execute({}, context);

    expect(result.success).toBe(true);
    expect(result.data?.memories).toHaveLength(2);
    expect(result.data?.memories[0]).toMatchObject({ key: 'language', value: 'TypeScript' });
    expect(result.data?.memories[1]).toMatchObject({ key: 'topic', value: 'agents' });
  });

  it('passes userId and agentId from context to the query', async () => {
    findMany.mockResolvedValue([]);

    const cap = new ReadUserMemoryCapability();
    await cap.execute({}, context);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1', agentId: 'agent-1' }),
      })
    );
  });

  it('filters by key when key is specified', async () => {
    const row = makeRow('language', 'TypeScript');
    findMany.mockResolvedValue([row]);

    const cap = new ReadUserMemoryCapability();
    const result = await cap.execute({ key: 'language' }, context);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ key: 'language' }),
      })
    );
    expect(result.success).toBe(true);
    expect(result.data?.memories).toHaveLength(1);
    expect(result.data?.memories[0].key).toBe('language');
  });

  it('returns an empty memories array when no rows exist', async () => {
    findMany.mockResolvedValue([]);

    const cap = new ReadUserMemoryCapability();
    const result = await cap.execute({}, context);

    expect(result.success).toBe(true);
    expect(result.data?.memories).toEqual([]);
  });

  it('serialises updatedAt as an ISO string', async () => {
    const date = new Date('2025-06-15T12:30:00Z');
    findMany.mockResolvedValue([makeRow('pref', 'dark-mode', date)]);

    const cap = new ReadUserMemoryCapability();
    const result = await cap.execute({}, context);

    expect(result.data?.memories[0].updatedAt).toBe('2025-06-15T12:30:00.000Z');
  });

  it('does not add key to the where clause when key is omitted', async () => {
    findMany.mockResolvedValue([]);

    const cap = new ReadUserMemoryCapability();
    await cap.execute({}, context);

    const calledWhere = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(calledWhere).not.toHaveProperty('key');
  });
});

// ── WriteUserMemoryCapability ─────────────────────────────────────────────────

describe('WriteUserMemoryCapability', () => {
  it('returns action "created" when no prior record exists', async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({});

    const cap = new WriteUserMemoryCapability();
    const result = await cap.execute({ key: 'language', value: 'Rust' }, context);

    expect(result.success).toBe(true);
    expect(result.data?.action).toBe('created');
    expect(result.data?.key).toBe('language');
  });

  it('returns action "updated" when a prior record already exists', async () => {
    findUnique.mockResolvedValue(makeRow('language', 'Python'));
    upsert.mockResolvedValue({});

    const cap = new WriteUserMemoryCapability();
    const result = await cap.execute({ key: 'language', value: 'Rust' }, context);

    expect(result.success).toBe(true);
    expect(result.data?.action).toBe('updated');
    expect(result.data?.key).toBe('language');
  });

  it('looks up the existing record using the compound unique key', async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({});

    const cap = new WriteUserMemoryCapability();
    await cap.execute({ key: 'topic', value: 'testing' }, context);

    expect(findUnique).toHaveBeenCalledWith({
      where: {
        userId_agentId_key: {
          userId: 'user-1',
          agentId: 'agent-1',
          key: 'topic',
        },
      },
    });
  });

  it('calls upsert with the correct create and update payloads', async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({});

    const cap = new WriteUserMemoryCapability();
    await cap.execute({ key: 'project', value: 'sunrise' }, context);

    expect(upsert).toHaveBeenCalledWith({
      where: {
        userId_agentId_key: {
          userId: 'user-1',
          agentId: 'agent-1',
          key: 'project',
        },
      },
      create: {
        userId: 'user-1',
        agentId: 'agent-1',
        key: 'project',
        value: 'sunrise',
      },
      update: {
        value: 'sunrise',
      },
    });
  });
});
