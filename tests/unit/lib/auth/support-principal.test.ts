/**
 * Tests: lib/auth/support-principal.ts — what a support session presents (§121 t-824)
 *
 * The guards are driven end to end in `guards-support.test.ts`; this pins the
 * three helpers' own answers, including the fail-closed edges.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ForbiddenError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';
import {
  isRefusedReadOnlyWrite,
  isSupportEntry,
  presentSessionEntry,
  presentedRole,
  presentedSession,
  READ_ONLY_SUPPORT_MESSAGE,
  refuseReadOnlySupportWrite,
} from '@/lib/auth/support-principal';

const support = (level: 'ADMIN' | 'READ_ONLY') => ({ source: 'support', support: { level } });
const member = { source: 'session' };

describe('presentedRole', () => {
  it('replaces the platform role with the default user role inside a support session', () => {
    expect(presentedRole('ADMIN', support('ADMIN'))).toBe('USER');
  });

  it('leaves every other entry, and no entry, as it was', () => {
    expect(presentedRole('ADMIN', member)).toBe('ADMIN');
    expect(presentedRole('ADMIN', null)).toBe('ADMIN');
    expect(presentedRole(undefined, member)).toBeUndefined();
  });
});

describe('presentedSession', () => {
  it('copies the session with the role replaced, never mutating the original', () => {
    const session = { user: { id: 'u1', role: 'ADMIN' }, session: { id: 's1' } };
    const presented = presentedSession(session, support('ADMIN'));

    expect(presented).toEqual({ user: { id: 'u1', role: 'USER' }, session: { id: 's1' } });
    expect(session.user.role).toBe('ADMIN');
  });

  it('returns the same object outside a support session', () => {
    const session = { user: { role: 'ADMIN' } };
    expect(presentedSession(session, member)).toBe(session);
  });
});

describe('isRefusedReadOnlyWrite', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('refuses %s under READ_ONLY', (method) => {
    expect(isRefusedReadOnlyWrite(support('READ_ONLY'), method)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('admits %s under READ_ONLY', (method) => {
    expect(isRefusedReadOnlyWrite(support('READ_ONLY'), method)).toBe(false);
  });

  it('refuses a request with no method rather than reading it as a read', () => {
    expect(isRefusedReadOnlyWrite(support('READ_ONLY'), undefined)).toBe(true);
  });

  it('never refuses at the ADMIN level, or outside support', () => {
    expect(isRefusedReadOnlyWrite(support('ADMIN'), 'POST')).toBe(false);
    expect(isRefusedReadOnlyWrite(member, 'POST')).toBe(false);
    expect(isRefusedReadOnlyWrite(null, 'POST')).toBe(false);
  });
});

describe('isSupportEntry', () => {
  it('is true only for the support source', () => {
    expect(isSupportEntry(support('ADMIN'))).toBe(true);
    expect(isSupportEntry(member)).toBe(false);
    expect(isSupportEntry(undefined)).toBe(false);
  });
});

describe('refuseReadOnlySupportWrite', () => {
  beforeEach(() => vi.mocked(logger.warn).mockClear());

  const readOnly = {
    source: 'support',
    orgId: 'org-b',
    support: { level: 'READ_ONLY', grantId: 'grant-1' },
  };

  it('logs the refusal with the grant, the org and the caller context, then throws a 403', () => {
    expect(() => refuseReadOnlySupportWrite(readOnly, 'POST', { guard: 'withAuth' })).toThrow(
      ForbiddenError
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'tenancy: refused a write under a read-only support grant',
      { guard: 'withAuth', method: 'POST', orgId: 'org-b', grantId: 'grant-1' }
    );
  });

  it('neither logs nor throws for a read, an ADMIN grant or a member', () => {
    refuseReadOnlySupportWrite(readOnly, 'GET');
    refuseReadOnlySupportWrite(support('ADMIN'), 'POST');
    refuseReadOnlySupportWrite(member, 'POST');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('presentSessionEntry', () => {
  beforeEach(() => vi.mocked(logger.warn).mockClear());

  const adminSession = () => ({ user: { id: 'u1', role: 'ADMIN' } });

  it('presents the default user role under an ADMIN grant, for a write too', () => {
    const session = adminSession();
    expect(presentSessionEntry(session, support('ADMIN'), 'POST')).toEqual({
      user: { id: 'u1', role: 'USER' },
    });
    expect(session.user.role).toBe('ADMIN');
  });

  it('presents the default user role for a read under a READ_ONLY grant', () => {
    expect(presentSessionEntry(adminSession(), support('READ_ONLY'), 'GET').user.role).toBe('USER');
  });

  it.each(['POST', 'DELETE', undefined])(
    'refuses %s under a READ_ONLY grant with a 403',
    (method) => {
      const call = () => presentSessionEntry(adminSession(), support('READ_ONLY'), method);
      expect(call).toThrow(ForbiddenError);
      expect(call).toThrow(READ_ONLY_SUPPORT_MESSAGE);
    }
  );

  it("logs a refused write with the user and the caller's context, as the guards do", () => {
    expect(() =>
      presentSessionEntry(adminSession(), support('READ_ONLY'), 'POST', { path: '/api/x' })
    ).toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      'tenancy: refused a write under a read-only support grant',
      expect.objectContaining({ userId: 'u1', method: 'POST', path: '/api/x' })
    );
  });

  it('leaves a member entry unchanged', () => {
    const session = adminSession();
    expect(presentSessionEntry(session, member, 'POST')).toBe(session);
  });
});
