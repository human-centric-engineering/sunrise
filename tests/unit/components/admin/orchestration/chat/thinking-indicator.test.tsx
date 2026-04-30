/**
 * ThinkingIndicator Component Tests
 *
 * Tests the animated dots + status message indicator shown in the
 * assistant message bubble while the LLM is processing.
 *
 * Features tested:
 * - Renders three animated dots
 * - Shows provided status message
 * - Falls back to "Thinking..." when no message
 * - role="status" for accessibility
 * - aria-label reflects the displayed message
 * - Applies custom className
 *
 * @see components/admin/orchestration/chat/thinking-indicator.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ThinkingIndicator } from '@/components/admin/orchestration/chat/thinking-indicator';

describe('ThinkingIndicator', () => {
  it('renders three animated dots', () => {
    render(<ThinkingIndicator />);

    const dots = screen.getByRole('status').querySelectorAll('.animate-bounce');
    expect(dots).toHaveLength(3);
  });

  it('shows fallback "Thinking..." when no message provided', () => {
    render(<ThinkingIndicator />);

    expect(screen.getByText('Thinking\u2026')).toBeInTheDocument();
  });

  it('shows provided status message', () => {
    render(<ThinkingIndicator message="Executing search_documents" />);

    expect(screen.getByText('Executing search_documents')).toBeInTheDocument();
  });

  it('falls back to "Thinking..." for null message', () => {
    render(<ThinkingIndicator message={null} />);

    expect(screen.getByText('Thinking\u2026')).toBeInTheDocument();
  });

  it('has role="status" for accessibility', () => {
    render(<ThinkingIndicator />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('sets aria-label to the displayed message', () => {
    render(<ThinkingIndicator message="Searching..." />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Searching...');
  });

  it('sets aria-label to fallback when no message', () => {
    render(<ThinkingIndicator />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Thinking\u2026');
  });

  it('applies custom className', () => {
    render(<ThinkingIndicator className="mt-4" />);

    expect(screen.getByRole('status').className).toContain('mt-4');
  });

  it('hides dots from assistive technology', () => {
    render(<ThinkingIndicator />);

    const dotsContainer = screen.getByRole('status').querySelector('[aria-hidden="true"]');
    expect(dotsContainer).toBeInTheDocument();
  });
});
