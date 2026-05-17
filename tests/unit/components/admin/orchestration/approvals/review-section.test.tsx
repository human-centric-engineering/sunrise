/**
 * ReviewSection Component Tests
 *
 * Test Coverage:
 * - Renders section title
 * - Renders description when present, omits when absent
 * - Renders item count in title
 * - Empty items array shows empty state
 * - Each item rendered with ReviewItem (verified via item title content)
 * - onItemChange propagated when item Reject is clicked
 *
 * @see components/admin/orchestration/approvals/review-section.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ReviewSection } from '@/components/admin/orchestration/approvals/review-section';
import type { ReviewSection as ReviewSectionSpec } from '@/lib/orchestration/review-schema/types';
import type { ResolvedItem, ItemState } from '@/lib/orchestration/review-schema/resolver';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSection(overrides: Partial<ReviewSectionSpec> = {}): ReviewSectionSpec {
  return {
    id: 'newModels',
    title: 'New Models',
    source: '{{discover.output.newModels}}',
    itemKey: 'slug',
    itemTitle: '{{item.name}}',
    fields: [{ key: 'name', label: 'Name', display: 'text' }],
    ...overrides,
  };
}

function makeItem(slug: string, name: string): ResolvedItem {
  return { __key: slug, slug, name };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReviewSection', () => {
  describe('header rendering', () => {
    it('renders the section title', () => {
      render(
        <ReviewSection
          section={makeSection({ title: 'Proposed Additions' })}
          items={[]}
          state={{}}
          onItemChange={vi.fn()}
        />
      );

      expect(screen.getByText('Proposed Additions')).toBeInTheDocument();
    });

    it('renders description when present', () => {
      render(
        <ReviewSection
          section={makeSection({ description: 'These models are new to the provider.' })}
          items={[]}
          state={{}}
          onItemChange={vi.fn()}
        />
      );

      expect(screen.getByText('These models are new to the provider.')).toBeInTheDocument();
    });

    it('does not render a description paragraph when description is absent', () => {
      const { container } = render(
        <ReviewSection
          section={makeSection({ description: undefined })}
          items={[]}
          state={{}}
          onItemChange={vi.fn()}
        />
      );

      // The header should contain only h3, not a <p> for the description
      const header = container.querySelector('header');
      expect(header?.querySelectorAll('p')).toHaveLength(0);
    });

    it('renders item count in the title area', () => {
      const items = [makeItem('a', 'Alpha'), makeItem('b', 'Beta'), makeItem('c', 'Gamma')];

      render(
        <ReviewSection section={makeSection()} items={items} state={{}} onItemChange={vi.fn()} />
      );

      // The count "(3)" is rendered in a <span> adjacent to the title text
      expect(screen.getByText('(3)')).toBeInTheDocument();
    });

    it('renders "(0)" when items array is empty', () => {
      render(
        <ReviewSection section={makeSection()} items={[]} state={{}} onItemChange={vi.fn()} />
      );

      expect(screen.getByText('(0)')).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows "No items." when items array is empty', () => {
      render(
        <ReviewSection section={makeSection()} items={[]} state={{}} onItemChange={vi.fn()} />
      );

      expect(screen.getByText('No items.')).toBeInTheDocument();
    });

    it('does not show empty state when items are present', () => {
      render(
        <ReviewSection
          section={makeSection()}
          items={[makeItem('a', 'Alpha')]}
          state={{}}
          onItemChange={vi.fn()}
        />
      );

      expect(screen.queryByText('No items.')).not.toBeInTheDocument();
    });
  });

  describe('item rendering', () => {
    it('renders a row for each item via ReviewItem (item titles visible)', () => {
      // ReviewItem renders the itemTitle template — verify by title content,
      // which is what the component actually computes (not a mock return value).
      // The title appears in both the item header <p> and the "Name" field <span>,
      // so we use getAllByText and assert the minimum expected count.
      const items = [
        makeItem('a', 'Alpha Model'),
        makeItem('b', 'Beta Model'),
        makeItem('c', 'Gamma Model'),
      ];

      render(
        <ReviewSection
          section={makeSection({ itemTitle: '{{item.name}}' })}
          items={items}
          state={{}}
          onItemChange={vi.fn()}
        />
      );

      // At least one occurrence of each item name confirms ReviewItem rendered it
      expect(screen.getAllByText('Alpha Model').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Beta Model').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Gamma Model').length).toBeGreaterThanOrEqual(1);
    });

    it('renders a <li> per item in a <ul>', () => {
      const items = [makeItem('a', 'Alpha'), makeItem('b', 'Beta')];

      const { container } = render(
        <ReviewSection section={makeSection()} items={items} state={{}} onItemChange={vi.fn()} />
      );

      const list = container.querySelector('ul');
      expect(list).toBeInTheDocument();
      expect(list?.querySelectorAll('li')).toHaveLength(2);
    });
  });

  describe('onItemChange propagation', () => {
    it('calls onItemChange with the item key and new state when Reject is clicked', async () => {
      const user = userEvent.setup();
      const onItemChange = vi.fn<(key: string, next: ItemState) => void>();
      const items = [makeItem('gpt-4o', 'GPT-4o')];

      render(
        <ReviewSection
          section={makeSection({ itemTitle: '{{item.name}}' })}
          items={items}
          state={{ 'gpt-4o': { decision: 'accept' } }}
          onItemChange={onItemChange}
        />
      );

      // ReviewItem renders a "Reject" button for each item
      const rejectButton = screen.getByRole('button', { name: 'Reject' });
      await user.click(rejectButton);

      expect(onItemChange).toHaveBeenCalledOnce();
      // First argument must be the item's __key
      expect(onItemChange.mock.calls[0][0]).toBe('gpt-4o');
      // Second argument must be a state object with decision 'reject'
      expect(onItemChange.mock.calls[0][1]).toMatchObject({ decision: 'reject' });
    });

    it('calls onItemChange with "accept" when Restore is clicked on a rejected item', async () => {
      const user = userEvent.setup();
      const onItemChange = vi.fn<(key: string, next: ItemState) => void>();
      const items = [makeItem('gpt-4o', 'GPT-4o')];

      render(
        <ReviewSection
          section={makeSection({ itemTitle: '{{item.name}}' })}
          items={items}
          state={{ 'gpt-4o': { decision: 'reject' } }}
          onItemChange={onItemChange}
        />
      );

      // When item is rejected, the button label changes to "Restore"
      const restoreButton = screen.getByRole('button', { name: 'Restore' });
      await user.click(restoreButton);

      expect(onItemChange).toHaveBeenCalledOnce();
      expect(onItemChange.mock.calls[0][0]).toBe('gpt-4o');
      expect(onItemChange.mock.calls[0][1]).toMatchObject({ decision: 'accept' });
    });
  });
});
