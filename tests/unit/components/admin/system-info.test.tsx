// @vitest-environment happy-dom

/**
 * SystemInfo Component Tests
 *
 * The operator-facing half of #531. The platform version came off the
 * unauthenticated `/api/health` payload, so this card is where an operator now
 * reads it — which makes "does it actually render the right field"
 * a contract, not a cosmetic detail.
 *
 * The fixture deliberately gives `appVersion` and `sunriseVersion` **different**
 * values. A card that rendered one field twice, or wired the same value into
 * both slots, is the realistic mistake here and a fixture where they matched
 * could not catch it.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SystemInfo } from '@/components/admin/system-info';
import { BRAND } from '@/lib/brand';
import type { SystemStats } from '@/types/admin';

const APP_VERSION_FIXTURE = '3.1.4';
const SUNRISE_VERSION_FIXTURE = '0.9.0';

function statsFixture(overrides: Partial<SystemStats['system']> = {}): SystemStats {
  return {
    users: {
      total: 0,
      verified: 0,
      recentSignups: 0,
      byRole: { USER: 0, ADMIN: 0 },
    },
    system: {
      nodeVersion: 'v24.1.0',
      appVersion: APP_VERSION_FIXTURE,
      sunriseVersion: SUNRISE_VERSION_FIXTURE,
      environment: 'production',
      uptime: 1234,
      databaseStatus: 'connected',
      ...overrides,
    },
  };
}

describe('SystemInfo', () => {
  it('renders the Sunrise platform version', () => {
    render(<SystemInfo stats={statsFixture()} />);

    expect(screen.getByText('Sunrise platform')).toBeInTheDocument();
    expect(screen.getByText(SUNRISE_VERSION_FIXTURE)).toBeInTheDocument();
  });

  it('renders the app version separately from the platform version', () => {
    // The two are owned by different parties (VERSIONING.md) and in a fork they
    // are different numbers. Both must appear, as distinct values.
    render(<SystemInfo stats={statsFixture()} />);

    expect(screen.getByText(APP_VERSION_FIXTURE)).toBeInTheDocument();
    expect(screen.getByText(SUNRISE_VERSION_FIXTURE)).toBeInTheDocument();
    expect(APP_VERSION_FIXTURE).not.toBe(SUNRISE_VERSION_FIXTURE);
  });

  it('labels the app version with the brand name so a fork reads its own product', () => {
    // Not a hard-coded "App": the label is the seam a fork renames through.
    expect(BRAND.name.length).toBeGreaterThan(0);

    render(<SystemInfo stats={statsFixture()} />);

    expect(screen.getByText(`${BRAND.name} app`)).toBeInTheDocument();
  });

  it('keeps the two labels distinct when the brand name is literally "Sunrise"', () => {
    // Upstream, `BRAND.name` IS "Sunrise" and `APP_VERSION` equals
    // `SUNRISE_VERSION` — so an un-disambiguated card renders the same label
    // over the same number twice and answers nothing. Only a fork that has
    // rebranded would have caught this, which is to say: not the repo the code
    // ships from.
    const collidingBrand = 'Sunrise';
    render(<SystemInfo stats={statsFixture({ appVersion: SUNRISE_VERSION_FIXTURE })} />);

    // Both rows are present and their labels differ, even though their values
    // are now identical.
    expect(screen.queryByText(collidingBrand)).not.toBeInTheDocument();
    expect(screen.getByText('Sunrise platform')).toBeInTheDocument();
    expect(screen.getAllByText(SUNRISE_VERSION_FIXTURE)).toHaveLength(2);
  });

  it('renders the Node version and environment', () => {
    render(<SystemInfo stats={statsFixture()} />);

    expect(screen.getByText('v24.1.0')).toBeInTheDocument();
    expect(screen.getByText('production')).toBeInTheDocument();
  });

  it('renders "unknown" for a version the payload omits, not an empty line', () => {
    // `SystemStats` says `sunriseVersion` is required, but nothing enforces that
    // at runtime: `parseApiResponse` validates the `{ success, data }` envelope
    // and CASTS `data`. So this is a shape the type system permits into the
    // component — during a rolling deploy where a new page hits an old pod, or
    // in a fork that overrides the stats route.
    //
    // Built with `JSON.parse`, which is how the value really arrives, rather
    // than by deleting a key from a literal — the fixture should have travelled
    // the same path as the real payload.
    const withoutPlatformVersion = JSON.parse(
      JSON.stringify(statsFixture(), (key, value) => (key === 'sunriseVersion' ? undefined : value))
    ) as SystemStats;
    expect(withoutPlatformVersion.system).not.toHaveProperty('sunriseVersion');

    render(<SystemInfo stats={withoutPlatformVersion} />);

    // The label is still there, so the row does not silently vanish...
    expect(screen.getByText('Sunrise platform')).toBeInTheDocument();
    // ...and it reads as unknown rather than as a blank the eye skips over.
    expect(screen.getByText('unknown')).toBeInTheDocument();
    // The app version, which IS present, must not be affected.
    expect(screen.getByText(APP_VERSION_FIXTURE)).toBeInTheDocument();
  });

  it('does not crash the page when the payload has no system block at all', () => {
    // One level up from the per-field fallback above, and the same untrusted
    // provenance justifies both: `parseApiResponse` validates the
    // `{ success, data }` envelope and CASTS `data`. An unguarded
    // `stats.system.appVersion` throws `Cannot read properties of undefined`,
    // which 500s the whole of `/admin/overview` — the page an operator opens
    // *because* something is already wrong.
    const noSystem = JSON.parse(
      JSON.stringify(statsFixture(), (key, value) => (key === 'system' ? undefined : value))
    ) as SystemStats;
    expect(noSystem).not.toHaveProperty('system');

    expect(() => render(<SystemInfo stats={noSystem} />)).not.toThrow();
    expect(screen.getByText(/System information is unavailable/i)).toBeInTheDocument();
  });

  it('says so when stats could not be fetched, rather than rendering an empty card', () => {
    // `getStats()` on the overview page returns null on any failure. An empty
    // card would make a broken stats API indistinguishable from a healthy
    // deployment — on the page an operator opens *because* something is wrong.
    render(<SystemInfo stats={null} />);

    expect(screen.getByText(/System information is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Sunrise platform')).not.toBeInTheDocument();
    expect(screen.queryByText(SUNRISE_VERSION_FIXTURE)).not.toBeInTheDocument();
  });
});
