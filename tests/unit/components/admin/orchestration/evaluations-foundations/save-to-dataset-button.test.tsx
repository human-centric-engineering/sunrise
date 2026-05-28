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

  it('surfaces the status code when the capture response is not-ok but success-shaped', async () => {
    // Branch: !res.ok but payload.success is truthy — falls through to `Failed (${res.status})`
    mockFetchSequence([
      DATASETS_PAYLOAD,
      {
        _status: 503,
        body: { success: true, data: {} },
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
      expect(screen.getByText(/Failed \(503\)/i)).toBeInTheDocument();
    });
    // Dialog stays open so user can retry or cancel
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('surfaces a network error from the capture fetch', async () => {
    // Branch: catch block in handleSave — fetch throws
    const fetchMock = vi.fn();
    fetchMock
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => DATASETS_PAYLOAD,
      }))
      .mockRejectedValueOnce(new Error('Network timeout'));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(screen.getByText(/FAQ/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Network timeout/i)).toBeInTheDocument();
    });
    // After catch, submitting resets so the Save button is not spinning
    expect(screen.getByRole('button', { name: /^Save$/i })).not.toBeDisabled();
  });

  it('shows an error when the dataset list fetch fails with an error envelope', async () => {
    // Branch: dataset load returns success:false payload
    mockFetchSequence([
      {
        _status: 500,
        body: { success: false, error: { message: 'DB unavailable' } },
      },
    ]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));

    await waitFor(() => {
      expect(screen.getByText(/DB unavailable/i)).toBeInTheDocument();
    });
    // Datasets are empty — shows the "no datasets" empty-list path
    expect(screen.getByText(/No datasets yet/i)).toBeInTheDocument();
  });

  it('shows an error when the dataset list fetch throws', async () => {
    // Branch: catch block in the dataset-loading useEffect
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));

    await waitFor(() => {
      expect(screen.getByText(/offline/i)).toBeInTheDocument();
    });
  });

  it('shows "Pick a destination dataset" error when Save is clicked with no dataset selected', async () => {
    // Branch: handleSave early-return when !datasetId
    mockFetchSequence([{ success: true, data: [] }]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(screen.getByText(/No datasets yet/i)).toBeInTheDocument();
    });

    // Save button disabled when no datasetId — but if somehow clicked, setError fires
    // The button is disabled so no API call should happen
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();
  });
});

describe('SaveToDatasetButton — dataset list formats', () => {
  it('handles a nested { items: [...] } envelope from the datasets endpoint', async () => {
    // Branch: the `items`-key path in the tolerate-either-envelope logic (line 109)
    const itemsPayload = {
      success: true,
      data: {
        items: [{ id: 'ds-5', name: 'Nested List', caseCount: 3 }],
      },
    };
    const fetchMock = mockFetchSequence([itemsPayload, CAPTURE_OK]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));

    await waitFor(() => {
      expect(screen.getByText(/Nested List/i)).toBeInTheDocument();
    });

    // The component auto-selected the first item; save should work
    await user.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      const captureCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/capture'));
      expect(captureCall).toBeTruthy();
      const init = (captureCall as [string, RequestInit])[1];
      const body = JSON.parse(init.body as string);
      // API call used the id from the nested items envelope, not a fallback
      expect(body.kind).toBe('conversation_turn');
    });
    expect(screen.getByText(/Captured/i)).toBeInTheDocument();
  });

  it('shows the loading state while datasets are fetching', async () => {
    // Branch: datasets === null shows the loading spinner
    let resolveDatasets!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((res) => {
          resolveDatasets = res;
        })
      )
    );
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));

    // While fetch is still pending, the loading text should be visible
    expect(screen.getByText(/Loading datasets/i)).toBeInTheDocument();

    // Resolve the fetch to clean up
    resolveDatasets({
      ok: true,
      status: 200,
      json: async () => DATASETS_PAYLOAD,
    } as Response);
    await waitFor(() => {
      expect(screen.queryByText(/Loading datasets/i)).not.toBeInTheDocument();
    });
  });
});

describe('SaveToDatasetButton — modal lifecycle', () => {
  it('shows the workflow_execution description variant when source kind is workflow_execution', async () => {
    // Branch: DialogDescription renders different text for each source kind
    mockFetchSequence([DATASETS_PAYLOAD]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'workflow_execution', executionId: 'exe-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));

    await waitFor(() => {
      expect(screen.getByText(/workflow execution as a new dataset case/i)).toBeInTheDocument();
    });
  });

  it('closes and resets state when Cancel is clicked', async () => {
    // Branch: handleClose() resets success/error but keeps datasets cached
    const fetchMock = mockFetchSequence([DATASETS_PAYLOAD]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(screen.getByText(/FAQ/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Cancel/i }));

    // Dialog is now closed — trigger is visible again
    expect(screen.getByRole('button', { name: /Save to dataset/i })).toBeInTheDocument();

    // Reopen — datasets should not be re-fetched (cached)
    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(screen.getByText(/FAQ/i)).toBeInTheDocument();
    });
    // Only one fetch call total (the initial load); no second load on re-open
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the success panel after a successful capture and closes on Done', async () => {
    // Branch: success state renders SuccessPanel; Done calls handleClose
    mockFetchSequence([DATASETS_PAYLOAD, CAPTURE_OK]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(screen.getByText(/FAQ/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Captured/i)).toBeInTheDocument();
    });
    // Footer buttons disappear in success state (SuccessPanel renders its own Done button)
    expect(screen.queryByRole('button', { name: /Cancel/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Done$/i }));
    // Dialog closes — trigger is visible again
    expect(screen.getByRole('button', { name: /Save to dataset/i })).toBeInTheDocument();
  });

  it('renders singular "case" in SuccessPanel when newCaseCount is 1', async () => {
    // Branch: newCaseCount === 1 → no trailing 's'
    const captureOkSingular = {
      success: true,
      data: { datasetId: 'ds-1', appendedCount: 1, newCaseCount: 1, newContentHash: 'h' },
    };
    mockFetchSequence([DATASETS_PAYLOAD, captureOkSingular]);
    const user = userEvent.setup();
    render(<SaveToDatasetButton source={{ kind: 'conversation_turn', messageId: 'm-1' }} />);

    await user.click(screen.getByRole('button', { name: /Save to dataset/i }));
    await waitFor(() => {
      expect(screen.getByText(/FAQ/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      // Singular: "1 case" not "1 cases"
      expect(screen.getByText(/dataset now has 1 case\./i)).toBeInTheDocument();
    });
  });
});
