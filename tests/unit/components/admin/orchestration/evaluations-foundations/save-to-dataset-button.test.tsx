/**
 * SaveToDatasetButton — component tests.
 *
 * Coverage:
 * - Trigger button is rendered with the configured label
 * - Opening the modal loads datasets via the EVAL_DATASETS endpoint
 * - Save posts the right body shape for `conversation_turn` source
 * - Save posts the right body shape for `workflow_execution` source
 * - API error response is surfaced inline
 *
 * @see components/admin/orchestration/evaluations-foundations/save-to-dataset-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SaveToDatasetButton } from '@/components/admin/orchestration/evaluations-foundations/save-to-dataset-button';
import { API } from '@/lib/api/endpoints';

type FetchMock = Record<string, unknown> | { _status: number; body: Record<string, unknown> };

function isErrorMock(m: FetchMock): m is { _status: number; body: Record<string, unknown> } {
  return typeof (m as { _status?: unknown })._status === 'number';
}

function mockFetchSequence(responses: FetchMock[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockImplementation(async () => {
    const next = responses.shift();
    if (!next) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ success: false, error: { message: 'no more mocks' } }),
      } as Response;
    }
    if (isErrorMock(next)) {
      return {
        ok: next._status < 400,
        status: next._status,
        json: async () => next.body,
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => next,
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const DATASETS_PAYLOAD = {
  success: true,
  data: [
    { id: 'ds-1', name: 'FAQ', caseCount: 12 },
    { id: 'ds-2', name: 'Refunds', caseCount: 8 },
  ],
};

const CAPTURE_OK = {
  success: true,
  data: { datasetId: 'ds-1', appendedCount: 1, newCaseCount: 13, newContentHash: 'h' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SaveToDatasetButton — trigger', () => {
  it('renders the configured label on the trigger', () => {
    render(
      <SaveToDatasetButton
        source={{ kind: 'conversation_turn', messageId: 'm-1' }}
        label="Save it"
      />
    );
    expect(screen.getByRole('button', { name: /Save it/i })).toBeInTheDocument();
  });
});

describe('SaveToDatasetButton — conversation_turn source', () => {
  it('loads datasets on open and posts the capture body when saved', async () => {
    const fetchMock = mockFetchSequence([DATASETS_PAYLOAD, CAPTURE_OK]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'msg-abc' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    // Wait for datasets to populate
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(API.ADMIN.ORCHESTRATION.EVAL_DATASETS)
      );
    });
    // Save action
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const captureCall = calls.find((c) => String(c[0]).includes('/capture'));
      expect(captureCall).toBeTruthy();
      const init = (captureCall as [string, RequestInit])[1];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ kind: 'conversation_turn', messageId: 'msg-abc' });
    });
    expect(screen.getByText(/Captured/i)).toBeInTheDocument();
  });
});

describe('SaveToDatasetButton — workflow_execution source', () => {
  it('defaults the selector to last_step when omitted', async () => {
    const fetchMock = mockFetchSequence([DATASETS_PAYLOAD, CAPTURE_OK]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'workflow_execution', executionId: 'exe-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const captureCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/capture'));
      const init = (captureCall as [string, RequestInit])[1];
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        kind: 'workflow_execution',
        executionId: 'exe-1',
        selector: { kind: 'last_step' },
      });
    });
  });

  it('passes a step_id selector through verbatim', async () => {
    const fetchMock = mockFetchSequence([DATASETS_PAYLOAD, CAPTURE_OK]);
    const user = userEvent.setup();
    render(
      <SaveToDatasetButton
        source={{
          kind: 'workflow_execution',
          executionId: 'exe-1',
          selector: { kind: 'step_id', stepId: 'final-report' },
        }}
      />
    );

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const captureCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/capture'));
      const init = (captureCall as [string, RequestInit])[1];
      const body = JSON.parse(init.body as string);
      expect(body.selector).toEqual({ kind: 'step_id', stepId: 'final-report' });
    });
  });
});

describe('SaveToDatasetButton — error handling', () => {
  it('surfaces a 4xx response message inline', async () => {
    mockFetchSequence([
      DATASETS_PAYLOAD,
      {
        _status: 400,
        body: {
          success: false,
          error: { code: 'BAD_REQUEST', message: 'Message not found' },
        },
      },
    ]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(screen.getByText(/FAQ/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Message not found/i)).toBeInTheDocument();
    });
  });
});
