// @vitest-environment happy-dom

/**
 * Tests: the maintenance bypass for a support session (§121 t-824)
 *
 * Inside a support session the principal presents as a plain user, which on
 * its own would put a platform admin on the maintenance page everywhere,
 * including the console whose banner is their way back. The wrapper asks the
 * real default policy about who they are outside the org instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/db/client', () => ({ prisma: { featureFlag: { findUnique: vi.fn() } } }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth/session-principal', () => ({ sessionPrincipal: vi.fn() }));
vi.mock('@/components/maintenance-page', () => ({
  MaintenancePage: () => <div data-testid="maintenance-page" />,
}));

import { MaintenanceWrapper } from '@/components/maintenance-wrapper';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { sessionPrincipal } from '@/lib/auth/session-principal';

const ORG = 'cmorg00000000000customer1';
const SUPPORT = { grantId: 'g', level: 'ADMIN' as const, expiresAt: new Date(Date.now() + 60_000) };
/** What sessionPrincipal answers inside a support session. */
const supportView = {
  principal: {
    userId: 'u1',
    role: 'USER',
    credential: 'session' as const,
    orgId: ORG,
    orgRole: 'ADMIN',
  },
  scope: { org: ORG },
  support: SUPPORT,
};

function signedIn(role: 'ADMIN' | 'USER') {
  vi.mocked(auth.api.getSession).mockResolvedValue({
    user: { id: 'u1', role },
    session: { activeOrgId: ORG },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue({
    enabled: true,
    metadata: null,
  } as never);
});

describe('MaintenanceWrapper in a support session', () => {
  it('lets a platform admin through, though the session presents as a plain user', async () => {
    signedIn('ADMIN');
    vi.mocked(sessionPrincipal).mockResolvedValue(supportView);

    render(await MaintenanceWrapper({ children: <span>console</span> }));

    expect(screen.getByText('console')).toBeInTheDocument();
    expect(screen.queryByTestId('maintenance-page')).not.toBeInTheDocument();
  });

  it('still shows the maintenance page to an org ADMIN who is not a platform admin (control)', async () => {
    signedIn('USER');
    vi.mocked(sessionPrincipal).mockResolvedValue({
      principal: { ...supportView.principal },
      scope: { org: ORG },
    });

    render(await MaintenanceWrapper({ children: <span>console</span> }));

    expect(screen.getByTestId('maintenance-page')).toBeInTheDocument();
  });
});
