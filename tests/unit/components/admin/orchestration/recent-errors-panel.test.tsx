/**
 * Unit Test: RecentErrorsPanel
 *
 * @see components/admin/orchestration/recent-errors-panel.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  RecentErrorsPanel,
  type RecentError,
} from '@/components/admin/orchestration/recent-errors-panel';

// next/link is used by the component — provide a simple anchor stub
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { vi } from 'vitest';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeError = (overrides: Partial<RecentError> = {}): RecentError => ({
  id: 'cmjbv4i3x00003wsloputgwu1',
  errorMessage: 'Connection timeout',
  workflowId: 'cmjbv4i3x00003wsloputgwu2',
  createdAt: '2025-01-01T12:00:00.000Z',
  ...overrides,
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RecentErrorsPanel', () => {
  describe('Heading', () => {
    it('renders "Recent Errors" heading', () => {
      render(<RecentErrorsPanel errors={[]} />);

      expect(screen.getByText('Recent Errors')).toBeInTheDocument();
    });
  });

  describe('Empty state', () => {
    it('shows "No recent errors" when errors is an empty array', () => {
      render(<RecentErrorsPanel errors={[]} />);

      expect(screen.getByText('No recent errors')).toBeInTheDocument();
    });

    it('shows "No recent errors" when errors is null', () => {
      render(<RecentErrorsPanel errors={null} />);

      expect(screen.getByText('No recent errors')).toBeInTheDocument();
    });
  });

  describe('Error items', () => {
    it('renders each error item with truncated ID', () => {
      const error = makeError();
      render(<RecentErrorsPanel errors={[error]} />);

      // Component renders id.slice(0, 8) + "…"
      const truncated = `${error.id.slice(0, 8)}…`;
      expect(screen.getByText(truncated)).toBeInTheDocument();
    });

    it('renders error message for each item', () => {
      render(
        <RecentErrorsPanel errors={[makeError({ errorMessage: 'Database connection failed' })]} />
      );

      expect(screen.getByText('Database connection failed')).toBeInTheDocument();
    });

    it('shows "Unknown error" when errorMessage is null', () => {
      render(<RecentErrorsPanel errors={[makeError({ errorMessage: null })]} />);

      expect(screen.getByText('Unknown error')).toBeInTheDocument();
    });

    it('renders a link to the execution detail page for each error', () => {
      const error = makeError({ id: 'cmjbv4i3x00003wsloputgwu1' });
      render(<RecentErrorsPanel errors={[error]} />);

      const link = screen.getByRole('link');
      expect(link).toHaveAttribute('href', `/admin/orchestration/executions/${error.id}`);
    });

    it('renders multiple error items', () => {
      const errors: RecentError[] = [
        makeError({ id: 'cmjbv4i3x00003wsloputgwua', errorMessage: 'Error A' }),
        makeError({ id: 'cmjbv4i3x00003wsloputgwub', errorMessage: 'Error B' }),
        makeError({ id: 'cmjbv4i3x00003wsloputgwuc', errorMessage: 'Error C' }),
      ];
      render(<RecentErrorsPanel errors={errors} />);

      expect(screen.getByText('Error A')).toBeInTheDocument();
      expect(screen.getByText('Error B')).toBeInTheDocument();
      expect(screen.getByText('Error C')).toBeInTheDocument();

      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(3);
    });
  });
});
