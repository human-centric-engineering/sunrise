// @vitest-environment happy-dom

/**
 * RevisionHistory Component Tests
 *
 * The list + diff pane shared by the cleanup page's History tab and the
 * History dialog in the page header.
 *
 * Test Coverage:
 * - Fetches the list on mount and again when refreshKey changes
 * - Renders one row per revision, with the source label mapping
 * - Empty list and list-fetch failure paths
 * - Selecting a revision fetches THAT revision's content (the list endpoint
 *   sends metadata only) and diffs it against its predecessor
 * - The compare selector switches to diffing against the current document
 * - previousPruned surfaces the "predecessor was pruned" caveat
 * - Restore POSTs the restore route and calls onRestored / onAfterRestore;
 *   a failure surfaces the server message instead
 *
 * Mocking:
 * - @/lib/api/client (apiClient.get), keyed by URL so list and detail differ
 * - globalThis.fetch for the restore POST
 * - TextDiffViewer → a marker that echoes its before/after, so the tests can
 *   assert WHICH pair was diffed without depending on diff rendering
 *   (covered by text-diff-viewer.test.tsx)
 *
 * @see components/admin/orchestration/knowledge/revision-history.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApiClientGet } = vi.hoisted(() => ({ mockApiClientGet: vi.fn() }));

// The real APIClientError and apiErrorFromResponse, so a failed restore is
// read as it would be in the app (§124).
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: mockApiClientGet },
}));

vi.mock('@/components/admin/orchestration/knowledge/text-diff-viewer', () => ({
  TextDiffViewer: ({ before, after }: { before: string; after: string }) => (
    <div data-testid="text-diff" data-before={before} data-after={after} />
  ),
  DiffModeToggle: () => <div data-testid="diff-mode-toggle" />,
}));

import { RevisionHistory } from '@/components/admin/orchestration/knowledge/revision-history';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DOC_ID = 'doc-abc-123';
const CURRENT_CONTENT = 'Current document content here.';

function makeRevision(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `rev-${(overrides.version as number) ?? 1}`,
    version: 1,
    source: 'human_section',
    actorId: 'user-123',
    sectionMarker: null,
    instructions: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    contentLength: 500,
    charsDelta: -20,
    ...overrides,
  };
}

const BASE_PROPS = {
  documentId: DOC_ID,
  currentContent: CURRENT_CONTENT,
  onRestored: vi.fn(),
};

/**
 * Route apiClient.get by URL: `/revisions` is the list, `/revisions/<n>` the
 * single-revision detail. Mirrors the two real endpoints.
 */
function arrangeApi(options: {
  revisions?: ReturnType<typeof makeRevision>[];
  detail?: Record<string, unknown>;
}) {
  mockApiClientGet.mockImplementation((url: string) => {
    if (/\/cleanup\/revisions\/\d+$/.test(url)) {
      return Promise.resolve(
        options.detail ?? {
          revision: {
            version: 2,
            content: 'after content',
            source: 'human_full',
            createdAt: '2026-01-01T10:00:00.000Z',
          },
          previous: { version: 1, content: 'before content' },
          previousPruned: false,
        }
      );
    }
    return Promise.resolve({ revisions: options.revisions ?? [] });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RevisionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // happy-dom has no scrollIntoView; <SaveError> calls it when it appears.
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    arrangeApi({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── List ────────────────────────────────────────────────────────────────────

  it('fetches the revision list on mount', async () => {
    render(<RevisionHistory {...BASE_PROPS} />);

    await waitFor(() => {
      expect(mockApiClientGet).toHaveBeenCalledWith(
        expect.stringContaining(`${DOC_ID}/cleanup/revisions`)
      );
    });
  });

  it('refetches when refreshKey changes, so agent writes appear without a reload', async () => {
    const { rerender } = render(<RevisionHistory {...BASE_PROPS} refreshKey={0} />);
    await waitFor(() => expect(mockApiClientGet).toHaveBeenCalledTimes(1));

    rerender(<RevisionHistory {...BASE_PROPS} refreshKey={1} />);

    await waitFor(() => expect(mockApiClientGet).toHaveBeenCalledTimes(2));
  });

  it('renders one row per revision with its source label', async () => {
    arrangeApi({
      revisions: [
        makeRevision({ version: 3, source: 'capability:strip_timestamps' }),
        makeRevision({ version: 2, source: 'human_section' }),
        makeRevision({ version: 1, source: 'restore' }),
      ],
    });

    render(<RevisionHistory {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByText('v3')).toBeInTheDocument();
    });
    expect(screen.getByText('Agent: strip_timestamps')).toBeInTheDocument();
    expect(screen.getByText('You: section edit')).toBeInTheDocument();
    expect(screen.getByText('You: restore')).toBeInTheDocument();
  });

  it('passes an unrecognised source through unchanged', async () => {
    arrangeApi({ revisions: [makeRevision({ version: 1, source: 'unknown_source_type' })] });

    render(<RevisionHistory {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByText('unknown_source_type')).toBeInTheDocument();
    });
  });

  it('renders "No revisions yet." for an empty list', async () => {
    arrangeApi({ revisions: [] });

    render(<RevisionHistory {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByText('No revisions yet.')).toBeInTheDocument();
    });
  });

  it('surfaces the error message when the list fetch rejects', async () => {
    mockApiClientGet.mockRejectedValue(new Error('Network timeout'));

    render(<RevisionHistory {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByText('Network timeout')).toBeInTheDocument();
    });
  });

  it('falls back to a generic message when the list fetch rejects with a non-Error', async () => {
    mockApiClientGet.mockRejectedValue('plain string rejection');

    render(<RevisionHistory {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load revisions')).toBeInTheDocument();
    });
  });

  // ── Selection and diff ──────────────────────────────────────────────────────

  it('selecting a revision fetches its content and diffs it against its predecessor', async () => {
    arrangeApi({ revisions: [makeRevision({ version: 2, source: 'human_full' })] });

    render(<RevisionHistory {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /v2/i }));

    // The per-revision GET is what makes an older revision previewable at all —
    // the list endpoint deliberately omits content.
    await waitFor(() => {
      expect(mockApiClientGet).toHaveBeenCalledWith(
        expect.stringContaining(`${DOC_ID}/cleanup/revisions/2`)
      );
    });

    const diff = await screen.findByTestId('text-diff');
    expect(diff.getAttribute('data-before')).toBe('before content');
    expect(diff.getAttribute('data-after')).toBe('after content');
  });

  it('switching the comparison to "current" diffs the revision against the live document', async () => {
    arrangeApi({ revisions: [makeRevision({ version: 2, source: 'human_full' })] });

    render(<RevisionHistory {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /v2/i }));
    await screen.findByTestId('text-diff');

    await user.selectOptions(screen.getByLabelText('Compare against'), 'current');

    const diff = screen.getByTestId('text-diff');
    expect(diff.getAttribute('data-before')).toBe('after content');
    expect(diff.getAttribute('data-after')).toBe(CURRENT_CONTENT);
  });

  it('says so when the predecessor revision has been pruned', async () => {
    arrangeApi({
      revisions: [makeRevision({ version: 9, source: 'human_full' })],
      detail: {
        revision: {
          version: 9,
          content: 'ninth',
          source: 'human_full',
          createdAt: '2026-01-01T10:00:00.000Z',
        },
        previous: null,
        previousPruned: true,
      },
    });

    render(<RevisionHistory {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText('v9')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /v9/i }));

    expect(await screen.findByText(/has been pruned/i)).toBeInTheDocument();
  });

  it('surfaces an error when the per-revision fetch fails, without rendering a diff', async () => {
    mockApiClientGet.mockImplementation((url: string) => {
      if (/\/cleanup\/revisions\/\d+$/.test(url)) {
        return Promise.reject(new Error('Revision not found'));
      }
      return Promise.resolve({ revisions: [makeRevision({ version: 4 })] });
    });

    render(<RevisionHistory {...BASE_PROPS} />);
    await waitFor(() => expect(screen.getByText('v4')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /v4/i }));

    expect(await screen.findByText('Revision not found')).toBeInTheDocument();
    expect(screen.queryByTestId('text-diff')).not.toBeInTheDocument();
  });

  // ── Restore ─────────────────────────────────────────────────────────────────

  it('restore POSTs the restore route and reports success to both callbacks', async () => {
    const onRestored = vi.fn();
    const onAfterRestore = vi.fn();
    arrangeApi({ revisions: [makeRevision({ version: 3, source: 'human_full' })] });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: { newContent: 'restored' } }),
    });
    globalThis.fetch = fetchMock;

    render(
      <RevisionHistory {...BASE_PROPS} onRestored={onRestored} onAfterRestore={onAfterRestore} />
    );
    await waitFor(() => expect(screen.getByText('v3')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /v3/i }));
    await user.click(await screen.findByRole('button', { name: /Restore this version/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('revisions/3/restore'),
        expect.objectContaining({ method: 'POST' })
      );
    });
    await waitFor(() => {
      expect(onRestored).toHaveBeenCalledTimes(1);
      expect(onAfterRestore).toHaveBeenCalledTimes(1);
    });
  });

  it('restore failure surfaces the server message and does not report success', async () => {
    const onRestored = vi.fn();
    const onAfterRestore = vi.fn();
    arrangeApi({ revisions: [makeRevision({ version: 2, source: 'human_section' })] });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () =>
        Promise.resolve({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Internal server error during restore' },
        }),
    });

    render(
      <RevisionHistory {...BASE_PROPS} onRestored={onRestored} onAfterRestore={onAfterRestore} />
    );
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /v2/i }));
    await user.click(await screen.findByRole('button', { name: /Restore this version/i }));

    // Directly above the row holding Restore, focused.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Internal server error during restore');
    expect(alert.nextElementSibling).toContainElement(
      screen.getByRole('button', { name: /Restore this version/i })
    );
    expect(alert).toHaveFocus();
    expect(onRestored).not.toHaveBeenCalled();
    expect(onAfterRestore).not.toHaveBeenCalled();
  });
});
