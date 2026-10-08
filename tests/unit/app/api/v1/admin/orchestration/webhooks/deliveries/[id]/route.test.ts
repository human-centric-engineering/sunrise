/**
 * Unit Tests: Webhook Delivery DELETE
 *
 * DELETE /api/v1/admin/orchestration/webhooks/deliveries/:id
 *
 * Covers:
 * - Happy path (admin owns parent subscription) → row deleted + audit log
 * - 400 for non-cuid id
 * - 404 when delivery does not exist
 * - 404 when admin does not own parent subscription
 * - 401 unauthenticated
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWebhookDelivery: { findUnique: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

import { DELETE } from '@/app/api/v1/admin/orchestration/webhooks/deliveries/[id]/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

const ADMIN_ID = 'cmjbv4i3x00003wsloputgwul';
const DELIVERY_ID = 'cmjbv4i3x00013wsldeliveryid';

function makeRequest(): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/webhooks/deliveries/${DELIVERY_ID}`,
  } as unknown as NextRequest;
}

describe('DELETE /webhooks/deliveries/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  });

  it('deletes the row and writes an audit entry when admin owns the parent subscription', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      id: DELIVERY_ID,
      status: 'exhausted',
      eventType: 'workflow_failed',
      subscription: { id: 'sub-1', createdBy: ADMIN_ID, url: 'https://x.com' },
    } as never);

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: DELIVERY_ID }),
    });

    expect(res.status).toBe(200);
    expect(prisma.aiWebhookDelivery.delete).toHaveBeenCalledWith({ where: { id: DELIVERY_ID } });
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'webhook_delivery.delete',
        entityType: 'delivery',
        entityId: DELIVERY_ID,
      })
    );
  });

  it('returns 400 for a non-CUID id', async () => {
    const res = await DELETE(
      {
        ...makeRequest(),
        url: 'http://localhost/api/v1/admin/orchestration/webhooks/deliveries/garbage',
      } as unknown as NextRequest,
      { params: Promise.resolve({ id: 'not-a-cuid' }) }
    );

    expect(res.status).toBe(400);
    expect(prisma.aiWebhookDelivery.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when delivery does not exist', async () => {
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(null);

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: DELIVERY_ID }),
    });

    expect(res.status).toBe(404);
    expect(prisma.aiWebhookDelivery.delete).not.toHaveBeenCalled();
  });

  it("returns 404 when delivery's parent subscription belongs to a different admin", async () => {
    // Cross-tenant guard: the lookup row exists but createdBy != calling admin.
    vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue({
      id: DELIVERY_ID,
      status: 'exhausted',
      eventType: 'workflow_failed',
      subscription: { id: 'sub-1', createdBy: 'other-admin', url: 'https://x.com' },
    } as never);

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: DELIVERY_ID }),
    });

    expect(res.status).toBe(404);
    expect(prisma.aiWebhookDelivery.delete).not.toHaveBeenCalled();
  });

  it('returns 401 for unauthenticated requests', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: DELIVERY_ID }),
    });

    expect(res.status).toBe(401);
  });

  describe('orphaned deliveries and the audit entity name', () => {
    const SECRET_URL = 'https://hooks.example.com/in?token=secret';

    function deliveryRow(overrides: Record<string, unknown>) {
      return {
        id: DELIVERY_ID,
        status: 'exhausted',
        eventType: 'workflow_failed',
        destination: 'https://hooks.example.com/in',
        subscription: { createdBy: ADMIN_ID, url: SECRET_URL },
        ...overrides,
      };
    }

    it('lets any admin delete an orphan whose subscription is gone', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        deliveryRow({ subscription: null }) as never
      );

      const res = await DELETE(makeRequest(), { params: Promise.resolve({ id: DELIVERY_ID }) });

      expect(res.status).toBe(200);
      expect(prisma.aiWebhookDelivery.delete).toHaveBeenCalledWith({ where: { id: DELIVERY_ID } });
    });

    it('still returns 404 and deletes nothing for a non-creator on a live subscription', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        deliveryRow({ subscription: { createdBy: 'other-admin', url: SECRET_URL } }) as never
      );

      const res = await DELETE(makeRequest(), { params: Promise.resolve({ id: DELIVERY_ID }) });

      expect(res.status).toBe(404);
      expect(prisma.aiWebhookDelivery.delete).not.toHaveBeenCalled();
      expect(logAdminAction).not.toHaveBeenCalled();
    });

    it('reads the delivery destination in the lookup so the audit name does not need the subscription URL', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(deliveryRow({}) as never);

      await DELETE(makeRequest(), { params: Promise.resolve({ id: DELIVERY_ID }) });

      const arg = vi.mocked(prisma.aiWebhookDelivery.findUnique).mock.calls[0][0];
      expect(arg?.select).toMatchObject({
        destination: true,
        subscription: { select: { createdBy: true } },
      });
      // The full subscription URL (which may carry a secret) is never selected.
      expect(JSON.stringify(arg?.select)).not.toContain('url');
    });

    it('audits the delivery destination, never the subscription URL', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(deliveryRow({}) as never);

      await DELETE(makeRequest(), { params: Promise.resolve({ id: DELIVERY_ID }) });

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ entityName: 'https://hooks.example.com/in' })
      );
      for (const call of vi.mocked(logAdminAction).mock.calls) {
        expect(JSON.stringify(call)).not.toContain('token=secret');
      }
    });

    it('falls back to the delivery id as the audit name when no destination was recorded', async () => {
      vi.mocked(prisma.aiWebhookDelivery.findUnique).mockResolvedValue(
        deliveryRow({ destination: null }) as never
      );

      await DELETE(makeRequest(), { params: Promise.resolve({ id: DELIVERY_ID }) });

      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ entityName: DELIVERY_ID })
      );
      for (const call of vi.mocked(logAdminAction).mock.calls) {
        expect(JSON.stringify(call)).not.toContain('token=secret');
      }
    });
  });
});
