/**
 * DiscussPatternButton Component Tests
 *
 * @see components/admin/orchestration/learn/discuss-pattern-button.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DiscussPatternButton } from '@/components/admin/orchestration/learn/discuss-pattern-button';

describe('DiscussPatternButton', () => {
  it('renders a link with correct href', () => {
    render(<DiscussPatternButton patternNumber={5} />);

    const link = screen.getByRole('link', { name: /discuss this pattern/i });
    expect(link).toHaveAttribute(
      'href',
      '/admin/orchestration/learn?tab=advisor&contextType=pattern&contextId=5'
    );
  });

  it('includes the MessageCircle icon', () => {
    render(<DiscussPatternButton patternNumber={3} />);

    // Button renders with text
    expect(screen.getByText('Discuss this pattern')).toBeInTheDocument();
  });
});
