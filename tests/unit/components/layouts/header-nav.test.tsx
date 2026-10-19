// @vitest-environment happy-dom

/**
 * HeaderNav — the shared header nav renderer (issue #862)
 *
 * Below `md` the header used to keep its links inline and hide each label with
 * `hidden sm:inline`. The icon is `aria-hidden`, so every link lost its
 * accessible name, and an item with no icon rendered as an empty box. These
 * tests pin the fix: labels are never breakpoint-hidden, and the small-screen
 * view is a named menu listing every item by label.
 *
 * happy-dom applies no CSS, so the inline-label case asserts the class that
 * used to hide it is gone — that class is the defect, and the only way the DOM
 * expresses it.
 *
 * @see components/layouts/header-nav.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Home } from 'lucide-react';
import { HeaderNav, type HeaderNavItem } from '@/components/layouts/header-nav';

const items: HeaderNavItem[] = [
  { href: '/', label: 'Home', icon: Home, isActive: true },
  { href: '/pricing', label: 'Pricing', isActive: false },
];

describe('HeaderNav', () => {
  it('renders every inline link with a label that no breakpoint hides', () => {
    render(<HeaderNav items={items} />);

    const home = screen.getByRole('link', { name: 'Home' });
    const pricing = screen.getByRole('link', { name: 'Pricing' });

    expect(home).toHaveAttribute('href', '/');
    expect(home).toHaveAttribute('aria-current', 'page');
    expect(pricing).toHaveAttribute('href', '/pricing');
    expect(pricing).not.toHaveAttribute('aria-current');

    for (const link of [home, pricing]) {
      const label = within(link).getByText(link.textContent ?? '');
      expect(label).not.toHaveClass('hidden');
    }
  });

  it('offers a named menu that lists every item by label, icon or not', async () => {
    const user = userEvent.setup();
    render(<HeaderNav items={items} />);

    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Home' })).toHaveAttribute('href', '/');
    });
    const home = screen.getByRole('menuitem', { name: 'Home' });
    const pricing = screen.getByRole('menuitem', { name: 'Pricing' });

    expect(home).toHaveAttribute('aria-current', 'page');
    expect(pricing).toHaveAttribute('href', '/pricing');
    expect(pricing).not.toHaveAttribute('aria-current');
  });

  it('renders no nav and no menu button when there are no items', () => {
    const { container } = render(<HeaderNav items={[]} />);

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open navigation menu/i })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });
});
