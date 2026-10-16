/**
 * Tests: lib/auth/support-principal.ts — what a support session presents (§121 t-824)
 *
 * The guards are driven end to end in `guards-support.test.ts`; this pins the
 * three helpers' own answers, including the fail-closed edges.
 */
import { describe, it, expect } from 'vitest';
import {
  isRefusedReadOnlyWrite,
  isSupportEntry,
  presentedRole,
  presentedSession,
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
