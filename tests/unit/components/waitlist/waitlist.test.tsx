/**
 * <Waitlist /> server wrapper tests (§125 t-974)
 *
 * It renders nothing without a config, refuses an undeclared list, hands the
 * client form only serialisable field data, and reads the open state in the
 * install org — the org the join route writes into.
 *
 * @see components/waitlist/waitlist.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WaitlistConfig } from '@/lib/waitlist/config';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const { mockPrisma, seen } = vi.hoisted(() => ({
  mockPrisma: { waitlistListState: { findFirst: vi.fn() } },
  seen: {
    org: undefined as string | null | undefined,
    context: () => null as { orgId: string | null } | null,
  },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

async function load(config: WaitlistConfig | null) {
  vi.resetModules();
  vi.doMock('@/lib/app/waitlist-config', () => ({ waitlistConfig: config }));
  const mod = await import('@/components/waitlist/waitlist');
  (await import('@/lib/waitlist/config')).__resetWaitlistConfigForTests();
  seen.context = (await import('@/lib/tenancy/context')).getTenantContext;
  return mod.Waitlist;
}

beforeEach(() => {
  vi.clearAllMocks();
  seen.org = undefined;
  mockPrisma.waitlistListState.findFirst.mockImplementation(() => {
    seen.org = seen.context()?.orgId;
    return Promise.resolve(null);
  });
});

describe('<Waitlist />', () => {
  it('renders nothing when the app has no waitlist, and reads nothing', async () => {
    const Waitlist = await load(null);
    expect(await Waitlist({})).toBeNull();
    expect(mockPrisma.waitlistListState.findFirst).not.toHaveBeenCalled();
  });

  it('renders nothing for a list the config does not declare', async () => {
    const Waitlist = await load({ consentVersion: 'v1' });
    expect(await Waitlist({ list: 'nope' })).toBeNull();
  });

  it('hands the form the first list, its open state from the install org, and plain fields', async () => {
    // Arrange — a fork field carrying something that cannot cross to the client
    const field = {
      key: 'role',
      label: 'Role',
      kind: 'select' as const,
      options: [{ value: 'dj', label: 'DJ' }],
      internalNote: () => 'not serialisable',
    };
    const Waitlist = await load({
      consentVersion: 'v1',
      fields: [field],
      lists: [{ key: 'alpha', startsClosed: true }, { key: 'beta' }],
    });

    // Act
    const element = await Waitlist({ copy: { submitLabel: 'Go' } });

    // Assert
    expect(element?.props).toEqual({
      fields: [
        { key: 'role', label: 'Role', kind: 'select', options: [{ value: 'dj', label: 'DJ' }] },
      ],
      list: 'alpha',
      closed: true,
      copy: { submitLabel: 'Go' },
      className: undefined,
    });
    expect(seen.org).toBe(INSTALL_ORG_ID);
  });
});
