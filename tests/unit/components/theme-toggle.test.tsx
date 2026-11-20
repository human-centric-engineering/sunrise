// @vitest-environment happy-dom

/**
 * ThemeToggle: one button that flips between light and dark, named from
 * the catalogue (§138 t-1073).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import en from '@/lib/i18n/messages/en.json';
import { ThemeToggle } from '@/components/theme-toggle';

const theme = vi.hoisted(() => ({ current: 'light', set: vi.fn() }));
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: theme.current, setTheme: theme.set }),
}));

describe('ThemeToggle', () => {
  beforeEach(() => {
    theme.set.mockReset();
  });

  it('is a button named from the catalogue', () => {
    render(<ThemeToggle />);

    const button = screen.getByRole('button', { name: en.theme.toggle });
    expect(button).toHaveAttribute('title', en.theme.toggle);
  });

  it('switches light to dark', async () => {
    theme.current = 'light';
    render(<ThemeToggle />);

    await userEvent.click(screen.getByRole('button'));

    expect(theme.set).toHaveBeenCalledWith('dark');
  });

  it('switches dark to light', async () => {
    theme.current = 'dark';
    render(<ThemeToggle />);

    await userEvent.click(screen.getByRole('button'));

    expect(theme.set).toHaveBeenCalledWith('light');
  });
});
