// @vitest-environment happy-dom

/**
 * Maintenance Wrapper Component Tests
 *
 * Tests the async Server Components and internal helper in components/maintenance-wrapper.tsx.
 *
 * Test Coverage:
 * - getMaintenanceFlag: prisma returns null → treated as disabled
 * - getMaintenanceFlag: prisma throws → degrades open, logger.error called
 * - MaintenanceWrapper: flag disabled → renders children
 * - MaintenanceWrapper: flag enabled + ADMIN session → renders children (bypass)
 * - MaintenanceWrapper: flag enabled + non-admin session → renders MaintenancePage with metadata props
 * - MaintenanceWrapper: flag enabled + no session → renders MaintenancePage
 * - MaintenanceWrapper: flag enabled + getSession throws → renders MaintenancePage (fail-safe)
 * - MaintenanceWrapperWithAdminNotice: flag disabled → renders children
 * - MaintenanceWrapperWithAdminNotice: flag enabled + ADMIN → renders amber notice banner AND children
 * - MaintenanceWrapperWithAdminNotice: flag enabled + non-admin → renders MaintenancePage
 * - MaintenanceWrapperWithAdminNotice: flag enabled + getSession throws → renders MaintenancePage (fail-safe)
 *
 * @see components/maintenance-wrapper.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Side-effect mocks — must come before any import that transitively pulls
// in @/lib/auth/config, which calls betterAuth({...}) at module scope. ───────
// (Gotcha #13: importing @/lib/auth/config triggers betterAuth init + validateEmailConfig)

vi.mock('better-auth', () => ({
  betterAuth: vi.fn(() => ({ api: { getSession: vi.fn() } })),
}));

vi.mock('better-auth/adapters/prisma', () => ({
  prismaAdapter: vi.fn(() => ({})),
}));

vi.mock('better-auth/api', () => ({
  getOAuthState: vi.fn(),
  // Identity passthrough — lib/auth/config.ts wraps its `hooks.before` body in
  // this at module load, so an unmocked export throws on import (#463).
  createAuthMiddleware: vi.fn((fn: unknown) => fn),
  APIError: class APIError extends Error {},
}));

vi.mock('@/lib/email/client', () => ({
  validateEmailConfig: vi.fn(),
  getResendClient: vi.fn(() => null),
  isEmailEnabled: vi.fn(() => false),
}));

vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/utils/invitation-token', () => ({
  validateInvitationToken: vi.fn(),
  deleteInvitationToken: vi.fn(),
  getValidInvitation: vi.fn(),
}));

// ─── Core dependency mocks ────────────────────────────────────────────────────

vi.mock('next/headers', () => ({
  headers: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    featureFlag: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock MaintenancePage as a sentinel so we can assert exact prop values without
// rendering the full Lucide/Card tree, which has no effect on the assertion logic.
vi.mock('@/components/maintenance-page', () => ({
  MaintenancePage: ({
    message,
    estimatedDowntime,
    isAdmin,
  }: {
    message?: string;
    estimatedDowntime?: string | null;
    isAdmin?: boolean;
  }) => (
    <div data-testid="maintenance-page">
      <span data-testid="mp-message">{message ?? '__default__'}</span>
      <span data-testid="mp-downtime">{estimatedDowntime ?? '__none__'}</span>
      <span data-testid="mp-isAdmin">{String(isAdmin)}</span>
    </div>
  ),
}));

// ─── Now safe to import the module under test ─────────────────────────────────

import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { createMockHeaders, createMockSession } from '@/tests/types/mocks';
import {
  MaintenanceWrapper,
  MaintenanceWrapperWithAdminNotice,
} from '@/components/maintenance-wrapper';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A realistic enabled FeatureFlag row from Prisma */
function makeEnabledFlag(metadata: { message?: string; estimatedDowntime?: string } | null = null) {
  return {
    enabled: true,
    metadata,
  };
}

/** A realistic disabled FeatureFlag row from Prisma */
function makeDisabledFlag() {
  return {
    enabled: false,
    metadata: null,
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('MaintenanceWrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: headers() resolves to a mock Headers object
    vi.mocked(headers).mockResolvedValue(
      createMockHeaders() as unknown as ReturnType<typeof headers> extends Promise<infer T>
        ? T
        : never
    );

    // Default: maintenance flag is disabled (most tests override this)
    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(makeDisabledFlag() as any);

    // Default: no session
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
  });

  // ── 1. Flag disabled → children rendered ────────────────────────────────────
  describe('when MAINTENANCE_MODE flag is disabled', () => {
    it('renders children when flag is disabled in database', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(makeDisabledFlag() as any);

      // Act
      const component = await MaintenanceWrapper({
        children: <span>site content</span>,
      });
      render(component);

      // Assert: children visible; MaintenancePage NOT rendered
      expect(screen.getByText('site content')).toBeInTheDocument();
      expect(screen.queryByTestId('maintenance-page')).not.toBeInTheDocument();
    });

    it('renders children when flag record is null in database (never created)', async () => {
      // Arrange: flag record doesn't exist yet
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);

      // Act
      const component = await MaintenanceWrapper({
        children: <span>site content null flag</span>,
      });
      render(component);

      // Assert: treated as disabled → children shown
      expect(screen.getByText('site content null flag')).toBeInTheDocument();
      expect(screen.queryByTestId('maintenance-page')).not.toBeInTheDocument();
    });
  });

  // ── 2. DB error → degrades open, logger.error called ───────────────────────
  describe('when prisma throws during flag lookup', () => {
    it('degrades open (renders children) and calls logger.error', async () => {
      // Arrange: prisma throws a connection error
      const dbError = new Error('Connection refused');
      vi.mocked(prisma.featureFlag.findUnique).mockRejectedValue(dbError);

      // Act
      const component = await MaintenanceWrapper({
        children: <span>fallback content</span>,
      });
      render(component);

      // Assert: component degrades open — children still visible
      expect(screen.getByText('fallback content')).toBeInTheDocument();
      expect(screen.queryByTestId('maintenance-page')).not.toBeInTheDocument();

      // Assert: logger.error was called with the actual error object
      // (not just any string — verifies the real error path ran)
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'Error checking maintenance mode',
        dbError
      );
    });
  });

  // ── 3. Flag enabled + ADMIN → bypass, children rendered ────────────────────
  describe('when MAINTENANCE_MODE flag is enabled and user is ADMIN', () => {
    it('renders children (admin bypass) and does NOT render MaintenancePage', async () => {
      // Arrange: maintenance is active
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(
        makeEnabledFlag({ message: 'Down for maintenance', estimatedDowntime: '1 hour' }) as any
      );
      // Admin session
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { role: 'ADMIN' } })
      );

      // Act
      const component = await MaintenanceWrapper({
        children: <span>admin sees site</span>,
      });
      render(component);

      // Assert: admin bypasses maintenance
      expect(screen.getByText('admin sees site')).toBeInTheDocument();
      expect(screen.queryByTestId('maintenance-page')).not.toBeInTheDocument();
    });
  });

  // ── 4. Flag enabled + non-admin → MaintenancePage with correct props ────────
  describe('when MAINTENANCE_MODE flag is enabled and user is not ADMIN', () => {
    it('renders MaintenancePage with message and estimatedDowntime from metadata', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(
        makeEnabledFlag({
          message: 'Scheduled maintenance in progress',
          estimatedDowntime: '2 hours',
        }) as any
      );
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { role: 'USER' } })
      );

      // Act
      const component = await MaintenanceWrapper({
        children: <span>should not appear</span>,
      });
      render(component);

      // Assert: children NOT rendered
      expect(screen.queryByText('should not appear')).not.toBeInTheDocument();

      // Assert: MaintenancePage rendered with correct props from metadata
      expect(screen.getByTestId('maintenance-page')).toBeInTheDocument();
      expect(screen.getByTestId('mp-message').textContent).toBe(
        'Scheduled maintenance in progress'
      );
      expect(screen.getByTestId('mp-downtime').textContent).toBe('2 hours');
      // isAdmin prop must be false — the component explicitly passes isAdmin={false}
      expect(screen.getByTestId('mp-isAdmin').textContent).toBe('false');
    });

    it('renders MaintenancePage with undefined message when metadata has no message', async () => {
      // Arrange: flag enabled but metadata has no message key
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(makeEnabledFlag(null) as any);
      vi.mocked(auth.api.getSession).mockResolvedValue(
        createMockSession({ user: { role: 'USER' } })
      );

      // Act
      const component = await MaintenanceWrapper({
        children: <span>unreachable</span>,
      });
      render(component);

      // Assert: MaintenancePage rendered; message falls through as undefined (component uses default)
      expect(screen.getByTestId('maintenance-page')).toBeInTheDocument();
      expect(screen.getByTestId('mp-isAdmin').textContent).toBe('false');
    });

    it('renders MaintenancePage when session resolves to null (no logged-in user)', async () => {
      // Arrange: maintenance active, no session
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(
        makeEnabledFlag({ message: 'Maintenance' }) as any
      );
      vi.mocked(auth.api.getSession).mockResolvedValue(null);

      // Act
      const component = await MaintenanceWrapper({
        children: <span>hidden</span>,
      });
      render(component);

      // Assert: no session → isAdmin stays false → MaintenancePage shown
      expect(screen.getByTestId('maintenance-page')).toBeInTheDocument();
      expect(screen.getByTestId('mp-isAdmin').textContent).toBe('false');
      expect(screen.queryByText('hidden')).not.toBeInTheDocument();
    });
  });

  // ── 5. Flag enabled + getSession throws → fail-safe shows MaintenancePage ──
  describe('when getSession throws during an active maintenance window', () => {
    it('renders MaintenancePage (fail-safe: broken auth check must not expose site)', async () => {
      // Arrange: maintenance active; session check blows up
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(
        makeEnabledFlag({ message: 'Down', estimatedDowntime: '30 minutes' }) as any
      );
      vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Auth service unavailable'));

      // Act
      const component = await MaintenanceWrapper({
        children: <span>must not leak</span>,
      });
      render(component);

      // Assert: the fail-safe kicked in — children NOT visible
      expect(screen.queryByText('must not leak')).not.toBeInTheDocument();

      // Assert: MaintenancePage shown with isAdmin=false (not isAdmin=true which would be the bypass)
      expect(screen.getByTestId('maintenance-page')).toBeInTheDocument();
      expect(screen.getByTestId('mp-isAdmin').textContent).toBe('false');
    });
  });
});

// ─── MaintenanceWrapperWithAdminNotice ────────────────────────────────────────

describe('MaintenanceWrapperWithAdminNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(
      createMockHeaders() as unknown as ReturnType<typeof headers> extends Promise<infer T>
        ? T
        : never
    );
    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(makeDisabledFlag() as any);
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
  });

  // ── 6. Flag disabled → children rendered (same as base wrapper) ─────────────
  it('renders children normally when flag is disabled', async () => {
    // Arrange
    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(makeDisabledFlag() as any);

    // Act
    const component = await MaintenanceWrapperWithAdminNotice({
      children: <span>normal content</span>,
    });
    render(component);

    // Assert
    expect(screen.getByText('normal content')).toBeInTheDocument();
    expect(screen.queryByTestId('maintenance-page')).not.toBeInTheDocument();
    // No amber banner when maintenance is off
    expect(screen.queryByText(/maintenance mode is active/i)).not.toBeInTheDocument();
  });

  // ── 7. Flag enabled + ADMIN → amber notice banner AND children ──────────────
  it('renders amber notice banner AND children when admin bypasses maintenance', async () => {
    // Arrange: maintenance active, admin session
    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(
      makeEnabledFlag({ message: 'Maintenance active' }) as any
    );
    vi.mocked(auth.api.getSession).mockResolvedValue(
      createMockSession({ user: { role: 'ADMIN' } })
    );

    // Act
    const component = await MaintenanceWrapperWithAdminNotice({
      children: <span>admin site content</span>,
    });
    render(component);

    // Assert: the distinctive admin notice text appears
    // The banner is a single DOM text node with this exact content
    expect(
      screen.getByText(
        'Maintenance mode is active. You can access the site because you are an admin.'
      )
    ).toBeInTheDocument();

    // Assert: children are also rendered (not replaced by the banner)
    expect(screen.getByText('admin site content')).toBeInTheDocument();

    // Assert: MaintenancePage is NOT rendered (admin bypass)
    expect(screen.queryByTestId('maintenance-page')).not.toBeInTheDocument();
  });

  // ── 8. Flag enabled + non-admin → MaintenancePage ──────────────────────────
  it('renders MaintenancePage with isAdmin=false when user is not admin', async () => {
    // Arrange
    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(
      makeEnabledFlag({ message: 'System upgrade', estimatedDowntime: '4 hours' }) as any
    );
    vi.mocked(auth.api.getSession).mockResolvedValue(createMockSession({ user: { role: 'USER' } }));

    // Act
    const component = await MaintenanceWrapperWithAdminNotice({
      children: <span>hidden from non-admin</span>,
    });
    render(component);

    // Assert: MaintenancePage shown, children hidden
    expect(screen.getByTestId('maintenance-page')).toBeInTheDocument();
    expect(screen.getByTestId('mp-isAdmin').textContent).toBe('false');
    expect(screen.getByTestId('mp-message').textContent).toBe('System upgrade');
    expect(screen.getByTestId('mp-downtime').textContent).toBe('4 hours');
    expect(screen.queryByText('hidden from non-admin')).not.toBeInTheDocument();
    // Banner must NOT appear for non-admins
    expect(screen.queryByText(/maintenance mode is active/i)).not.toBeInTheDocument();
  });

  // ── 9. Flag enabled + getSession throws → fail-safe shows MaintenancePage ──
  it('renders MaintenancePage (fail-safe) when getSession throws during maintenance', async () => {
    // Arrange
    vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(
      makeEnabledFlag({ message: 'Critical update' }) as any
    );
    vi.mocked(auth.api.getSession).mockRejectedValue(new Error('Session service down'));

    // Act
    const component = await MaintenanceWrapperWithAdminNotice({
      children: <span>must not leak via notice wrapper</span>,
    });
    render(component);

    // Assert: fail-safe engaged — site content hidden, no admin banner
    expect(screen.queryByText('must not leak via notice wrapper')).not.toBeInTheDocument();
    expect(screen.queryByText(/maintenance mode is active/i)).not.toBeInTheDocument();

    // Assert: MaintenancePage shown with isAdmin=false
    expect(screen.getByTestId('maintenance-page')).toBeInTheDocument();
    expect(screen.getByTestId('mp-isAdmin').textContent).toBe('false');
  });
});
