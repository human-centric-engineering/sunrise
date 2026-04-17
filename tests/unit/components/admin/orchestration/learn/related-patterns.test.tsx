/**
 * RelatedPatterns Component Tests
 *
 * @see components/admin/orchestration/learn/related-patterns.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { RelatedPatterns } from '@/components/admin/orchestration/learn/related-patterns';
import type { RelatedPattern } from '@/lib/orchestration/utils/extract-related-patterns';

describe('RelatedPatterns', () => {
  it('renders nothing when patterns array is empty', () => {
    const { container } = render(<RelatedPatterns patterns={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders "Related:" label and badges', () => {
    const patterns: RelatedPattern[] = [
      { number: 2, name: 'Routing' },
      { number: 5, name: 'Tool Use' },
    ];
    render(<RelatedPatterns patterns={patterns} />);

    expect(screen.getByText('Related:')).toBeInTheDocument();
    expect(screen.getByText('#2 Routing')).toBeInTheDocument();
    expect(screen.getByText('#5 Tool Use')).toBeInTheDocument();
  });

  it('renders pattern number only when name is null', () => {
    const patterns: RelatedPattern[] = [{ number: 14, name: null }];
    render(<RelatedPatterns patterns={patterns} />);

    expect(screen.getByText('#14')).toBeInTheDocument();
  });

  it('renders links to pattern detail pages', () => {
    const patterns: RelatedPattern[] = [{ number: 3, name: 'Parallel' }];
    render(<RelatedPatterns patterns={patterns} />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/admin/orchestration/learn/patterns/3');
  });
});
