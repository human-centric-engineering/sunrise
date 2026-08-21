// @vitest-environment happy-dom

/**
 * Unit Tests: <AccountSections /> (#595)
 *
 * The registry decides *what* renders; this covers *that it renders* — the
 * half a fork actually sees. The empty case is the load-bearing one: a slot
 * added to two shipped pages must be invisible until a fork fills it.
 *
 * @see components/account/account-sections.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/app/account-sections', () => ({ initAppAccountSections: vi.fn() }));

import { initAppAccountSections } from '@/lib/app/account-sections';
import {
  registerAccountSection,
  __resetAccountSectionRegistryForTests,
  type AccountSectionProps,
} from '@/lib/account-sections/registry';
import { AccountSections } from '@/components/account/account-sections';

beforeEach(() => {
  __resetAccountSectionRegistryForTests();
  vi.clearAllMocks();
});

describe('AccountSections', () => {
  it('renders nothing at all when no fork has registered a section', () => {
    const { container } = render(<AccountSections surface="profile" userId="user-1" />);

    // Not "renders an empty wrapper" — no node, so the page's `space-y-6`
    // gains no phantom gap on a vanilla install.
    expect(container).toBeEmptyDOMElement();
  });

  it('renders registered sections in order and hands each the user id', () => {
    const Section = ({ userId }: AccountSectionProps) => <p>connected as {userId}</p>;
    vi.mocked(initAppAccountSections).mockImplementation(() => {
      registerAccountSection({ id: 'second', order: 20, Component: () => <p>second</p> });
      registerAccountSection({ id: 'first', order: 10, Component: Section });
    });

    render(<AccountSections surface="settings" userId="user-42" />);

    expect(screen.getByText('connected as user-42')).toBeInTheDocument();
    const rendered = screen.getAllByRole('paragraph').map((el) => el.textContent);
    expect(rendered).toEqual(['connected as user-42', 'second']);
  });

  it('renders only the sections registered for this surface', () => {
    vi.mocked(initAppAccountSections).mockImplementation(() => {
      registerAccountSection({
        id: 'billing',
        surfaces: ['settings'],
        Component: () => <p>billing</p>,
      });
    });

    render(<AccountSections surface="profile" userId="user-1" />);

    expect(screen.queryByText('billing')).not.toBeInTheDocument();
  });
});
