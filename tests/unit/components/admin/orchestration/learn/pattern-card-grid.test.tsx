/**
 * PatternCardGrid Component Tests
 *
 * @see components/admin/orchestration/learn/pattern-card-grid.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PatternCardGrid } from '@/components/admin/orchestration/learn/pattern-card-grid';
import type { PatternSummary } from '@/types/orchestration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PATTERNS: PatternSummary[] = [
  {
    patternNumber: 1,
    patternName: 'Chain of Thought',
    category: 'Reasoning',
    description: 'Step-by-step reasoning for complex tasks.',
    chunkCount: 5,
  },
  {
    patternNumber: 2,
    patternName: 'Tree of Thoughts',
    category: 'Reasoning',
    description: 'Explores multiple reasoning paths.',
    chunkCount: 8,
  },
  {
    patternNumber: 3,
    patternName: 'ReAct',
    category: 'Action',
    description: null,
    chunkCount: 1,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternCardGrid', () => {
  it('renders a card for each pattern', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    expect(screen.getByText('Chain of Thought')).toBeInTheDocument();
    expect(screen.getByText('Tree of Thoughts')).toBeInTheDocument();
    expect(screen.getByText('ReAct')).toBeInTheDocument();
  });

  it('renders category labels when present', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    // Two patterns share the Reasoning category
    expect(screen.getAllByText('Reasoning')).toHaveLength(2);
    expect(screen.getByText('Action')).toBeInTheDocument();
  });

  it('renders pattern number badges', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders empty state when no patterns', () => {
    render(<PatternCardGrid patterns={[]} />);

    expect(screen.getByText(/no patterns found/i)).toBeInTheDocument();
  });

  it('renders links to pattern detail pages', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/admin/orchestration/learn/patterns/1');
    expect(links[1]).toHaveAttribute('href', '/admin/orchestration/learn/patterns/2');
    expect(links[2]).toHaveAttribute('href', '/admin/orchestration/learn/patterns/3');
  });

  it('renders chunk count as section count', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    expect(screen.getByText('5 sections')).toBeInTheDocument();
    expect(screen.getByText('8 sections')).toBeInTheDocument();
    expect(screen.getByText('1 section')).toBeInTheDocument();
  });
});
