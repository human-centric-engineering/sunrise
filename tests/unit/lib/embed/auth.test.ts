/**
 * Tests for `lib/embed/auth.ts`
 *
 * Covers token resolution and origin validation for the embed widget.
 *
 * @see lib/embed/auth.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

// ─── Mocks (declared before imports) ────────────────────────────────────────

const mockFindUnique = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgentEmbedToken: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import {
  isEmbedUserId,
  EMBED_USER_ID_PREFIX,
  resolveEmbedToken,
  isOriginAllowed,
} from '@/lib/embed/auth';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-record-id-1',
    token: 'tok_abc123',
    isActive: true,
    allowedOrigins: ['https://example.com'],
    orgId: null,
    org: null,
    agent: {
      id: 'agent-id-1',
      slug: 'support-bot',
      isActive: true,
    },
    ...overrides,
  };
}

/** Re-compute the expected userId using the same algorithm as the source. */
function expectedUserId(recordId: string, clientIp: string): string {
  const hash = createHash('sha256')
    .update(`embed:${recordId}:${clientIp}`)
    .digest('hex')
    .slice(0, 16);
  return `embed_${hash}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('resolveEmbedToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.TENANCY_MODE = 'single';
  });

  it('returns null when token is not found (findUnique returns null)', async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await resolveEmbedToken('missing-token', '1.2.3.4');

    expect(result).toBeNull();
  });

  it('returns null when token record is inactive (isActive: false)', async () => {
    mockFindUnique.mockResolvedValue(makeTokenRecord({ isActive: false }));

    const result = await resolveEmbedToken('tok_abc123', '1.2.3.4');

    expect(result).toBeNull();
  });

  it('returns null when agent is inactive (agent.isActive: false)', async () => {
    mockFindUnique.mockResolvedValue(
      makeTokenRecord({ agent: { id: 'agent-id-1', slug: 'support-bot', isActive: false } })
    );

    const result = await resolveEmbedToken('tok_abc123', '1.2.3.4');

    expect(result).toBeNull();
  });

  it('returns EmbedContext with correct agentId, agentSlug, and allowedOrigins on success', async () => {
    const record = makeTokenRecord();
    mockFindUnique.mockResolvedValue(record);

    const result = await resolveEmbedToken('tok_abc123', '1.2.3.4');

    expect(result).not.toBeNull();
    expect(result?.agentId).toBe('agent-id-1');
    expect(result?.agentSlug).toBe('support-bot');
    expect(result?.allowedOrigins).toEqual(['https://example.com']);
  });

  it('returns userId with embed_ prefix and 16 hex chars', async () => {
    mockFindUnique.mockResolvedValue(makeTokenRecord());

    const result = await resolveEmbedToken('tok_abc123', '1.2.3.4');

    expect(result?.userId).toMatch(/^embed_[0-9a-f]{16}$/);
  });

  it('userId is deterministic — same token + IP always produces same userId', async () => {
    const record = makeTokenRecord();
    mockFindUnique.mockResolvedValue(record);

    const first = await resolveEmbedToken('tok_abc123', '1.2.3.4');
    mockFindUnique.mockResolvedValue(record);
    const second = await resolveEmbedToken('tok_abc123', '1.2.3.4');

    expect(first?.userId).toBe(second?.userId);
  });

  it('userId matches expected hash derived from record.id and clientIp', async () => {
    const record = makeTokenRecord();
    mockFindUnique.mockResolvedValue(record);

    const result = await resolveEmbedToken('tok_abc123', '10.0.0.1');

    expect(result?.userId).toBe(expectedUserId(record.id, '10.0.0.1'));
  });

  it('different IPs produce different userIds for the same token record', async () => {
    const record = makeTokenRecord();
    mockFindUnique.mockResolvedValue(record);
    const resultA = await resolveEmbedToken('tok_abc123', '1.1.1.1');

    mockFindUnique.mockResolvedValue(record);
    const resultB = await resolveEmbedToken('tok_abc123', '2.2.2.2');

    expect(resultA?.userId).not.toBe(resultB?.userId);
  });

  it('returns null and does not throw when findUnique throws (graceful error handling)', async () => {
    mockFindUnique.mockRejectedValue(new Error('DB connection lost'));

    const result = await resolveEmbedToken('tok_abc123', '1.2.3.4');

    expect(result).toBeNull();
  });
});

describe('resolveEmbedToken — the org the token acts for (§106, t-673)', () => {
  const OTHER = 'cmorg000000000000000other';

  beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.TENANCY_MODE = 'single';
  });

  it('reads the org’s status with the token — one query, no second read', async () => {
    mockFindUnique.mockResolvedValue(makeTokenRecord({ orgId: OTHER, org: { status: 'ACTIVE' } }));
    const result = await resolveEmbedToken('tok_abc123', '1.2.3.4');
    expect(result?.orgId).toBe(OTHER);
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ org: { select: { status: true } } }),
      })
    );
  });

  it('a token minted before the column was written is the install org at single', async () => {
    mockFindUnique.mockResolvedValue(makeTokenRecord());
    expect((await resolveEmbedToken('tok_abc123', '1.2.3.4'))?.orgId).toBe(INSTALL_ORG_ID);
  });

  it('… and is refused at multi', async () => {
    mockEnv.TENANCY_MODE = 'multi';
    mockFindUnique.mockResolvedValue(makeTokenRecord());
    expect(await resolveEmbedToken('tok_abc123', '1.2.3.4')).toBeNull();
  });

  it('a suspended org’s token is refused — the widget on that site stops answering', async () => {
    mockFindUnique.mockResolvedValue(
      makeTokenRecord({ orgId: OTHER, org: { status: 'SUSPENDED' } })
    );
    expect(await resolveEmbedToken('tok_abc123', '1.2.3.4')).toBeNull();
  });
});

describe('isOriginAllowed', () => {
  it('empty allowedOrigins → always returns true (wildcard)', () => {
    expect(isOriginAllowed('https://anything.com', [])).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    expect(isOriginAllowed('https://other.com', [])).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
  });

  it('origin in allowedOrigins → returns true', () => {
    const allowed = ['https://example.com', 'https://app.example.com'];

    expect(isOriginAllowed('https://example.com', allowed)).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    expect(isOriginAllowed('https://app.example.com', allowed)).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
  });

  it('origin NOT in allowedOrigins → returns false', () => {
    const allowed = ['https://example.com'];

    expect(isOriginAllowed('https://attacker.com', allowed)).toBe(false);
  });

  it('null origin with non-empty allowedOrigins → returns false', () => {
    const allowed = ['https://example.com'];

    expect(isOriginAllowed(null, allowed)).toBe(false);
  });
});

describe('isEmbedUserId', () => {
  // The predicate exists so nothing writes a synthetic visitor id into a
  // foreign key to `user`. Both directions matter: a false negative discards a
  // cost row (P2003, swallowed), a false positive silently stops attributing
  // real users' spend.
  it('recognises the id resolveEmbedToken actually mints', () => {
    expect(isEmbedUserId(`${EMBED_USER_ID_PREFIX}0123456789abcdef`)).toBe(true);
  });

  it('does not claim a real user id, a cuid, or an empty/absent value', () => {
    expect(isEmbedUserId('cm3x9k2p40000abcd1234efgh')).toBe(false);
    expect(isEmbedUserId('u1')).toBe(false);
    expect(isEmbedUserId('')).toBe(false);
    expect(isEmbedUserId(null)).toBe(false);
    expect(isEmbedUserId(undefined)).toBe(false);
  });

  it('does not match a user id that merely contains the prefix later on', () => {
    // startsWith, not includes — a real id happening to contain "embed_" is a
    // real user and must keep its attribution.
    expect(isEmbedUserId('user_embed_123')).toBe(false);
  });
});
