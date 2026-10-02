/**
 * Tests: who may change shared settings (§107 t-751).
 *
 * The rule reads the tenant context, so each case enters the scope a real
 * caller would be in: a session's org, a system scope, or none at all (an
 * unbound admin API key). The guard and the capabilities are tested against
 * it in their own files.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { canChangeSharedSettings } from '@/lib/tenancy/shared-settings';
import { runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const CUSTOMER = 'cmorg00000000000customer';

beforeEach(() => {
  mockEnv.TENANCY_MODE = 'single';
});

describe('canChangeSharedSettings', () => {
  describe('at multi', () => {
    beforeEach(() => {
      mockEnv.TENANCY_MODE = 'multi';
    });

    it('refuses inside a customer org', async () => {
      expect(await runAsOrg(CUSTOMER, async () => canChangeSharedSettings())).toBe(false);
    });

    it('allows inside the install org', async () => {
      expect(await runAsOrg(INSTALL_ORG_ID, async () => canChangeSharedSettings())).toBe(true);
    });

    it('allows with no org entered — an unbound admin API key acts as the install org', () => {
      expect(canChangeSharedSettings()).toBe(true);
    });

    it('allows a system scope, which has no org', async () => {
      expect(
        await runAsSystem('test: shared settings', async () => canChangeSharedSettings())
      ).toBe(true);
    });
  });

  it('allows any org at single, where the install org is the only one', async () => {
    expect(await runAsOrg(CUSTOMER, async () => canChangeSharedSettings())).toBe(true);
  });
});
