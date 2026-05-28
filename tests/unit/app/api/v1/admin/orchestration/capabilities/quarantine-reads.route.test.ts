/**
 * Unit Test: Quarantine read routes (item #42)
 *
 * Covers the three GET endpoints that surface quarantine state to admin
 * pages — kept in one file because they share the same fixture shape
 * and the same auth + Prisma mocks.
 *
 * - GET /agents/:id/quarantined-capabilities
 *   - 404 on unknown agent
 *   - empty list when no bindings are quarantined
 *   - filters out auto-expired rows
 *   - maps to the QuarantinedCapabilityForAgent shape
 *
 * - GET /capabilities/:id/quarantine-attribution
 *   - 404 on unknown capability
 *   - { attribution: null } when capability is active
 *   - { attribution: null } when no audit row exists
 *   - actor falls back to email when name is null
 *
 * - GET /observability/active-quarantines
 *   - empty list when nothing is quarantined
 *   - filters out auto-expired rows
 *   - returns the ActiveQuarantineRow shape
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { mockAdminUser } from '@/tests/helpers/auth';

// ─── Mock dependencies (must precede route imports) ──────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

const mockAgentFindUnique = vi.fn();
const mockBindingFindMany = vi.fn();
const mockCapFindUnique = vi.fn();
const mockCapFindMany = vi.fn();
const mockAuditFindFirst = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: { findUnique: (...a: unknown[]) => mockAgentFindUnique(...a) },
    aiAgentCapability: { findMany: (...a: unknown[]) => mockBindingFindMany(...a) },
    aiCapability: {
      findUnique: (...a: unknown[]) => mockCapFindUnique(...a),
      findMany: (...a: unknown[]) => mockCapFindMany(...a),
    },
    aiAdminAuditLog: { findFirst: (...a: unknown[]) => mockAuditFindFirst(...a) },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { GET as GET_AGENT_QUARANTINED } from '@/app/api/v1/admin/orchestration/agents/[id]/quarantined-capabilities/route';
import { GET as GET_ATTRIBUTION } from '@/app/api/v1/admin/orchestration/capabilities/[id]/quarantine-attribution/route';
import { GET as GET_ACTIVE_QUARANTINES } from '@/app/api/v1/admin/orchestration/observability/active-quarantines/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwul';
const CAP_ID = 'cmjbv4i3x00013wsloputgwul';

function makeGetRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/test`,
  } as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
});

// ─── /agents/:id/quarantined-capabilities ────────────────────────────────────

describe('GET /agents/:id/quarantined-capabilities', () => {
  it('returns 404 when the agent does not exist', async () => {
    mockAgentFindUnique.mockResolvedValue(null);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    expect(res.status).toBe(404);
  });

  it('returns an empty list when no bindings are quarantined', async () => {
    mockAgentFindUnique.mockResolvedValue({ id: AGENT_ID });
    mockBindingFindMany.mockResolvedValue([]);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.items).toEqual([]);
  });

  it('maps quarantined bindings to the response shape', async () => {
    mockAgentFindUnique.mockResolvedValue({ id: AGENT_ID });
    mockBindingFindMany.mockResolvedValue([
      {
        capability: {
          id: 'cap-1',
          slug: 'stripe_charge',
          name: 'Stripe Charge',
          quarantineState: 'quarantined-soft',
          quarantineReason: 'Vendor outage',
          quarantineUntil: null,
        },
      },
    ]);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    const body = await res.json();
    expect(body.data.items).toEqual([
      {
        capabilityId: 'cap-1',
        capabilitySlug: 'stripe_charge',
        capabilityName: 'Stripe Charge',
        mode: 'quarantined-soft',
        reason: 'Vendor outage',
        expiresAt: null,
      },
    ]);
  });

  it('filters out bindings whose quarantineUntil has already passed', async () => {
    mockAgentFindUnique.mockResolvedValue({ id: AGENT_ID });
    mockBindingFindMany.mockResolvedValue([
      {
        capability: {
          id: 'cap-expired',
          slug: 'expired',
          name: 'Expired',
          quarantineState: 'quarantined-soft',
          quarantineReason: 'old',
          quarantineUntil: new Date(Date.now() - 60_000),
        },
      },
      {
        capability: {
          id: 'cap-active-q',
          slug: 'active-q',
          name: 'Still Quarantined',
          quarantineState: 'quarantined-hard',
          quarantineReason: 'now',
          quarantineUntil: null,
        },
      },
    ]);
    const res = await GET_AGENT_QUARANTINED(makeGetRequest(), makeParams(AGENT_ID));
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].capabilityId).toBe('cap-active-q');
  });
});

// ─── /capabilities/:id/quarantine-attribution ────────────────────────────────

describe('GET /capabilities/:id/quarantine-attribution', () => {
  it('returns 404 when the capability does not exist', async () => {
    mockCapFindUnique.mockResolvedValue(null);
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    expect(res.status).toBe(404);
  });

  it('returns { attribution: null } when capability is active (no audit query)', async () => {
    mockCapFindUnique.mockResolvedValue({ id: CAP_ID, quarantineState: 'active' });
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.attribution).toBeNull();
    expect(mockAuditFindFirst).not.toHaveBeenCalled();
  });

  it('returns { attribution: null } when no audit row exists for the quarantine', async () => {
    mockCapFindUnique.mockResolvedValue({ id: CAP_ID, quarantineState: 'quarantined-soft' });
    mockAuditFindFirst.mockResolvedValue(null);
    const res = await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID));
    const body = await res.json();
    expect(body.data.attribution).toBeNull();
  });

  it('returns name when present, otherwise email, otherwise null', async () => {
    const at = new Date('2026-05-01T12:00:00Z');
    mockCapFindUnique.mockResolvedValue({ id: CAP_ID, quarantineState: 'quarantined-soft' });

    // Name takes precedence
    mockAuditFindFirst.mockResolvedValueOnce({
      createdAt: at,
      user: { name: 'Jane Doe', email: 'jane@example.com' },
    });
    let body = await (await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID))).json();
    expect(body.data.attribution.actorName).toBe('Jane Doe');
    expect(body.data.attribution.at).toBe(at.toISOString());

    // Email fallback when name is null
    mockAuditFindFirst.mockResolvedValueOnce({
      createdAt: at,
      user: { name: null, email: 'jane@example.com' },
    });
    body = await (await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID))).json();
    expect(body.data.attribution.actorName).toBe('jane@example.com');

    // Null when user row is gone (deleted admin — audit row preserved
    // via onDelete: SetNull on AiAdminAuditLog.user).
    mockAuditFindFirst.mockResolvedValueOnce({ createdAt: at, user: null });
    body = await (await GET_ATTRIBUTION(makeGetRequest(), makeParams(CAP_ID))).json();
    expect(body.data.attribution.actorName).toBeNull();
  });
});

// ─── /observability/active-quarantines ───────────────────────────────────────

describe('GET /observability/active-quarantines', () => {
  it('returns an empty list when nothing is quarantined', async () => {
    mockCapFindMany.mockResolvedValue([]);
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.items).toEqual([]);
  });

  it('returns the ActiveQuarantineRow shape for each quarantined capability', async () => {
    const expiry = new Date('2099-01-01T00:00:00Z');
    mockCapFindMany.mockResolvedValue([
      {
        id: 'cap-1',
        slug: 'stripe_charge',
        name: 'Stripe Charge',
        quarantineState: 'quarantined-soft',
        quarantineReason: 'vendor 5xx',
        quarantineUntil: expiry,
      },
    ]);
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    const body = await res.json();
    expect(body.data.items).toEqual([
      {
        id: 'cap-1',
        slug: 'stripe_charge',
        name: 'Stripe Charge',
        mode: 'quarantined-soft',
        reason: 'vendor 5xx',
        expiresAt: expiry.toISOString(),
      },
    ]);
  });

  it('filters out rows whose quarantineUntil has already passed', async () => {
    mockCapFindMany.mockResolvedValue([
      {
        id: 'cap-expired',
        slug: 'expired',
        name: 'Expired',
        quarantineState: 'quarantined-soft',
        quarantineReason: null,
        quarantineUntil: new Date(Date.now() - 60_000),
      },
    ]);
    const res = await GET_ACTIVE_QUARANTINES(makeGetRequest());
    const body = await res.json();
    expect(body.data.items).toEqual([]);
  });
});
