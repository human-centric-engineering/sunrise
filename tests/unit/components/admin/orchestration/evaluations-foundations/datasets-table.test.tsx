/**
 * DatasetsTable Component Tests
 *
 * Test coverage:
 * - Renders one row per dataset with name linked to detail page
 * - Shows case count, source badge, formatted updatedAt
 * - Tags render as multiple badges; empty tags show "—"
 * - "Upload dataset" CTA links to /datasets/new
 *
 * @see components/admin/orchestration/evaluations-foundations/datasets-table.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import {
  DatasetsTable,
  type DatasetListItem,
} from '@/components/admin/orchestration/evaluations-foundations/datasets-table';

const MOCK_DATASETS: DatasetListItem[] = [
  {
    id: 'ds-1',
    name: 'Customer FAQ',
    description: 'Phase 1 FAQ questions',
    tags: ['faq', 'tier-1'],
    caseCount: 42,
    source: 'upload',
    createdAt: '2026-05-01T10:00:00Z',
    updatedAt: '2026-05-10T10:00:00Z',
  },
  {
    id: 'ds-2',
    name: 'Refund edge cases',
    description: null,
    tags: [],
    caseCount: 7,
    source: 'synthetic',
    createdAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
  },
];

describe('DatasetsTable', () => {
  it('renders one row per dataset', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    // 1 header row + 2 data rows
    expect(screen.getAllByRole('row')).toHaveLength(MOCK_DATASETS.length + 1);
  });

  it('renders the dataset name as a link to its detail page', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    const link = screen.getByRole('link', { name: 'Customer FAQ' });
    expect(link).toHaveAttribute('href', '/admin/orchestration/evaluations/datasets/ds-1');
  });

  it('shows the case count for each dataset', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders multiple tag badges for a dataset with tags', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    expect(screen.getByText('faq')).toBeInTheDocument();
    expect(screen.getByText('tier-1')).toBeInTheDocument();
  });

  it('renders "—" when a dataset has no tags', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    // The empty-tags placeholder is in the row for ds-2
    const row = screen.getByRole('link', { name: 'Refund edge cases' }).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('—')).toBeInTheDocument();
  });

  it('renders the source badge for each dataset', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    expect(screen.getByText('upload')).toBeInTheDocument();
    expect(screen.getByText('synthetic')).toBeInTheDocument();
  });

  it('formats updatedAt with en-GB locale (day month year)', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    // 2026-05-10 → "10 May 2026" via toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
    expect(screen.getByText('10 May 2026')).toBeInTheDocument();
    expect(screen.getByText('20 Apr 2026')).toBeInTheDocument();
  });

  it('renders the "Upload dataset" CTA linking to /datasets/new', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    const cta = screen.getByRole('link', { name: /upload dataset/i });
    expect(cta).toHaveAttribute('href', '/admin/orchestration/evaluations/datasets/new');
  });

  it('shows the total count next to the heading', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    expect(screen.getByText(`${MOCK_DATASETS.length} total`)).toBeInTheDocument();
  });

  it('renders the description preview when present', () => {
    render(<DatasetsTable datasets={MOCK_DATASETS} />);
    expect(screen.getByText('Phase 1 FAQ questions')).toBeInTheDocument();
  });

  it('renders no rows when datasets is empty', () => {
    render(<DatasetsTable datasets={[]} />);
    // Only header row
    expect(screen.getAllByRole('row')).toHaveLength(1);
    expect(screen.getByText('0 total')).toBeInTheDocument();
  });
});
