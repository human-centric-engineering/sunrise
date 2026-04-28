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
    complexity: 'beginner',
    description: 'Step-by-step reasoning for complex tasks.',
    chunkCount: 5,
  },
  {
    patternNumber: 2,
    patternName: 'Tree of Thoughts',
    category: 'Reasoning',
    complexity: 'advanced',
    description: 'Explores multiple reasoning paths.',
    chunkCount: 8,
  },
  {
    patternNumber: 3,
    patternName: 'ReAct',
    category: 'Action',
    complexity: null,
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

  it('renders complexity badges when present', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    expect(screen.getByText('beginner')).toBeInTheDocument();
    expect(screen.getByText('advanced')).toBeInTheDocument();
  });

  it('does not render complexity badge when null', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    // Pattern 3 (ReAct) has complexity: null — should show number but no complexity
    const links = screen.getAllByRole('link');
    const reactCard = links[2];
    expect(reactCard).toHaveTextContent('3');
    expect(reactCard).not.toHaveTextContent('beginner');
    expect(reactCard).not.toHaveTextContent('advanced');
    expect(reactCard).not.toHaveTextContent('intermediate');
  });

  it('maps advanced complexity to destructive badge variant', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    const advancedBadge = screen.getByText('advanced');
    expect(advancedBadge.className).toContain('bg-destructive');
  });

  it('maps beginner complexity to default badge variant', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    const beginnerBadge = screen.getByText('beginner');
    expect(beginnerBadge.className).toContain('bg-primary');
  });

  it('maps intermediate complexity to secondary badge variant', () => {
    const patterns: PatternSummary[] = [
      {
        patternNumber: 10,
        patternName: 'Intermediate Pattern',
        category: 'Test',
        complexity: 'intermediate',
        description: 'Test desc.',
        chunkCount: 3,
      },
    ];
    render(<PatternCardGrid patterns={patterns} />);

    const intermediateBadge = screen.getByText('intermediate');
    expect(intermediateBadge.className).toContain('bg-secondary');
  });

  it('renders chunk count as section count', () => {
    render(<PatternCardGrid patterns={MOCK_PATTERNS} />);

    expect(screen.getByText('5 sections')).toBeInTheDocument();
    expect(screen.getByText('8 sections')).toBeInTheDocument();
    expect(screen.getByText('1 section')).toBeInTheDocument();
  });
});
