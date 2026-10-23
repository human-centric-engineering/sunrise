/**
 * Tests for `lib/orchestration/backup/export-seal.ts` (§122 t-902).
 *
 * The seal is what lets a backup import trust `exportedAt`, so each way a seal
 * must fail to verify is its own case.
 *
 * @see lib/orchestration/backup/export-seal.ts
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

const { SECRET } = vi.hoisted(() => ({
  SECRET: 'test-secret-that-is-at-least-32-characters-long',
}));

vi.mock('@/lib/env', () => ({ env: { BETTER_AUTH_SECRET: SECRET } }));

import { isSealedByThisInstall, sealExportedAt } from '@/lib/orchestration/backup/export-seal';
import { generateApprovalToken } from '@/lib/orchestration/approval-tokens';

const AT = '2026-06-01T09:30:00.000Z';

describe('export seal', () => {
  it('verifies the seal this install made over the same date', () => {
    expect(isSealedByThisInstall(AT, sealExportedAt(AT))).toBe(true);
  });

  it('is an HMAC-SHA256 over the scheme tag and the date, keyed by the install secret', () => {
    const expected = createHmac('sha256', SECRET)
      .update(`orchestration-backup-exported-at\n${AT}`, 'utf8')
      .digest('base64url');
    expect(sealExportedAt(AT)).toBe(expected);
  });

  it('refuses a missing or empty seal', () => {
    expect(isSealedByThisInstall(AT, undefined)).toBe(false);
    expect(isSealedByThisInstall(AT, '')).toBe(false);
  });

  it('refuses a seal over a different date', () => {
    expect(isSealedByThisInstall('2026-06-01T09:30:00.001Z', sealExportedAt(AT))).toBe(false);
  });

  it('refuses a seal another install made, with its own secret', () => {
    const elsewhere = createHmac('sha256', 'another-install-secret-at-least-32-chars')
      .update(`orchestration-backup-exported-at\n${AT}`, 'utf8')
      .digest('base64url');
    expect(isSealedByThisInstall(AT, elsewhere)).toBe(false);
  });

  it('refuses a MAC over the bare date, without the scheme tag', () => {
    const untagged = createHmac('sha256', SECRET).update(AT, 'utf8').digest('base64url');
    expect(isSealedByThisInstall(AT, untagged)).toBe(false);
  });

  it("refuses an approval token's signature, made with the same secret", () => {
    const { token } = generateApprovalToken('cmjbv4i3x00003wsloputgwul', 'approve', 60);
    const [payload, signature] = token.split('.');
    expect(isSealedByThisInstall(payload, signature)).toBe(false);
  });

  it('refuses a truncated seal and one of the wrong length, without throwing', () => {
    const seal = sealExportedAt(AT);
    expect(isSealedByThisInstall(AT, seal.slice(0, -2))).toBe(false);
    expect(isSealedByThisInstall(AT, `${seal}AA`)).toBe(false);
    expect(isSealedByThisInstall(AT, '!!!not base64!!!')).toBe(false);
  });
});
