/**
 * QuickActions Component Tests
 *
 * Test Coverage:
 * - Renders all four action links
 * - Each link points to the correct route
 * - Each link displays the correct label
 *
 * @see components/admin/orchestration/quick-actions.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { QuickActions } from '@/components/admin/orchestration/quick-actions';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(() => '/admin/orchestration'),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QuickActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders all four action links', () => {
      render(<QuickActions />);

      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(4);
    });

    it('renders "Create agent" link', () => {
      render(<QuickActions />);

      expect(screen.getByRole('link', { name: /create agent/i })).toBeInTheDocument();
    });

    it('renders "Create workflow" link', () => {
      render(<QuickActions />);

      expect(screen.getByRole('link', { name: /create workflow/i })).toBeInTheDocument();
    });

    it('renders "Upload docs" link', () => {
      render(<QuickActions />);

      expect(screen.getByRole('link', { name: /upload docs/i })).toBeInTheDocument();
    });

    it('renders "Open chat" link', () => {
      render(<QuickActions />);

      expect(screen.getByRole('link', { name: /open chat/i })).toBeInTheDocument();
    });
  });

  // ── Hrefs ─────────────────────────────────────────────────────────────────

  describe('link targets', () => {
    it('"Create agent" links to /admin/orchestration/agents/new', () => {
      render(<QuickActions />);

      const link = screen.getByRole('link', { name: /create agent/i });
      expect(link).toHaveAttribute('href', '/admin/orchestration/agents/new');
    });

    it('"Create workflow" links to /admin/orchestration/workflows/new', () => {
      render(<QuickActions />);

      const link = screen.getByRole('link', { name: /create workflow/i });
      expect(link).toHaveAttribute('href', '/admin/orchestration/workflows/new');
    });

    it('"Upload docs" links to /admin/orchestration/knowledge', () => {
      render(<QuickActions />);

      const link = screen.getByRole('link', { name: /upload docs/i });
      expect(link).toHaveAttribute('href', '/admin/orchestration/knowledge');
    });

    it('"Open chat" links to /admin/orchestration/conversations', () => {
      render(<QuickActions />);

      const link = screen.getByRole('link', { name: /open chat/i });
      expect(link).toHaveAttribute('href', '/admin/orchestration/conversations');
    });
  });
});
