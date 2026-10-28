// @vitest-environment happy-dom

/**
 * CleanupView Component Tests
 *
 * Test Coverage:
 * - Renders document name and size-class badge with the correct label
 * - Shows the "too-large" warning callout when llmRewriteAllowed=false
 * - Does NOT show the callout when llmRewriteAllowed=true
 * - Renders three action buttons in the header (Mark cleaned, Use original, Discard & delete)
 * - Tab switcher swaps between "Cleaned" and "Original" content in the preview pane
 * - Reduction-percentage label appears when processedContent is shorter than originalContent
 * - "Mark cleaned" POSTs { action: 'commit' } and redirects on success
 * - "Use original" POSTs { action: 'use-original' } and redirects on success
 * - "Discard & delete" POSTs { action: 'delete' } and redirects on success
 * - Displays error message when finalise POST fails
 * - When onStreamComplete fires, re-fetches doc and updates processedContent
 * - When onCapabilityResult fires, re-fetches doc and updates processedContent
 *
 * @see components/admin/orchestration/knowledge/cleanup-view.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CleanupView } from '@/components/admin/orchestration/knowledge/cleanup-view';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// vi.hoisted ensures refs are available inside the vi.mock factory because
// vi.mock calls are hoisted to module scope at transform time.
const { mockPush, mockLockRelease, mockLockAcquire } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockLockRelease: vi.fn().mockResolvedValue(undefined),
  mockLockAcquire: vi.fn().mockResolvedValue(true),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// CleanupView calls `useSession()` for the current user id it hands the edit
// lock. Left unmocked, the REAL better-auth client subscribes this render to
// its nanostores session atom, and nanostores defers the unsubscribe teardown
// onto a timer. When that timer fires after the test environment is gone,
// better-auth's `cleanupBroadcastSetup` reaches for `window` and throws
// `ReferenceError: window is not defined` as an unhandled error — which fails
// the whole shard with every test still green (CI run 35013955758, shard 2/4).
// `data: null` is exactly what the real client returns here anyway: there is
// no session in a unit test, so `currentUserId` was already ''.
vi.mock('@/lib/auth/client', () => ({
  useSession: () => ({ data: null, isPending: false, error: null }),
}));

// Default lock state: no one holds the lock (heldByMe=false, heldByOther=false).
// Individual tests that need different lock state override this mock via
// vi.mocked(useCleanupEditLock).mockReturnValue({ ... }).
let mockLockState = {
  state: null as CleanupLockState | null,
  heldByMe: false,
  heldByOther: false,
  error: null as string | null,
  acquire: mockLockAcquire,
  release: mockLockRelease,
  refresh: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/lib/hooks/use-cleanup-edit-lock', () => ({
  useCleanupEditLock: vi.fn(() => mockLockState),
}));

// Capture the callback props so tests can fire them manually.
// Using a plain mutable object (not ref) so assignments inside the factory
// closure update the value the test body reads.
let capturedOnStreamComplete: (() => void) | undefined;
let capturedOnCapabilityResult: (() => void) | undefined;
// Full-arity version so tests can pass any slug + result to onCapabilityResult.
let capturedOnCapabilityResultFull: ((slug: string, result: unknown) => void) | undefined;

vi.mock('@/components/admin/orchestration/chat/chat-interface', () => ({
  ChatInterface: (props: {
    agentSlug: string;
    onStreamComplete?: () => void;
    onCapabilityResult?: (slug: string, result: unknown) => void;
  }) => {
    // Capture callbacks on every render so the latest closure is available.
    capturedOnStreamComplete = props.onStreamComplete;
    capturedOnCapabilityResultFull = props.onCapabilityResult;
    // Adapt the signature: the plan specifies onCapabilityResult fires with no args from
    // the test side; we wrap the real prop (which takes slug + result) to satisfy the
    // component's signature while exposing a zero-arg call from the test.
    capturedOnCapabilityResult = props.onCapabilityResult
      ? () => props.onCapabilityResult!('cleanup-agent', {})
      : undefined;
    return <div data-testid="chat-interface" data-agent={props.agentSlug} />;
  },
}));

// apiClient.get is used for the doc refetch after chat events. The real
// APIClientError and apiErrorFromResponse read a failed finalise (§124).
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: {
    get: vi.fn(),
  },
}));

// EditableSection / RevisionDrawer / PendingChangeModal are mocked so tests
// can fire the inline callback props passed by CleanupView (onSaved,
// onPendingChange, onRestored, onClose, onResolved). The real components are
// exercised by their own test files; here we only verify CleanupView's wiring.
let capturedEditableSectionProps: {
  onSaved?: () => void;
  onPendingChange?: (id: string) => void;
}[] = [];
let capturedRevisionDrawerProps: {
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  onRestored?: () => void;
} | null = null;
let capturedPendingChangeModalProps: {
  changeId?: string | null;
  onClose?: () => void;
  onResolved?: () => void;
} | null = null;

vi.mock('@/components/admin/orchestration/knowledge/editable-section', () => ({
  EditableSection: (props: {
    section: { body: string };
    onSaved?: () => void;
    onPendingChange?: (id: string) => void;
  }) => {
    capturedEditableSectionProps.push({
      onSaved: props.onSaved,
      onPendingChange: props.onPendingChange,
    });
    // Render the section body so existing content-presence assertions still work.
    return <div data-testid="editable-section">{props.section.body}</div>;
  },
}));

vi.mock('@/components/admin/orchestration/knowledge/revision-drawer', () => ({
  RevisionDrawer: (props: {
    open: boolean;
    onOpenChange: (next: boolean) => void;
    onRestored: () => void;
  }) => {
    capturedRevisionDrawerProps = props;
    return props.open ? <div data-testid="revision-drawer-open" /> : null;
  },
}));

// The Diff and History tabs delegate to these two. Mock them to markers that
// echo their inputs, so the tab tests assert WHAT is handed over rather than
// re-testing diff rendering or the revision list (both have their own suites).
vi.mock('@/components/admin/orchestration/knowledge/text-diff-viewer', () => ({
  TextDiffViewer: (props: { before: string; after: string; mode?: string }) => (
    <div
      data-testid="text-diff"
      data-before={props.before}
      data-after={props.after}
      data-mode={props.mode}
    />
  ),
  DiffModeToggle: (props: { mode: string; onChange: (mode: string) => void }) => (
    <button type="button" data-testid="diff-mode-toggle" onClick={() => props.onChange('split')}>
      {props.mode}
    </button>
  ),
}));

vi.mock('@/components/admin/orchestration/knowledge/revision-history', () => ({
  RevisionHistory: (props: { documentId: string; currentContent: string }) => (
    <div
      data-testid="revision-history"
      data-document-id={props.documentId}
      data-current={props.currentContent}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/knowledge/pending-change-modal', () => ({
  PendingChangeModal: (props: {
    changeId: string | null;
    onClose: () => void;
    onResolved: () => void;
  }) => {
    capturedPendingChangeModalProps = props;
    return props.changeId ? <div data-testid="pending-change-modal-open" /> : null;
  },
}));

// ─── Import mocked modules (after vi.mock declarations) ───────────────────────

import { apiClient } from '@/lib/api/client';
import { useCleanupEditLock, type CleanupLockState } from '@/lib/hooks/use-cleanup-edit-lock';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DOC_ID = 'doc-abc-123';
const DOC_NAME = 'Meeting Notes Q1';
const FILE_NAME = 'meeting-notes-q1.pdf';

const BASE_PROPS = {
  documentId: DOC_ID,
  documentName: DOC_NAME,
  fileName: FILE_NAME,
  originalContent: 'Original text here with some content.',
  initialProcessedContent: 'Cleaned up text.',
  sizeClass: 'medium' as const,
  sizeTokens: 12000,
  llmRewriteAllowed: true,
  contextWindow: 200_000,
};

/** A happy-path fetch mock — returns updated processedContent. */
function makeFetchSuccess(body: unknown = {}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

/** A failing fetch mock — returns 500 with an error body. */
function makeFetchError(message = 'Internal Server Error') {
  return Promise.resolve({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ success: false, error: { code: 'INTERNAL_ERROR', message } }),
  });
}

/** Default successful apiClient.get response for the doc refetch. */
function makeDocResponse(processedContent = 'Refreshed content.') {
  return {
    document: {
      id: DOC_ID,
      status: 'cleanup_ready',
      originalContent: BASE_PROPS.originalContent,
      processedContent,
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CleanupView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnStreamComplete = undefined;
    capturedOnCapabilityResult = undefined;
    capturedOnCapabilityResultFull = undefined;
    capturedEditableSectionProps = [];
    capturedRevisionDrawerProps = null;
    capturedPendingChangeModalProps = null;

    // happy-dom has no scrollIntoView; <SaveError> calls it when it appears.
    Element.prototype.scrollIntoView = vi.fn();
    // Default: all fetches succeed with an empty JSON body
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchSuccess({}));

    // Default: apiClient.get returns the base doc shape
    vi.mocked(apiClient.get).mockResolvedValue(makeDocResponse());

    // Reset lock state to the default (no one holds the lock) before each test.
    mockLockRelease.mockResolvedValue(undefined);
    mockLockAcquire.mockResolvedValue(true);
    mockLockState = {
      state: null,
      heldByMe: false,
      heldByOther: false,
      error: null,
      acquire: mockLockAcquire,
      release: mockLockRelease,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(useCleanupEditLock).mockReturnValue(mockLockState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Badge labels ─────────────────────────────────────────────────────────────

  it('renders the document name in the heading', () => {
    render(<CleanupView {...BASE_PROPS} />);
    expect(screen.getByRole('heading', { name: DOC_NAME })).toBeInTheDocument();
  });

  it('renders "Medium" badge for sizeClass="medium"', () => {
    render(<CleanupView {...BASE_PROPS} sizeClass="medium" />);
    expect(screen.getByText('Medium')).toBeInTheDocument();
  });

  it('renders "Small" badge for sizeClass="small"', () => {
    render(<CleanupView {...BASE_PROPS} sizeClass="small" />);
    expect(screen.getByText('Small')).toBeInTheDocument();
  });

  it('renders "Large" badge for sizeClass="large"', () => {
    render(<CleanupView {...BASE_PROPS} sizeClass="large" />);
    expect(screen.getByText('Large')).toBeInTheDocument();
  });

  it('renders "Too large for whole-doc LLM rewrite" badge for sizeClass="too-large"', () => {
    render(<CleanupView {...BASE_PROPS} sizeClass="too-large" llmRewriteAllowed={false} />);
    expect(screen.getByText('Too large for whole-doc LLM rewrite')).toBeInTheDocument();
  });

  // ── Too-large warning callout ─────────────────────────────────────────────────

  it('shows the too-large warning callout when llmRewriteAllowed=false', () => {
    render(<CleanupView {...BASE_PROPS} llmRewriteAllowed={false} />);
    expect(
      screen.getByText(/This document is too large for a whole-document LLM rewrite/i)
    ).toBeInTheDocument();
  });

  it('does NOT show the too-large warning callout when llmRewriteAllowed=true', () => {
    render(<CleanupView {...BASE_PROPS} llmRewriteAllowed={true} />);
    expect(
      screen.queryByText(/This document is too large for a whole-document LLM rewrite/i)
    ).not.toBeInTheDocument();
  });

  // ── Header action buttons ─────────────────────────────────────────────────────

  it('renders all three action buttons in the header', () => {
    render(<CleanupView {...BASE_PROPS} />);
    expect(screen.getByRole('button', { name: /Mark cleaned/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Use original/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Discard.*delete/i })).toBeInTheDocument();
  });

  // ── Tab switcher ─────────────────────────────────────────────────────────────

  it('shows processedContent in the Cleaned tab by default', () => {
    render(
      <CleanupView
        {...BASE_PROPS}
        originalContent="original text"
        initialProcessedContent="cleaned text"
      />
    );
    // The "Cleaned" tab is active by default; its content should be visible.
    expect(screen.getByText('cleaned text')).toBeInTheDocument();
  });

  it('switches to showing originalContent after clicking the Original tab', async () => {
    const user = userEvent.setup();
    render(
      <CleanupView
        {...BASE_PROPS}
        originalContent="original text"
        initialProcessedContent="cleaned text"
      />
    );

    // Act — switch to the "Original" tab
    await user.click(screen.getByRole('tab', { name: /Original/i }));

    // Assert — original content is now visible in the preview pane
    expect(screen.getByText('original text')).toBeInTheDocument();
  });

  it('switches back to showing processedContent after clicking Cleaned tab', async () => {
    const user = userEvent.setup();
    render(
      <CleanupView
        {...BASE_PROPS}
        originalContent="original text"
        initialProcessedContent="cleaned text"
      />
    );

    // Switch to Original
    await user.click(screen.getByRole('tab', { name: /Original/i }));
    // Switch back to Cleaned
    await user.click(screen.getByRole('tab', { name: /Cleaned/i }));

    expect(screen.getByText('cleaned text')).toBeInTheDocument();
  });

  // ── Reduction percentage ──────────────────────────────────────────────────────

  it('shows a reduction percentage when processedContent is shorter than originalContent', () => {
    // originalContent length: 50 chars; processedContent length: 25 chars → 50% reduction
    render(
      <CleanupView
        {...BASE_PROPS}
        originalContent={'a'.repeat(50)}
        initialProcessedContent={'b'.repeat(25)}
      />
    );
    expect(screen.getByText(/50\.0% reduction/i)).toBeInTheDocument();
  });

  it('does NOT show a reduction percentage when content lengths are equal', () => {
    render(
      <CleanupView
        {...BASE_PROPS}
        originalContent="same length text!!!"
        initialProcessedContent="same length text!!!"
      />
    );
    expect(screen.queryByText(/reduction/i)).not.toBeInTheDocument();
  });

  // ── Finalise: Mark cleaned ────────────────────────────────────────────────────

  it('POSTs { action: "commit" } when "Mark cleaned" is clicked', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchSuccess({}));

    render(<CleanupView {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: /Mark cleaned/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`${DOC_ID}/cleanup/finalise`),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ action: 'commit' }),
        })
      );
    });
  });

  it('redirects to /admin/orchestration/knowledge after "Mark cleaned" succeeds', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchSuccess({}));

    render(<CleanupView {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: /Mark cleaned/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/knowledge');
    });
  });

  // ── Finalise: Use original ────────────────────────────────────────────────────

  it('POSTs { action: "use-original" } when "Use original" is clicked', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchSuccess({}));

    render(<CleanupView {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: /Use original/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`${DOC_ID}/cleanup/finalise`),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ action: 'use-original' }),
        })
      );
    });
  });

  it('redirects to /admin/orchestration/knowledge after "Use original" succeeds', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchSuccess({}));

    render(<CleanupView {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: /Use original/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/knowledge');
    });
  });

  // ── Finalise: Discard & delete ────────────────────────────────────────────────

  it('POSTs { action: "delete" } when "Discard & delete" is clicked', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchSuccess({}));

    render(<CleanupView {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: /Discard.*delete/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`${DOC_ID}/cleanup/finalise`),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ action: 'delete' }),
        })
      );
    });
  });

  it('redirects to /admin/orchestration/knowledge after "Discard & delete" succeeds', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchSuccess({}));

    render(<CleanupView {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: /Discard.*delete/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/knowledge');
    });
  });

  // ── Finalise: error handling ──────────────────────────────────────────────────

  it('displays an error message when the finalise POST fails', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => makeFetchError('Something went wrong on the server'));

    render(<CleanupView {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: /Mark cleaned/i }));

    // In the sticky header, directly below the row holding the finalise buttons.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Something went wrong on the server/i);
    expect(alert.parentElement?.previousElementSibling).toContainElement(
      screen.getByRole('button', { name: /Mark cleaned/i })
    );
    expect(alert).toHaveFocus();

    // Should NOT redirect on failure
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does not redirect when the finalise POST fails', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchError('Server error'));

    render(<CleanupView {...BASE_PROPS} />);
    await user.click(screen.getByRole('button', { name: /Use original/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Server error/i);
    });

    expect(mockPush).not.toHaveBeenCalled();
  });

  // ── ChatInterface is mounted ──────────────────────────────────────────────────

  it('mounts the ChatInterface with the cleanup-agent slug', () => {
    render(<CleanupView {...BASE_PROPS} />);
    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
    expect(screen.getByTestId('chat-interface')).toHaveAttribute('data-agent', 'cleanup-agent');
  });

  // ── Refetch on chat events ────────────────────────────────────────────────────

  it('re-fetches the doc via apiClient.get when onStreamComplete fires and updates processedContent', async () => {
    // Arrange: apiClient.get will return updated processedContent
    vi.mocked(apiClient.get).mockResolvedValue(makeDocResponse('Stream-refreshed content'));

    render(<CleanupView {...BASE_PROPS} initialProcessedContent="old content before stream" />);

    // Confirm initial state
    expect(screen.getByText('old content before stream')).toBeInTheDocument();

    // Act: fire the onStreamComplete callback that CleanupView passes to ChatInterface
    await act(async () => {
      capturedOnStreamComplete?.();
    });

    // Assert: apiClient.get was called with the doc endpoint, and the preview
    // pane now shows the updated processedContent from the API response —
    // not the stale initialProcessedContent the component started with.
    await waitFor(() => {
      expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith(expect.stringContaining(DOC_ID));
      expect(screen.getByText('Stream-refreshed content')).toBeInTheDocument();
    });
  });

  it('re-fetches the doc via apiClient.get when onCapabilityResult fires and updates processedContent', async () => {
    // Arrange: apiClient.get returns content updated by a capability
    vi.mocked(apiClient.get).mockResolvedValue(makeDocResponse('Capability-refreshed content'));

    render(<CleanupView {...BASE_PROPS} initialProcessedContent="old content before capability" />);

    expect(screen.getByText('old content before capability')).toBeInTheDocument();

    // Act: fire the onCapabilityResult callback
    await act(async () => {
      capturedOnCapabilityResult?.();
    });

    // Assert: the preview pane reflects the content the API returned after the
    // capability ran — proving CleanupView called apiClient.get and applied
    // the response, not simply re-rendered with a mock return value.
    await waitFor(() => {
      expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith(expect.stringContaining(DOC_ID));
      expect(screen.getByText('Capability-refreshed content')).toBeInTheDocument();
    });
  });

  it('does not crash when refetch returns an unexpected shape', async () => {
    // Arrange: apiClient.get returns a shape that fails docResponseSchema.safeParse
    vi.mocked(apiClient.get).mockResolvedValue({ unexpected: 'shape' });

    render(<CleanupView {...BASE_PROPS} initialProcessedContent="original state" />);

    // Act: fire the stream complete callback — refetch should fail gracefully
    await act(async () => {
      capturedOnStreamComplete?.();
    });

    // Assert: the component remains stable; processedContent is unchanged
    await waitFor(() => {
      expect(screen.getByText('original state')).toBeInTheDocument();
    });
  });

  it('does not crash when refetch throws', async () => {
    // Arrange: apiClient.get throws a network error
    vi.mocked(apiClient.get).mockRejectedValue(new Error('Network failure'));

    render(<CleanupView {...BASE_PROPS} initialProcessedContent="stable content" />);

    // Act: fire the stream complete callback — catch block should swallow the error
    await act(async () => {
      capturedOnStreamComplete?.();
    });

    // Assert: component does not unmount; stable content is still shown
    await waitFor(() => {
      expect(screen.getByText('stable content')).toBeInTheDocument();
    });
  });

  // ── Edge-case branches (Cover unreached fallbacks) ───────────────────────────

  it('refetch with null processed AND null original content sets the preview to empty', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      document: {
        id: DOC_ID,
        status: 'cleaning',
        originalContent: null,
        processedContent: null,
      },
    });
    render(<CleanupView {...BASE_PROPS} initialProcessedContent="seed text" />);
    expect(screen.getByText('seed text')).toBeInTheDocument();

    await act(async () => {
      capturedOnStreamComplete?.();
    });

    // After refetch the section list rebuilds from empty content — the seed
    // text is no longer in the DOM. The empty preview renders one editable
    // section with an empty body; the Original tab's `(empty)` placeholder
    // is still there.
    await waitFor(() => {
      expect(screen.queryByText('seed text')).not.toBeInTheDocument();
    });
  });

  it('renders 0% reduction when originalContent is empty (no NaN/Infinity)', () => {
    render(<CleanupView {...BASE_PROPS} originalContent="" initialProcessedContent="" />);
    // Original tab still uses the `(empty)` placeholder; the cleaned tab now
    // renders a section list. The contract under test is the reduction-pct
    // guard: zero original length must not yield a percent label.
    expect(screen.queryByText(/% reduction/)).not.toBeInTheDocument();
  });

  it("falls back to the save error's own message when the finalise error body has no message", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });
    render(<CleanupView {...BASE_PROPS} />);

    await user.click(screen.getByRole('button', { name: /Mark cleaned/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not finish the clean up. Try again.'
      );
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("falls back to the save error's own message when finalise rejects with a non-Error value", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockRejectedValue('boom — plain string thrown');
    render(<CleanupView {...BASE_PROPS} />);

    await user.click(screen.getByRole('button', { name: /Mark cleaned/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not finish the clean up. Try again.'
      );
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  // ── Lock state branches ───────────────────────────────────────────────────────

  it('renders the "being edited by another admin" lock banner when heldByOther=true', () => {
    // Override the lock hook to return heldByOther=true.
    vi.mocked(useCleanupEditLock).mockReturnValue({
      ...mockLockState,
      state: {
        heldBy: 'other-admin-id',
        acquiredAt: '2026-01-01T00:00:00.000Z',
        active: true,
        ttlMs: 300_000,
      } satisfies CleanupLockState,
      heldByMe: false,
      heldByOther: true,
    });
    render(<CleanupView {...BASE_PROPS} />);
    // The banner must be visible — it tells the user who holds the lock.
    expect(screen.getByText(/being edited by/i)).toBeInTheDocument();
    // The action buttons must be disabled (finaliseDisabled = true when heldByOther).
    expect(screen.getByRole('button', { name: /Mark cleaned/i })).toBeDisabled();
  });

  it('renders the "Paused: document is being edited" overlay when heldByMe=true', () => {
    // When the local admin holds the lock (heldByMe=true), the chat section shows
    // a blocking overlay so a capability call cannot race an in-progress save.
    vi.mocked(useCleanupEditLock).mockReturnValue({
      ...mockLockState,
      state: {
        heldBy: 'local-admin-id',
        acquiredAt: '2026-01-01T00:00:00.000Z',
        active: true,
        ttlMs: 300_000,
      } satisfies CleanupLockState,
      heldByMe: true,
      heldByOther: false,
    });
    render(<CleanupView {...BASE_PROPS} />);
    expect(screen.getByText(/Paused: document is being edited/i)).toBeInTheDocument();
  });

  it('calls lock.release on unmount when heldByMe=true', async () => {
    // The useEffect cleanup in CleanupView calls `if (lock.heldByMe) void lock.release()`.
    // We need to confirm release fires when the component unmounts while heldByMe=true.
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useCleanupEditLock).mockReturnValue({
      ...mockLockState,
      state: {
        heldBy: 'local-admin-id',
        acquiredAt: '2026-01-01T00:00:00.000Z',
        active: true,
        ttlMs: 300_000,
      } satisfies CleanupLockState,
      heldByMe: true,
      heldByOther: false,
      release,
    });

    const { unmount } = render(<CleanupView {...BASE_PROPS} />);

    // The lock is held by me; unmounting should trigger the cleanup effect.
    unmount();

    // release() is called inside a void-wrapped async; wait for it.
    await waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it('does NOT call lock.release on unmount when heldByMe=false', () => {
    const release = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useCleanupEditLock).mockReturnValue({
      ...mockLockState,
      heldByMe: false,
      heldByOther: false,
      release,
    });

    const { unmount } = render(<CleanupView {...BASE_PROPS} />);
    unmount();

    // heldByMe was false — release must NOT have been called.
    expect(release).not.toHaveBeenCalled();
  });

  it('does NOT open the PendingChangeModal when onCapabilityResult fires with a non-rewrite slug', async () => {
    // The CleanupView onCapabilityResult has an early return for slugs that are
    // not 'rewrite_with_llm' or 'rewrite_section_with_llm' (L103 in the source).
    // Firing with 'strip_timestamps' must NOT set pendingChangeId.
    render(<CleanupView {...BASE_PROPS} />);

    await act(async () => {
      capturedOnCapabilityResultFull?.('strip_timestamps', {
        data: { pendingChangeId: 'should-not-be-set' },
      });
    });

    // changeId on the mocked PendingChangeModal must remain null.
    expect(capturedPendingChangeModalProps?.changeId).toBeNull();
  });

  // ── History button + child-callback wiring ────────────────────────────────

  it('opens the RevisionDrawer when the History button is clicked', async () => {
    const user = userEvent.setup();
    render(<CleanupView {...BASE_PROPS} />);

    // Drawer starts closed.
    expect(screen.queryByTestId('revision-drawer-open')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /History/i }));

    // The History onClick (L205) flips historyOpen → the mocked drawer renders.
    expect(screen.getByTestId('revision-drawer-open')).toBeInTheDocument();
  });

  it("falls back to the save error's own message when finalise error body fails to parse as JSON", async () => {
    // Exercises the `.catch(() => null)` arrow on `res.json()` (L144) — fires
    // when the server returned non-OK AND the body is malformed JSON.
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      json: () => Promise.reject('not json'),
    });
    render(<CleanupView {...BASE_PROPS} />);

    await user.click(screen.getByRole('button', { name: /Mark cleaned/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not finish the clean up. Try again.'
      );
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('refetches the doc when an EditableSection fires onSaved', async () => {
    // L306: the `onSaved={() => void refetchDoc()}` arrow passed to every
    // EditableSection. Firing it must trigger apiClient.get for the doc.
    vi.mocked(apiClient.get).mockResolvedValue(makeDocResponse('After section save'));

    render(<CleanupView {...BASE_PROPS} initialProcessedContent="initial" />);

    // At least one EditableSection was rendered (initialProcessedContent is non-empty).
    expect(capturedEditableSectionProps.length).toBeGreaterThan(0);

    await act(async () => {
      capturedEditableSectionProps[0].onSaved?.();
    });

    await waitFor(() => {
      expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith(expect.stringContaining(DOC_ID));
    });
  });

  it('opens the PendingChangeModal when an EditableSection fires onPendingChange', async () => {
    // L307: the `onPendingChange={(id) => setPendingChangeId(id)}` arrow.
    render(<CleanupView {...BASE_PROPS} initialProcessedContent="initial" />);

    expect(capturedEditableSectionProps.length).toBeGreaterThan(0);

    await act(async () => {
      capturedEditableSectionProps[0].onPendingChange?.('pending-change-id-42');
    });

    // The mocked modal now sees a non-null changeId and renders.
    await waitFor(() => {
      expect(capturedPendingChangeModalProps?.changeId).toBe('pending-change-id-42');
      expect(screen.getByTestId('pending-change-modal-open')).toBeInTheDocument();
    });
  });

  it('refetches the doc when the RevisionDrawer fires onRestored', async () => {
    // L357: `onRestored={() => void refetchDoc()}` on RevisionDrawer.
    vi.mocked(apiClient.get).mockResolvedValue(makeDocResponse('Restored content'));

    render(<CleanupView {...BASE_PROPS} />);
    expect(capturedRevisionDrawerProps).not.toBeNull();

    await act(async () => {
      capturedRevisionDrawerProps!.onRestored?.();
    });

    await waitFor(() => {
      expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith(expect.stringContaining(DOC_ID));
    });
  });

  it('clears pendingChangeId when the PendingChangeModal fires onClose', async () => {
    // L363: `onClose={() => setPendingChangeId(null)}` on PendingChangeModal.
    // First open the modal via an EditableSection callback, then close it.
    render(<CleanupView {...BASE_PROPS} initialProcessedContent="initial" />);

    await act(async () => {
      capturedEditableSectionProps[0].onPendingChange?.('change-77');
    });
    expect(capturedPendingChangeModalProps?.changeId).toBe('change-77');

    await act(async () => {
      capturedPendingChangeModalProps!.onClose?.();
    });

    await waitFor(() => {
      expect(capturedPendingChangeModalProps?.changeId).toBeNull();
    });
  });

  it('refetches the doc when the PendingChangeModal fires onResolved', async () => {
    // L364: `onResolved={() => void refetchDoc()}` on PendingChangeModal.
    vi.mocked(apiClient.get).mockResolvedValue(makeDocResponse('After accept'));

    render(<CleanupView {...BASE_PROPS} />);
    expect(capturedPendingChangeModalProps).not.toBeNull();

    await act(async () => {
      capturedPendingChangeModalProps!.onResolved?.();
    });

    await waitFor(() => {
      expect(vi.mocked(apiClient.get)).toHaveBeenCalledWith(expect.stringContaining(DOC_ID));
    });
  });
});

describe('CleanupView — preview pane tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn().mockImplementation(() => makeFetchSuccess({}));
    vi.mocked(apiClient.get).mockResolvedValue(makeDocResponse());
    mockLockState = {
      state: null,
      heldByMe: false,
      heldByOther: false,
      error: null,
      acquire: mockLockAcquire,
      release: mockLockRelease,
      refresh: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(useCleanupEditLock).mockReturnValue(mockLockState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Diff tab diffs the original against the current cleaned content', async () => {
    const user = userEvent.setup();
    render(<CleanupView {...BASE_PROPS} />);

    await user.click(screen.getByRole('tab', { name: /diff/i }));

    const diff = await screen.findByTestId('text-diff');
    expect(diff.getAttribute('data-before')).toBe(BASE_PROPS.originalContent);
    expect(diff.getAttribute('data-after')).toBe(BASE_PROPS.initialProcessedContent);
  });

  it('Diff tab honours the unified/split toggle', async () => {
    const user = userEvent.setup();
    render(<CleanupView {...BASE_PROPS} />);

    await user.click(screen.getByRole('tab', { name: /diff/i }));
    expect((await screen.findByTestId('text-diff')).getAttribute('data-mode')).toBe('unified');

    await user.click(screen.getByTestId('diff-mode-toggle'));

    expect(screen.getByTestId('text-diff').getAttribute('data-mode')).toBe('split');
  });

  it('History tab mounts the revision history against the live cleaned content', async () => {
    const user = userEvent.setup();
    render(<CleanupView {...BASE_PROPS} />);

    await user.click(screen.getByRole('tab', { name: /history/i }));

    const history = await screen.findByTestId('revision-history');
    expect(history.getAttribute('data-document-id')).toBe(DOC_ID);
    expect(history.getAttribute('data-current')).toBe(BASE_PROPS.initialProcessedContent);
  });

  it('offers a download of the cleaned text, switching to the original with the tab', async () => {
    // The button follows the visible tab so it can never disagree with what
    // the admin is looking at.
    const user = userEvent.setup();
    render(<CleanupView {...BASE_PROPS} />);

    const cleaned = screen.getByRole('link', { name: /download cleaned/i });
    expect(cleaned).toHaveAttribute('href', expect.stringContaining('/download?variant=cleaned'));
    expect(cleaned).toHaveAttribute('download');

    await user.click(screen.getByRole('tab', { name: /original/i }));

    const original = await screen.findByRole('link', { name: /download original/i });
    expect(original).toHaveAttribute('href', expect.stringContaining('/download?variant=original'));
  });

  it('the expand control widens the preview pane to the full grid and back', async () => {
    const user = userEvent.setup();
    const { container } = render(<CleanupView {...BASE_PROPS} />);

    const previewSection = container.querySelector('section');
    expect(previewSection?.className).not.toMatch(/lg:col-span-2/);

    const expand = screen.getByRole('button', { name: /expand document preview/i });
    await user.click(expand);
    expect(previewSection?.className).toMatch(/lg:col-span-2/);

    await user.click(screen.getByRole('button', { name: /shrink document preview/i }));
    expect(previewSection?.className).not.toMatch(/lg:col-span-2/);
  });
});
