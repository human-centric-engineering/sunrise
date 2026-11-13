// @vitest-environment happy-dom

/**
 * Admin header breadcrumbs (#1201): how a URL segment gets its label.
 *
 * The order is the design:
 *
 *   1. a label the page registered with `<BreadcrumbLabel>` (a record id)
 *   2. the fork's map, `appSegmentLabels` in `lib/app/admin-breadcrumbs.ts`
 *   3. Sunrise's own labels for its core segments
 *   4. the segment title-cased, unless it has a digit (a record id), which
 *      is left as typed
 *
 * The page title takes 1–3 only. A title-cased record id as a page heading is
 * the bug that rule prevents.
 *
 * The provider and `<BreadcrumbLabel>` are real here, not mocked, so the tests
 * also prove a registration reaches the header and is cleared on unmount.
 *
 * @see components/admin/admin-header.tsx
 * @see components/admin/breadcrumb-context.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const nav = vi.hoisted(() => ({ pathname: '/admin' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
}));

// The fork seam, filled per test. Sunrise ships it empty (pinned in
// tests/unit/lib/app/defaults.test.ts).
const forkLabels = vi.hoisted((): { appSegmentLabels: Record<string, string> } => ({
  appSegmentLabels: {},
}));
vi.mock('@/lib/app/admin-breadcrumbs', () => forkLabels);

vi.mock('@/components/layouts/header-actions', () => ({
  HeaderActions: () => <div data-testid="header-actions" />,
}));

import { AdminHeader } from '@/components/admin/admin-header';
import { BreadcrumbLabel, BreadcrumbProvider } from '@/components/admin/breadcrumb-context';

/** The breadcrumb trail as rendered, in order, excluding the home icon. */
function trail(): string[] {
  const navEl = screen.getByRole('navigation');
  return Array.from(navEl.querySelectorAll('span > span, span > a'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean);
}

function heading(): string {
  return screen.getByRole('heading', { level: 1 }).textContent ?? '';
}

/** The header inside the provider, with pages' registrations beside it, as the layout has it. */
function renderShell(registrations: Array<{ segment: string; label: string }> = []) {
  return render(
    <BreadcrumbProvider>
      <AdminHeader orgTierPages={[]} />
      {registrations.map((r) => (
        <BreadcrumbLabel key={r.segment} segment={r.segment} label={r.label} />
      ))}
    </BreadcrumbProvider>
  );
}

beforeEach(() => {
  nav.pathname = '/admin';
  forkLabels.appSegmentLabels = {};
});

describe('AdminHeader breadcrumbs: the trail', () => {
  it('builds one crumb per segment, ignoring empty ones from stray slashes', () => {
    nav.pathname = '/admin/users/';
    renderShell();
    expect(trail()).toEqual(['Admin', 'Users']);
  });

  it('builds each crumb href from the segments up to it, and does not link the last', () => {
    nav.pathname = '/admin/widgets/w-1/parts';
    renderShell([{ segment: 'w-1', label: 'Blue widget' }]);

    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
    expect(screen.getByRole('link', { name: 'Widgets' })).toHaveAttribute('href', '/admin/widgets');
    expect(screen.getByRole('link', { name: 'Blue widget' })).toHaveAttribute(
      'href',
      '/admin/widgets/w-1'
    );
    expect(screen.queryByRole('link', { name: 'Parts' })).not.toBeInTheDocument();
  });
});

describe('AdminHeader breadcrumbs: the label order', () => {
  it('names a record id with the label its page registered', () => {
    nav.pathname = '/admin/widgets/cmg1abc234xyz';
    renderShell([{ segment: 'cmg1abc234xyz', label: 'Blue widget' }]);

    expect(trail()).toEqual(['Admin', 'Widgets', 'Blue widget']);
    expect(screen.queryByText(/cmg1abc234xyz/i)).not.toBeInTheDocument();
  });

  it('prefers a registered label over the fork map and core', () => {
    nav.pathname = '/admin/users';
    forkLabels.appSegmentLabels = { users: 'People' };
    renderShell([{ segment: 'users', label: 'Registered' }]);

    expect(trail()).toEqual(['Admin', 'Registered']);
  });

  it('prefers the fork map over core, so a fork can rename a core segment', () => {
    nav.pathname = '/admin/users';
    forkLabels.appSegmentLabels = { users: 'People' };
    renderShell();

    expect(trail()).toEqual(['Admin', 'People']);
  });

  it('names a fork segment from the fork map', () => {
    nav.pathname = '/admin/settings-profiles';
    forkLabels.appSegmentLabels = { 'settings-profiles': 'Settings library' };
    renderShell();

    expect(trail()).toEqual(['Admin', 'Settings library']);
  });

  it('uses core labels when nothing else names the segment', () => {
    nav.pathname = '/admin/features';
    renderShell();

    expect(trail()).toEqual(['Admin', 'Feature Flags']);
  });

  it.each([
    ['/admin/orgs', 'Organisations'],
    ['/admin/orchestration/mcp', 'MCP Server'],
    ['/admin/orchestration/event-subscriptions/dlq', 'Dead Letter Queue'],
  ])('names core segments title-casing would get wrong: %s', (pathname, label) => {
    nav.pathname = pathname;
    renderShell();

    expect(trail()).toContain(label);
  });

  it.each([
    ['/admin/some-new-section', 'Some New Section'],
    ['/admin/widgets', 'Widgets'],
    ['/admin/a--b', 'A B'],
  ])('title-cases an unnamed segment: %s → %s', (pathname, label) => {
    nav.pathname = pathname;
    renderShell();

    expect(trail()).toContain(label);
  });

  it('reads only a map’s own entries, so a segment named like an Object property is title-cased', () => {
    nav.pathname = '/admin/constructor';
    renderShell();

    expect(trail()).toEqual(['Admin', 'Constructor']);
    expect(heading()).toBe('Admin');
  });

  it('leaves a segment with a digit as typed, since it is almost always a record id', () => {
    nav.pathname = '/admin/users/cmwf0pagx00005i5nu6plj27x';
    renderShell();

    expect(trail()).toEqual(['Admin', 'Users', 'cmwf0pagx00005i5nu6plj27x']);
  });

  it('drops a page’s label when the page unmounts', () => {
    nav.pathname = '/admin/widgets/w-1';
    const { rerender } = renderShell([{ segment: 'w-1', label: 'Blue widget' }]);
    expect(trail()).toContain('Blue widget');

    rerender(
      <BreadcrumbProvider>
        <AdminHeader orgTierPages={[]} />
      </BreadcrumbProvider>
    );

    expect(trail()).toEqual(['Admin', 'Widgets', 'w-1']);
  });
});

describe('AdminHeader breadcrumbs: two markers for one segment', () => {
  /** A detail layout's marker, with a page's marker for the same id that can come and go. */
  function Shell({ withPage }: { withPage: boolean }) {
    return (
      <BreadcrumbProvider>
        <AdminHeader orgTierPages={[]} />
        <BreadcrumbLabel segment="w-1" label="From the layout" />
        {withPage && <BreadcrumbLabel segment="w-1" label="From the page" />}
      </BreadcrumbProvider>
    );
  }

  it('shows the most recent marker’s label', () => {
    nav.pathname = '/admin/widgets/w-1/parts';
    render(<Shell withPage />);
    expect(trail()).toContain('From the page');
  });

  it('updates a marker’s label in place when its record’s name changes', () => {
    nav.pathname = '/admin/widgets/w-1';
    const { rerender } = render(
      <BreadcrumbProvider>
        <AdminHeader orgTierPages={[]} />
        <BreadcrumbLabel segment="w-1" label="Old name" />
      </BreadcrumbProvider>
    );
    expect(trail()).toContain('Old name');

    rerender(
      <BreadcrumbProvider>
        <AdminHeader orgTierPages={[]} />
        <BreadcrumbLabel segment="w-1" label="New name" />
      </BreadcrumbProvider>
    );
    expect(trail()).toContain('New name');
    expect(trail()).not.toContain('Old name');
  });

  it('moves a marker’s label when its segment changes, leaving none behind', () => {
    nav.pathname = '/admin/widgets/w-2';
    const { rerender } = render(
      <BreadcrumbProvider>
        <AdminHeader orgTierPages={[]} />
        <BreadcrumbLabel segment="w-1" label="Widget" />
      </BreadcrumbProvider>
    );
    rerender(
      <BreadcrumbProvider>
        <AdminHeader orgTierPages={[]} />
        <BreadcrumbLabel segment="w-2" label="Widget" />
      </BreadcrumbProvider>
    );
    expect(trail()).toEqual(['Admin', 'Widgets', 'Widget']);
  });

  it('keeps the layout’s label when the page’s marker unmounts', () => {
    nav.pathname = '/admin/widgets/w-1/parts';
    const { rerender } = render(<Shell withPage />);
    rerender(<Shell withPage={false} />);

    expect(trail()).toContain('From the layout');
    expect(trail()).not.toContain('w-1');
  });
});

describe('AdminHeader breadcrumbs: the page title', () => {
  it('takes a registered label for the last segment', () => {
    nav.pathname = '/admin/widgets/w-1';
    renderShell([{ segment: 'w-1', label: 'Blue widget' }]);

    expect(heading()).toBe('Blue widget');
  });

  it('takes the fork map’s label for the last segment', () => {
    nav.pathname = '/admin/settings-profiles';
    forkLabels.appSegmentLabels = { 'settings-profiles': 'Settings library' };
    renderShell();

    expect(heading()).toBe('Settings library');
  });

  it('falls back to "Admin" rather than showing a record id as the heading', () => {
    nav.pathname = '/admin/widgets/cmg1abc234xyz';
    renderShell();

    expect(trail()).toContain('cmg1abc234xyz');
    expect(heading()).toBe('Admin');
  });

  it('falls back to "Admin" at the root, where there is no last segment', () => {
    nav.pathname = '/';
    renderShell();

    expect(trail()).toEqual([]);
    expect(heading()).toBe('Admin');
  });
});

describe('AdminHeader breadcrumbs: outside the provider', () => {
  it('still renders, with no registered labels', () => {
    nav.pathname = '/admin/widgets/w-1';
    render(
      <>
        <AdminHeader orgTierPages={[]} />
        <BreadcrumbLabel segment="w-1" label="Ignored" />
      </>
    );

    expect(trail()).toEqual(['Admin', 'Widgets', 'w-1']);
  });
});

describe('AdminHeader: the header slot', () => {
  it('renders an empty slot a page can portal into, beside the user actions', () => {
    const { container } = renderShell();

    const slot = container.querySelector('#admin-header-slot');
    expect(slot).not.toBeNull();
    expect(slot?.childElementCount).toBe(0);
    expect(screen.getByTestId('header-actions')).toBeInTheDocument();
  });
});
