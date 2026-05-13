/**
 * PatternDetailSections Component Tests
 *
 * @see components/admin/orchestration/learn/pattern-detail-sections.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PatternDetailSections } from '@/components/admin/orchestration/learn/pattern-detail-sections';
import type { AiKnowledgeChunk } from '@/types/orchestration';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/components/admin/orchestration/learn/pattern-content', () => ({
  PatternContent: ({ content }: { content: string }) => (
    <div data-testid="pattern-content">{content}</div>
  ),
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<AiKnowledgeChunk> = {}): AiKnowledgeChunk {
  return {
    id: 'chunk-1',
    chunkKey: 'key-1',
    documentId: 'doc-1',
    content: 'Some content here.',
    chunkType: 'pattern_section',
    patternNumber: 1,
    patternName: 'Test Pattern',
    section: 'how_it_works',
    keywords: null,
    estimatedTokens: 100,
    embeddingModel: null,
    embeddingProvider: null,
    embeddedAt: null,
    metadata: null,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PatternDetailSections', () => {
  it('renders an accordion item for each chunk', () => {
    const chunks = [
      makeChunk({ id: 'c1', section: 'how_it_works' }),
      makeChunk({ id: 'c2', section: 'when_to_use' }),
      makeChunk({ id: 'c3', section: 'pitfalls' }),
    ];

    render(<PatternDetailSections chunks={chunks} />);

    expect(screen.getByText('how it works')).toBeInTheDocument();
    expect(screen.getByText('when to use')).toBeInTheDocument();
    expect(screen.getByText('pitfalls')).toBeInTheDocument();
  });

  it('replaces underscores with spaces in section names', () => {
    const chunks = [makeChunk({ id: 'c1', section: 'code_example' })];

    render(<PatternDetailSections chunks={chunks} />);

    expect(screen.getByText('code example')).toBeInTheDocument();
  });

  it('shows "Details" when section is null', () => {
    const chunks = [makeChunk({ id: 'c1', section: null })];

    render(<PatternDetailSections chunks={chunks} />);

    expect(screen.getByText('Details')).toBeInTheDocument();
  });

  it('all sections are collapsed by default', () => {
    const chunks = [
      makeChunk({ id: 'c1', section: 'how_it_works', content: 'Body text A' }),
      makeChunk({ id: 'c2', section: 'when_to_use', content: 'Body text B' }),
    ];

    render(<PatternDetailSections chunks={chunks} />);

    // When accordion is collapsed, content is not rendered in the DOM.
    // Verify trigger buttons exist but content is not visible.
    const triggers = screen.getAllByRole('button');
    expect(triggers.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryAllByTestId('pattern-content')).toHaveLength(0);
  });

  it('strips embedding prefix from content when section is expanded', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    const chunks = [
      makeChunk({
        id: 'c1',
        section: 'overview',
        content: 'Pattern Name — Overview\n\nActual content here.',
      }),
    ];

    render(<PatternDetailSections chunks={chunks} />);

    // Expand the section
    await user.click(screen.getByText('overview'));

    // The PatternContent mock renders content as text — prefix should be stripped
    expect(screen.getByText('Actual content here.')).toBeInTheDocument();
  });
});
