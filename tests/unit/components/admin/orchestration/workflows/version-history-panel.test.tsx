/**
 * VersionHistoryPanel Component Tests
 *
 * Test Coverage:
 * - Renders "No version history yet" when history=[]
 * - Renders version entries with vX label and changedBy name
 * - Click on a version row expands to show diff content
 * - Click again collapses it
 * - When onRestore prop provided, "Restore this version" button appears in expanded panel
 * - onRestore callback called with correct definition when button clicked
 * - When onRestore is not provided, no restore button shown
 * - Versions shown in reverse chronological order (newest = v{history.length}, oldest = v1)
 *
 * @see components/admin/orchestration/workflows/version-history-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { VersionHistoryPanel } from '@/components/admin/orchestration/workflows/version-history-panel';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CURRENT_DEF = { steps: [{ id: 'current-step' }], entryStepId: 'current-step' };

function makeEntry(
  overrides: Partial<{ definition: Record<string, unknown>; changedAt: string; changedBy: string }>
) {
  return {
    definition: { steps: [{ id: 'some-step' }], entryStepId: 'some-step' },
    changedAt: '2025-01-01T10:00:00Z',
    changedBy: 'user@example.com',
    ...overrides,
  };
}

const TWO_HISTORY = [
  makeEntry({
    definition: { steps: [{ id: 'step-v1' }], entryStepId: 'step-v1' },
    changedAt: '2025-01-01T10:00:00Z',
    changedBy: 'alice@example.com',
  }),
  makeEntry({
    definition: { steps: [{ id: 'step-v2' }], entryStepId: 'step-v2' },
    changedAt: '2025-03-01T10:00:00Z',
    changedBy: 'bob@example.com',
  }),
];

/**
 * Get the version row toggle buttons (excludes the FieldHelp icon button
 * in the heading and the restore button that appears when expanded).
 * Version row buttons have w-full class and contain the vX label text.
 */
function getVersionRowButtons() {
  return screen.getAllByRole('button').filter((btn) => btn.className.includes('w-full'));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VersionHistoryPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  it('renders "No version history yet" when history is empty', () => {
    render(<VersionHistoryPanel history={[]} currentDefinition={CURRENT_DEF} />);

    expect(screen.getByText(/no version history yet/i)).toBeInTheDocument();
  });

  it('shows "Version History" heading', () => {
    render(<VersionHistoryPanel history={[]} currentDefinition={CURRENT_DEF} />);

    expect(screen.getByText('Version History')).toBeInTheDocument();
  });

  // ── Entry rendering ────────────────────────────────────────────────────────

  it('renders version entries with vX label', () => {
    render(<VersionHistoryPanel history={TWO_HISTORY} currentDefinition={CURRENT_DEF} />);

    // Two entries → v1 and v2 labels
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
  });

  it('renders changedBy name for each entry', () => {
    render(<VersionHistoryPanel history={TWO_HISTORY} currentDefinition={CURRENT_DEF} />);

    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
  });

  // ── Ordering: newest first = highest version number ────────────────────────

  it('displays entries in reverse chronological order — newest entry gets highest vX label', () => {
    render(<VersionHistoryPanel history={TWO_HISTORY} currentDefinition={CURRENT_DEF} />);

    // TWO_HISTORY[1] (bob, march) is more recent → shown first (display index 0) with label v2
    // TWO_HISTORY[0] (alice, jan)  is older     → shown second (display index 1) with label v1
    // The component reverses the array, so entries[0] = bob (newer), entries[1] = alice (older).
    // versionNumber = history.length - idx; for idx=0 → v2, idx=1 → v1.
    const rowButtons = getVersionRowButtons();
    expect(rowButtons).toHaveLength(2);
    // First displayed row (newest) should have "v2"
    expect(rowButtons[0].textContent).toContain('v2');
    // Second displayed row (oldest) should have "v1"
    expect(rowButtons[1].textContent).toContain('v1');
  });

  // ── Expand / collapse ──────────────────────────────────────────────────────

  it('clicking a version row expands to show diff content', async () => {
    const user = userEvent.setup();
    // Use entries with different definitions so diff is non-empty
    const history = [
      makeEntry({
        definition: { fieldX: 'old-value' },
        changedAt: '2025-01-01T10:00:00Z',
        changedBy: 'alice@example.com',
      }),
    ];
    render(<VersionHistoryPanel history={history} currentDefinition={{ fieldX: 'new-value' }} />);

    const [rowButton] = getVersionRowButtons();
    await user.click(rowButton);

    // VersionDiffViewer renders a diff. "fieldX" changed → both removed and added spans appear.
    // We verify diff content appeared by checking at least one span mentioning the field path.
    const diffItems = screen.getAllByText(/fieldX/);
    expect(diffItems.length).toBeGreaterThan(0);
    // Also verify "old-value" is shown as the removed value
    expect(screen.getByText(/old-value/)).toBeInTheDocument();
  });

  it('clicking an expanded row collapses it', async () => {
    const user = userEvent.setup();
    const history = [
      makeEntry({
        definition: { uniqueField: 'before' },
        changedAt: '2025-01-01T10:00:00Z',
        changedBy: 'carol@example.com',
      }),
    ];
    render(<VersionHistoryPanel history={history} currentDefinition={{ uniqueField: 'after' }} />);

    const [rowButton] = getVersionRowButtons();
    await user.click(rowButton); // expand

    // Diff visible — uniqueField path shown, "before" and "after" values shown
    expect(screen.getByText(/before/)).toBeInTheDocument();

    await user.click(rowButton); // collapse

    // Row still present but expanded content is gone
    expect(screen.getByText('carol@example.com')).toBeInTheDocument();
    // The diff values are no longer visible
    expect(screen.queryByText(/before/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore this version/i })).not.toBeInTheDocument();
  });

  // ── Restore button ─────────────────────────────────────────────────────────

  it('shows "Restore this version" button when onRestore prop is provided', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <VersionHistoryPanel
        history={TWO_HISTORY}
        currentDefinition={CURRENT_DEF}
        onRestore={onRestore}
      />
    );

    // Expand the first (newest) row
    const [firstRow] = getVersionRowButtons();
    await user.click(firstRow);

    expect(screen.getByRole('button', { name: /restore this version/i })).toBeInTheDocument();
  });

  it('calls onRestore with the correct definition when restore button clicked', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const specificDef = { steps: [{ id: 'step-v2-specific' }], entryStepId: 'step-v2-specific' };
    const history = [
      makeEntry({
        definition: { steps: [{ id: 'step-v1' }], entryStepId: 'step-v1' },
        changedAt: '2025-01-01T10:00:00Z',
        changedBy: 'alice@example.com',
      }),
      makeEntry({
        definition: specificDef,
        changedAt: '2025-03-01T10:00:00Z',
        changedBy: 'bob@example.com',
      }),
    ];

    render(
      <VersionHistoryPanel
        history={history}
        currentDefinition={CURRENT_DEF}
        onRestore={onRestore}
      />
    );

    // The newest entry (bob, march) is at display index 0 — it contains specificDef
    const [firstRow] = getVersionRowButtons();
    await user.click(firstRow); // expand newest

    await user.click(screen.getByRole('button', { name: /restore this version/i }));

    expect(onRestore).toHaveBeenCalledOnce();
    expect(onRestore).toHaveBeenCalledWith(specificDef);
  });

  it('does not show restore button when onRestore is not provided', async () => {
    const user = userEvent.setup();
    render(<VersionHistoryPanel history={TWO_HISTORY} currentDefinition={CURRENT_DEF} />);

    const [firstRow] = getVersionRowButtons();
    await user.click(firstRow); // expand

    expect(screen.queryByRole('button', { name: /restore this version/i })).not.toBeInTheDocument();
  });
});
