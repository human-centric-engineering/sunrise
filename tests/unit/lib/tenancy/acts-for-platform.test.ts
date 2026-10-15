/**
 * Tests: actsForPlatform and canChangeSharedSettings give one answer (§111 t-811)
 *
 * Two copies of one rule — who acts for the platform rather than a customer
 * org — kept apart so module mocks of the context readers keep the shared-
 * settings check working. This holds them together across every case.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, k) => (k === 'TENANCY_MODE' ? mockEnv.TENANCY_MODE : Reflect.get(t, k)),
    }),
  };
});
vi.mock('@/lib/logging', () => {
  const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  return { logger: { ...log, withContext: vi.fn(() => log) } };
});

import { actsForPlatform, runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { canChangeSharedSettings } from '@/lib/tenancy/shared-settings';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const ORG_B = 'cmorg0000000000000000orgb';
const both = () => [actsForPlatform(), canChangeSharedSettings()];

beforeEach(() => {
  mockEnv.TENANCY_MODE = 'multi';
});

describe('actsForPlatform ≡ canChangeSharedSettings', () => {
  it('at multi: the install org and a system scope yes; a customer org and no context no', async () => {
    expect(await runAsOrg(INSTALL_ORG_ID, async () => both())).toEqual([true, true]);
    expect(await runAsSystem('test', async () => both())).toEqual([true, true]);
    expect(await runAsOrg(ORG_B, async () => both())).toEqual([false, false]);
    expect(both()).toEqual([false, false]);
  });

  it('at single: yes, whatever the context', async () => {
    mockEnv.TENANCY_MODE = 'single';
    expect(both()).toEqual([true, true]);
    expect(await runAsOrg(ORG_B, async () => both())).toEqual([true, true]);
  });
});
