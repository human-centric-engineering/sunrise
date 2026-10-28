// @vitest-environment happy-dom

/**
 * PendingChangeModal Component Tests
 *
 * Test Coverage:
 * - changeId=null → modal is closed (no DialogTitle in DOM)
 * - changeId='abc' → modal opens; calls the per-change GET; renders TextDiffViewer
 * - Per-change GET 404s → "Pending change not found" error rendered
 * - Section rewrite (sectionMarker set) → source line matches /Section rewrite: <marker>/i
 * - Whole-doc rewrite (sectionMarker null) → source line matches /Whole-document rewrite/i
 * - Accept button POSTs /cleanup/changes/<id>/accept; on success calls onResolved + onClose
 * - Reject button POSTs /cleanup/changes/<id>/reject; on success calls onResolved + onClose
 * - Accept failure → error rendered; onResolved and onClose NOT called
 *
 * Mocking:
 * - @/lib/api/client (apiClient.get returning { change: {...} })
 * - globalThis.fetch for accept/reject
 * - @/components/admin/orchestration/knowledge/text-diff-viewer → <div data-testid="text-diff" />
 *
 * @see components/admin/orchestration/knowledge/pending-change-modal.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const { mockApiClientGet } = vi.hoisted(() => ({
  mockApiClientGet: vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────

// The real APIClientError and apiErrorFromResponse, so a failed Accept or
// Reject is read as it would be in the app (§124).
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: {
    get: mockApiClientGet,
  },
}));

// Mock TextDiffViewer to a simple marker — keeps pending-change-modal tests
// focused on accept/reject logic rather than diff rendering internals
vi.mock('@/components/admin/orchestration/knowledge/text-diff-viewer', () => ({
  TextDiffViewer: () => <div data-testid="text-diff" />,
}));

// ─── Component import (after mocks) ──────────────────────────────────────────

import { PendingChangeModal } from '@/components/admin/orchestration/knowledge/pending-change-modal';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DOC_ID = 'doc-abc-123';
const CHANGE_ID = 'change-xyz-456';

interface PendingChangeRecord {
  id: string;
  source: 'rewrite_with_llm' | 'rewrite_section_with_llm';
  beforeContent: string;
  afterContent: string;
  sectionMarker: string | null;
  instructions: string;
}

function makePendingChange(overrides?: Partial<PendingChangeRecord>): PendingChangeRecord {
  return {
    id: CHANGE_ID,
    source: 'rewrite_with_llm',
    beforeContent: 'Before: original content here.',
    afterContent: 'After: rewritten content here.',
    sectionMarker: null,
    instructions: 'Improve clarity',
    ...overrides,
  };
}

function makeChangeResponse(change: PendingChangeRecord) {
  return { change };
}

function makeChangeUrl(docId: string, changeId: string) {
  return `/api/v1/admin/orchestration/knowledge/documents/${docId}/cleanup/changes/${changeId}`;
}

const BASE_PROPS = {
  documentId: DOC_ID,
  changeId: CHANGE_ID,
  onClose: vi.fn(),
  onResolved: vi.fn(),
};

function makeAcceptRejectUrl(docId: string, changeId: string, action: 'accept' | 'reject') {
  return `/api/v1/admin/orchestration/knowledge/documents/${docId}/cleanup/changes/${changeId}/${action}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PendingChangeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // happy-dom has no scrollIntoView; <SaveError> calls it when it appears.
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    // Default: the per-change GET resolves the requested proposal
    mockApiClientGet.mockResolvedValue(makeChangeResponse(makePendingChange()));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Closed state ──────────────────────────────────────────────────────────────

  it('changeId=null → modal is closed (no DialogTitle in the DOM)', () => {
    render(<PendingChangeModal {...BASE_PROPS} changeId={null} />);

    // When changeId is null, open=false — Dialog does not render its children
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockApiClientGet).not.toHaveBeenCalled();
  });

  // ── Open state ────────────────────────────────────────────────────────────────

  it('changeId set → modal opens; calls the per-change GET and renders TextDiffViewer', async () => {
    const change = makePendingChange({ sectionMarker: null });
    mockApiClientGet.mockResolvedValue(makeChangeResponse(change));

    render(<PendingChangeModal {...BASE_PROPS} changeId={CHANGE_ID} />);

    // Wait for load to complete and diff to render
    await waitFor(() => {
      expect(screen.getByTestId('text-diff')).toBeInTheDocument();
    });

    // The GET targets the per-change endpoint, NOT the document route — the
    // document payload must stay free of before/after copies of the text.
    expect(mockApiClientGet).toHaveBeenCalledWith(makeChangeUrl(DOC_ID, CHANGE_ID));
  });

  // ── Pending change not found ──────────────────────────────────────────────────

  it('per-change GET 404s → "Pending change not found" error rendered', async () => {
    // The row was already accepted or rejected elsewhere; the route answers
    // 404 CHANGE_NOT_FOUND, which apiClient surfaces as a rejection.
    mockApiClientGet.mockRejectedValue(new Error('Pending change not found'));

    render(<PendingChangeModal {...BASE_PROPS} changeId={CHANGE_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/Pending change not found/i)).toBeInTheDocument();
    });
  });

  // ── Source line: section rewrite ──────────────────────────────────────────────

  it('section rewrite (sectionMarker set) → source line matches /Section rewrite: <marker>/i', async () => {
    const marker = '## Overview';
    mockApiClientGet.mockResolvedValue(
      makeChangeResponse(
        makePendingChange({
          source: 'rewrite_section_with_llm',
          sectionMarker: marker,
        })
      )
    );

    render(<PendingChangeModal {...BASE_PROPS} changeId={CHANGE_ID} />);

    await waitFor(() => {
      expect(screen.getByText(new RegExp(`Section rewrite: ${marker}`, 'i'))).toBeInTheDocument();
    });
  });

  // ── Source line: whole-doc rewrite ────────────────────────────────────────────

  it('whole-doc rewrite (sectionMarker null) → source line matches /Whole-document rewrite/i', async () => {
    mockApiClientGet.mockResolvedValue(
      makeChangeResponse(
        makePendingChange({
          source: 'rewrite_with_llm',
          sectionMarker: null,
        })
      )
    );

    render(<PendingChangeModal {...BASE_PROPS} changeId={CHANGE_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/Whole-document rewrite/i)).toBeInTheDocument();
    });
  });

  // ── Accept ────────────────────────────────────────────────────────────────────

  it('Accept POSTs /cleanup/changes/<id>/accept; on success calls onResolved then onClose', async () => {
    const onResolved = vi.fn();
    const onClose = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    globalThis.fetch = fetchMock;

    render(<PendingChangeModal {...BASE_PROPS} onResolved={onResolved} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Accept/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Accept/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        makeAcceptRejectUrl(DOC_ID, CHANGE_ID, 'accept'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    await waitFor(() => {
      expect(onResolved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // ── Reject ────────────────────────────────────────────────────────────────────

  it('Reject POSTs /cleanup/changes/<id>/reject; on success calls onResolved then onClose', async () => {
    const onResolved = vi.fn();
    const onClose = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    globalThis.fetch = fetchMock;

    render(<PendingChangeModal {...BASE_PROPS} onResolved={onResolved} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reject/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reject/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        makeAcceptRejectUrl(DOC_ID, CHANGE_ID, 'reject'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    await waitFor(() => {
      expect(onResolved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // ── Accept failure ────────────────────────────────────────────────────────────

  it('Accept failure → error rendered; onResolved and onClose NOT called', async () => {
    const onResolved = vi.fn();
    const onClose = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () =>
        Promise.resolve({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Accept operation failed on server' },
        }),
    });

    render(<PendingChangeModal {...BASE_PROPS} onResolved={onResolved} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Accept/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Accept/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Accept operation failed on server/i);
    });

    expect(onResolved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // ── Accept: fallback when error body has no message ───────────────────────────

  it('shows "Accept failed (500)" when accept returns 500 with no error.message', async () => {
    // Exercises the `body?.error?.message ?? \`Accept failed (${res.status})\`` fallback.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ success: false }),
    });

    render(<PendingChangeModal {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Accept/i })).not.toBeDisabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Accept/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not accept the change. Try again.'
      );
    });
  });

  // ── Accept: non-Error thrown by fetch ─────────────────────────────────────────

  it('shows "Accept failed" when accept fetch rejects with a non-Error value', async () => {
    // Exercises the `err instanceof Error ? err.message : 'Accept failed'` branch.
    globalThis.fetch = vi.fn().mockRejectedValue('plain string — not an Error');

    render(<PendingChangeModal {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Accept/i })).not.toBeDisabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Accept/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not accept the change. Try again.'
      );
    });
  });

  // ── Reject: fallback when error body has no message ───────────────────────────

  it('shows "Reject failed (422)" when reject returns 422 with no error.message', async () => {
    // Exercises the `body?.error?.message ?? \`Reject failed (${res.status})\`` fallback.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ success: false }),
    });

    render(<PendingChangeModal {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reject/i })).not.toBeDisabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reject/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not reject the change. Try again.'
      );
    });
  });

  // ── Reject: non-Error thrown by fetch ─────────────────────────────────────────

  it('shows "Reject failed" when reject fetch rejects with a non-Error value', async () => {
    // Exercises the `err instanceof Error ? err.message : 'Reject failed'` branch.
    globalThis.fetch = vi.fn().mockRejectedValue('plain string — not an Error');

    render(<PendingChangeModal {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reject/i })).not.toBeDisabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reject/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not reject the change. Try again.'
      );
    });
  });

  // ── Error body JSON parse failure ──────────────────────────────────────────

  it('falls back to "Accept failed (status)" when the error response body fails to parse as JSON', async () => {
    // Exercises the `.catch(() => null)` arrow on `res.json()` in the accept
    // handler — fires when the server returned a non-OK status AND the body
    // is malformed JSON.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      json: () => Promise.reject('not json'),
    });

    render(<PendingChangeModal {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Accept/i })).not.toBeDisabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Accept/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not accept the change. Try again.'
      );
    });
  });

  it('falls back to "Reject failed (status)" when the error response body fails to parse as JSON', async () => {
    // Exercises the `.catch(() => null)` arrow on `res.json()` in the reject handler.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      json: () => Promise.reject('not json'),
    });

    render(<PendingChangeModal {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Reject/i })).not.toBeDisabled();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reject/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not reject the change. Try again.'
      );
    });
  });

  // ── Dialog dismissal via ESC / overlay ────────────────────────────────────

  it('calls onClose when the Dialog is dismissed (ESC key)', async () => {
    // Exercises the `onOpenChange={(next) => (next ? null : onClose())}` prop.
    // The Dialog primitive fires onOpenChange(false) when the user presses ESC
    // or clicks the overlay; the inline arrow must route that to onClose().
    const onClose = vi.fn();
    render(<PendingChangeModal {...BASE_PROPS} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Accept/i })).not.toBeDisabled();
    });

    const user = userEvent.setup();
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
