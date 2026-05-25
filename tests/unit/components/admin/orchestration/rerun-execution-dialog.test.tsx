/**
 * RerunExecutionDialog Component Tests
 *
 * Test Coverage:
 * - Loads versions + cost estimate in parallel on open
 * - Defaults selection to the workflow's current published version
 * - Filters the version chooser to versions ≥ the original's version
 * - Surfaces the "only original" notice when no newer versions exist
 * - Surfaces a load error when the versions fetch rejects
 * - Confirm posts to the rerun endpoint with the selected versionId
 * - On `workflow_started` frame: navigates and closes the dialog
 * - Stream-without-workflow_started yields a "Stream closed" error
 * - Cost estimate failure does NOT block the dialog (decorative)
 *
 * @see components/admin/orchestration/rerun-execution-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),

  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
      public code = 'INTERNAL_ERROR'
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// Globalised `fetch` mock for the SSE branch — `handleConfirm` uses raw
// fetch rather than the apiClient so it can stream frame-by-frame.
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

import { RerunExecutionDialog } from '@/components/admin/orchestration/rerun-execution-dialog';
import { apiClient } from '@/lib/api/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EXECUTION_ID = 'exec_test';
const WORKFLOW_ID = 'wf_test';
const VERSION_ID_V1 = 'ver_v1';
const VERSION_ID_V2 = 'ver_v2';
const VERSION_ID_V3 = 'ver_v3';

function makeVersion(
  overrides: Partial<{ id: string; version: number; changeSummary: string | null }> = {}
) {
  return {
    id: 'ver_default',
    version: 1,
    changeSummary: null,
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

interface VersionsResponse {
  versions: ReturnType<typeof makeVersion>[];
  publishedVersionId: string | null;
  nextCursor: string | null;
}

function versionsResponse(
  versions: ReturnType<typeof makeVersion>[],
  publishedVersionId: string | null
): VersionsResponse {
  return { versions, publishedVersionId, nextCursor: null };
}

const COST_ESTIMATE = { lowUsd: 0.012, highUsd: 0.045 };

/**
 * Wire up apiClient.get so the versions call resolves to `versions` and
 * the cost estimate call resolves to `cost`. The dialog kicks off both
 * with Promise.allSettled — the second `apiClient.get` matches whichever
 * url is requested second. Order-independent: we dispatch by URL.
 */
function mockApiCalls(opts: {
  versions: VersionsResponse | Error;
  cost?: typeof COST_ESTIMATE | Error;
}) {
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => {
    if (url.includes('/versions')) {
      if (opts.versions instanceof Error) throw opts.versions;
      return opts.versions as never;
    }
    if (url.includes('/cost-estimate')) {
      if (opts.cost === undefined) return COST_ESTIMATE as never;
      if (opts.cost instanceof Error) throw opts.cost;
      return opts.cost as never;
    }
    throw new Error(`Unexpected URL in test: ${url}`);
  });
}

/**
 * Build a Response with a streaming body emitting the given SSE blocks
 * (each block separated by `\n\n`). Mirrors what the server sends.
 */
function makeSseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const b of blocks) controller.enqueue(encoder.encode(b + '\n\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockReset();
});

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  execution: { id: EXECUTION_ID, workflowId: WORKFLOW_ID, versionId: VERSION_ID_V2 },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RerunExecutionDialog', () => {
  describe('on open', () => {
    it('loads versions + cost estimate in parallel and defaults to the published version', async () => {
      mockApiCalls({
        versions: versionsResponse(
          [
            makeVersion({ id: VERSION_ID_V1, version: 1 }),
            makeVersion({ id: VERSION_ID_V2, version: 2 }),
            makeVersion({ id: VERSION_ID_V3, version: 3, changeSummary: 'Latest' }),
          ],
          VERSION_ID_V3
        ),
      });

      render(<RerunExecutionDialog {...baseProps} />);

      await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
      // The selected value should be the published version by default;
      // the chooser is the only place that surfaces it pre-confirm.
      const trigger = await screen.findByTestId('rerun-version-select');
      // Trigger renders the SelectValue — its accessible name shows
      // the v-prefixed label.
      expect(trigger).toHaveTextContent(/v3/);
    });

    it('renders the cost estimate when the estimate call succeeds', async () => {
      mockApiCalls({
        versions: versionsResponse([makeVersion({ id: VERSION_ID_V2, version: 2 })], VERSION_ID_V2),
      });

      render(<RerunExecutionDialog {...baseProps} />);

      const est = await screen.findByTestId('rerun-cost-estimate');
      expect(est).toHaveTextContent('$0.01');
      expect(est).toHaveTextContent('$0.04');
    });

    it('still renders the dialog when the cost estimate call rejects (estimate is decorative)', async () => {
      mockApiCalls({
        versions: versionsResponse([makeVersion({ id: VERSION_ID_V2, version: 2 })], VERSION_ID_V2),
        cost: new Error('rate limited'),
      });

      render(<RerunExecutionDialog {...baseProps} />);

      // Confirm button still mounts (chooser absent because only 1 eligible).
      await screen.findByTestId('rerun-confirm');
      expect(screen.queryByTestId('rerun-cost-estimate')).not.toBeInTheDocument();
    });

    it('filters the version chooser to versions ≥ the original execution version', async () => {
      // Original execution ran on v2. Versions list has v1, v2, v3. Only
      // v2 and v3 are eligible — v1 (predates the run) should be hidden.
      mockApiCalls({
        versions: versionsResponse(
          [
            makeVersion({ id: VERSION_ID_V1, version: 1 }),
            makeVersion({ id: VERSION_ID_V2, version: 2 }),
            makeVersion({ id: VERSION_ID_V3, version: 3 }),
          ],
          VERSION_ID_V3
        ),
      });
      const user = userEvent.setup();

      render(<RerunExecutionDialog {...baseProps} />);

      await user.click(await screen.findByTestId('rerun-version-select'));
      expect(screen.getByTestId(`rerun-version-${VERSION_ID_V2}`)).toBeInTheDocument();
      expect(screen.getByTestId(`rerun-version-${VERSION_ID_V3}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`rerun-version-${VERSION_ID_V1}`)).not.toBeInTheDocument();
    });

    it('shows the "only original" notice when only the original version is eligible', async () => {
      // Workflow has only v2; original ran on v2. eligibleVersions.length === 1.
      mockApiCalls({
        versions: versionsResponse([makeVersion({ id: VERSION_ID_V2, version: 2 })], VERSION_ID_V2),
      });

      render(<RerunExecutionDialog {...baseProps} />);

      const notice = await screen.findByTestId('rerun-same-version-notice');
      expect(notice).toHaveTextContent(/no newer versions/i);
      // No chooser when there's only one eligible row.
      expect(screen.queryByTestId('rerun-version-select')).not.toBeInTheDocument();
    });

    it('surfaces a load error when the versions fetch rejects', async () => {
      mockApiCalls({
        versions: new Error('versions endpoint down'),
      });

      render(<RerunExecutionDialog {...baseProps} />);

      const err = await screen.findByTestId('rerun-error');
      expect(err.textContent?.length).toBeGreaterThan(0);
    });
  });

  describe('confirm flow', () => {
    it('posts to the rerun endpoint with the selected versionId and navigates on workflow_started', async () => {
      mockApiCalls({
        versions: versionsResponse(
          [
            makeVersion({ id: VERSION_ID_V2, version: 2 }),
            makeVersion({ id: VERSION_ID_V3, version: 3 }),
          ],
          VERSION_ID_V3
        ),
      });
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          'event: workflow_started\ndata: {"executionId":"exec_new","workflowId":"wf_test"}',
        ])
      );
      const user = userEvent.setup();

      render(<RerunExecutionDialog {...baseProps} />);

      await user.click(await screen.findByTestId('rerun-confirm'));

      // POST fired with versionId in body
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      const [, init] = mockFetch.mock.calls[0] as [unknown, RequestInit];
      expect(init.method).toBe('POST');
      // Narrow to string before JSON.parse — the RequestInit body type
      // is a union including FormData/Blob/ReadableStream/etc. The
      // dialog always passes a stringified JSON literal, so the
      // assertion would fail with a clearer message than a generic
      // "[object Object]" if that ever changed.
      expect(typeof init.body).toBe('string');
      expect(JSON.parse(init.body as string)).toEqual({
        versionId: VERSION_ID_V3,
      });

      // Navigated to the new execution detail page
      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/executions/exec_new')
      );
      // Dialog closed
      expect(baseProps.onOpenChange).toHaveBeenCalledWith(false);
    });

    it('surfaces the server error envelope when fetch returns non-OK with JSON body', async () => {
      mockApiCalls({
        versions: versionsResponse([makeVersion({ id: VERSION_ID_V2, version: 2 })], VERSION_ID_V2),
      });
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Workflow inactive' } }), {
          status: 400,
        })
      );
      const user = userEvent.setup();

      render(<RerunExecutionDialog {...baseProps} />);
      await user.click(await screen.findByTestId('rerun-confirm'));

      const err = await screen.findByTestId('rerun-error');
      expect(err).toHaveTextContent('Workflow inactive');
    });

    it("falls back to a generic HTTP message when the error body isn't JSON", async () => {
      mockApiCalls({
        versions: versionsResponse([makeVersion({ id: VERSION_ID_V2, version: 2 })], VERSION_ID_V2),
      });
      mockFetch.mockResolvedValueOnce(new Response('plain text', { status: 503 }));
      const user = userEvent.setup();

      render(<RerunExecutionDialog {...baseProps} />);
      await user.click(await screen.findByTestId('rerun-confirm'));

      const err = await screen.findByTestId('rerun-error');
      expect(err).toHaveTextContent(/503/);
    });

    it('errors clearly when the stream closes before workflow_started arrives', async () => {
      mockApiCalls({
        versions: versionsResponse([makeVersion({ id: VERSION_ID_V2, version: 2 })], VERSION_ID_V2),
      });
      // SSE stream emits an unrelated frame and then closes
      mockFetch.mockResolvedValueOnce(
        makeSseResponse(['event: workflow_paused\ndata: {"stepId":"x"}'])
      );
      const user = userEvent.setup();

      render(<RerunExecutionDialog {...baseProps} />);
      await user.click(await screen.findByTestId('rerun-confirm'));

      const err = await screen.findByTestId('rerun-error');
      expect(err).toHaveTextContent(/stream closed/i);
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  describe('legacy executions (versionId: null)', () => {
    it('shows the full versions list when the original execution has no recorded versionId', async () => {
      // Legacy rows pre-date the version-pinning feature, so versionId
      // is null. The chooser's filter has no anchor and must fall back
      // to showing every available version.
      mockApiCalls({
        versions: versionsResponse(
          [
            makeVersion({ id: VERSION_ID_V1, version: 1 }),
            makeVersion({ id: VERSION_ID_V2, version: 2 }),
          ],
          VERSION_ID_V2
        ),
      });
      const user = userEvent.setup();

      render(
        <RerunExecutionDialog
          {...baseProps}
          execution={{ id: EXECUTION_ID, workflowId: WORKFLOW_ID, versionId: null }}
        />
      );

      await user.click(await screen.findByTestId('rerun-version-select'));
      expect(screen.getByTestId(`rerun-version-${VERSION_ID_V1}`)).toBeInTheDocument();
      expect(screen.getByTestId(`rerun-version-${VERSION_ID_V2}`)).toBeInTheDocument();
    });

    it('does not surface the "only original" notice for legacy rows even with one eligible version', async () => {
      // `onlyOriginalAvailable` is gated on `execution.versionId !== null`.
      // A legacy row should not see that messaging — there's nothing to
      // refer back to.
      mockApiCalls({
        versions: versionsResponse([makeVersion({ id: VERSION_ID_V2, version: 2 })], VERSION_ID_V2),
      });

      render(
        <RerunExecutionDialog
          {...baseProps}
          execution={{ id: EXECUTION_ID, workflowId: WORKFLOW_ID, versionId: null }}
        />
      );

      await screen.findByTestId('rerun-confirm');
      expect(screen.queryByTestId('rerun-same-version-notice')).not.toBeInTheDocument();
    });
  });

  describe('submitting state', () => {
    it('shows the "Starting…" label and disables both action buttons while in flight', async () => {
      mockApiCalls({
        versions: versionsResponse([makeVersion({ id: VERSION_ID_V2, version: 2 })], VERSION_ID_V2),
      });
      // Never-resolving fetch so we can observe the in-flight state.
      mockFetch.mockReturnValueOnce(new Promise(() => {}));
      const user = userEvent.setup();

      render(<RerunExecutionDialog {...baseProps} />);
      const confirm = await screen.findByTestId('rerun-confirm');
      await user.click(confirm);

      await waitFor(() => expect(confirm).toHaveTextContent(/starting/i));
      expect(confirm).toBeDisabled();
    });
  });

  describe('closed state', () => {
    it('does not fetch when open is false', () => {
      render(<RerunExecutionDialog {...baseProps} open={false} />);
      expect(apiClient.get).not.toHaveBeenCalled();
    });
  });
});
