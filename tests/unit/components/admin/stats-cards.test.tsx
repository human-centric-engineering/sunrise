// @vitest-environment happy-dom

/**
 * StatsCards Component Tests
 *
 * The admin dashboard's four summary cards. The component had no test file at
 * all — the only test that rendered its parent mocked it out entirely — so the
 * per-file coverage floor caught it when the role sweep changed one line here.
 *
 * The line that changed is the one worth guarding. The "Admin Users" card used
 * to describe the remainder as `byRole.USER` "regular users", which reads the
 * vocabulary by property name: on an install declaring a third role, that
 * number silently excludes it while "Total Users" still counts it, and the two
 * cards stop reconciling. It is now `total - byRole.ADMIN`, which is correct
 * for any vocabulary — and `total` and `byRole` are both computed with
 * `humanWhere` in the route, so the subtraction is comparing like with like.
 *
 * @see components/admin/stats-cards.tsx · app/api/v1/admin/stats/route.ts
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatsCards } from '@/components/admin/stats-cards';
import type { SystemStats } from '@/types/admin';

function stats(overrides: Partial<SystemStats['users']> = {}): SystemStats {
  return {
    users: {
      total: 100,
      verified: 75,
      recentSignups: 4,
      byRole: { USER: 92, ADMIN: 8 },
      ...overrides,
    },
    system: {
      nodeVersion: 'v24.0.0',
      appVersion: '1.0.0',
      sunriseVersion: '0.11.2',
      environment: 'test',
      uptime: 120,
      databaseStatus: 'connected',
    },
  } as unknown as SystemStats;
}

describe('loading and empty states', () => {
  it('renders skeletons while loading', () => {
    const { container } = render(<StatsCards stats={null} isLoading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders skeletons when there are no stats yet', () => {
    // `stats: null` without `isLoading` is reachable on a failed fetch; the
    // cards must not render "0 of 0" as though it were real data.
    const { container } = render(<StatsCards stats={null} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});

describe('the cards', () => {
  it('shows totals, verified share and recent signups', () => {
    render(<StatsCards stats={stats()} />);

    expect(screen.getByText('100')).toBeTruthy();
    expect(screen.getByText('75')).toBeTruthy();
    expect(screen.getByText('75% of total users')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('does not divide by zero on a fresh install', () => {
    // `total || 1` — a brand-new install has no users, and the card must read
    // 0% rather than NaN.
    render(<StatsCards stats={stats({ total: 0, verified: 0 })} />);
    expect(screen.getByText('0% of total users')).toBeTruthy();
  });

  it('describes the remainder as everyone who is not an admin', () => {
    render(<StatsCards stats={stats()} />);
    expect(screen.getByText('8 admins')).toBeTruthy();
    expect(screen.getByText('92 non-admin users')).toBeTruthy();
  });

  it('counts a role the install declares beyond USER and ADMIN', () => {
    // The regression this guards. With 92 USER + 8 ADMIN + 15 MODERATOR of
    // 115 total, the old `byRole.USER` read would say "92 regular users" and
    // lose the moderators; the subtraction says 107, which reconciles with the
    // "Total Users" card beside it.
    const withThirdRole = stats({
      total: 115,
      byRole: { USER: 92, ADMIN: 8, MODERATOR: 15 },
    } as unknown as Partial<SystemStats['users']>);

    render(<StatsCards stats={withThirdRole} />);

    expect(screen.getByText('107 non-admin users')).toBeTruthy();
    expect(screen.queryByText('92 non-admin users')).toBeNull();
  });
});
