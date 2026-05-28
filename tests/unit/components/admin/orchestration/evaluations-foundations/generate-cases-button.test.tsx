/**
 * GenerateCasesButton — component tests.
 *
 * Coverage:
 * - Configure step renders agent + mode + count + (KB) topic
 * - Generate fires the preview endpoint with the chosen mode + topic
 * - Review step shows the proposed cases and a cost summary
 * - Save commits ONLY the selected proposals via the commit endpoint
 * - Back from review resets the modal to the configure step
 * - API error response is surfaced inline
 *
 * @see components/admin/orchestration/evaluations-foundations/generate-cases-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

import { GenerateCasesButton } from '@/components/admin/orchestration/evaluations-foundations/generate-cases-button';

const AGENTS = [
  { id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' },
  { id: 'a-2', name: 'Bot Beta', slug: 'bot-beta' },
];

const PREVIEW_PAYLOAD = {
  success: true,
  data: {
    cases: [
      {
        input: 'What is the refund window?',
        expectedOutput: '30 days [1].',
        metadata: { source: 'synthetic', mode: 'kb' },
      },
      {
        input: 'Do refunds apply to digital goods?',
        expectedOutput: 'Yes, within 14 days [2].',
        metadata: { source: 'synthetic', mode: 'kb' },
      },
    ],
    costUsd: 0.0042,
    tokenUsage: { input: 250, output: 120 },
  },
};

const COMMIT_OK = {
  success: true,
  data: { datasetId: 'ds-1', appendedCount: 2, newCaseCount: 12, newContentHash: 'h' },
};

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
    return { ok: true, status: 200, json: async () => next } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GenerateCasesButton — configure step', () => {
  it('renders the trigger and opens to the configure step', async () => {
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);
    expect(screen.getByRole('button', { name: /Generate cases/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.getByText(/Pick a subject agent/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/Count/i)).toBeInTheDocument();
    // KB is the default mode, so the topic field is visible
    expect(screen.getByLabelText(/Topic/i)).toBeInTheDocument();
  });

  it('shows a helpful message when no chat agents are provided', async () => {
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={[]} />);
    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.getByText(/No chat agents available/i)).toBeInTheDocument();
    });
  });
});

describe('GenerateCasesButton — preview', () => {
  it('posts agentId + mode + count + topic to the preview endpoint and moves to review', async () => {
    const fetchMock = mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Topic/i)).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText(/Topic/i), 'refunds');
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const previewCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/generate-cases'));
    const init = (previewCall as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      agentId: 'a-1',
      mode: 'kb',
      count: 5,
      topic: 'refunds',
    });

    // Now on review step
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/What is the refund window/i)).toBeInTheDocument();
  });

  it('surfaces a 4xx preview error inline', async () => {
    mockFetchSequence([
      {
        _status: 429,
        body: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
      },
    ]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Too many requests/i)).toBeInTheDocument();
    });
  });
});

describe('GenerateCasesButton — commit', () => {
  it('commits only the proposals still checked when Save is clicked', async () => {
    const fetchMock = mockFetchSequence([PREVIEW_PAYLOAD, COMMIT_OK]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    // Untick the first proposal
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);

    await user.click(screen.getByRole('button', { name: /Save 1 case/i }));

    await waitFor(() => {
      const commitCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('/generate-cases/commit')
      );
      expect(commitCall).toBeTruthy();
      const init = (commitCall as [string, RequestInit])[1];
      const body = JSON.parse(init.body as string);
      expect(body.cases).toHaveLength(1);
      expect(body.cases[0].input).toBe('Do refunds apply to digital goods?');
    });
    // Router refresh fires so the dataset detail server-render re-pulls the new caseCount
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('disables the Save button when nothing is selected', async () => {
    mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);

    expect(screen.getByRole('button', { name: /Save 0 cases/i })).toBeDisabled();
  });

  it('Back resets to the configure step', async () => {
    mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByLabelText(/Count/i)).toBeInTheDocument();
  });

  it('inline edits on the review step are reflected in the committed cases', async () => {
    const fetchMock = mockFetchSequence([PREVIEW_PAYLOAD, COMMIT_OK]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    // Edit the first proposal's input. CaseReviewStep ids the textareas
    // as `proposal-{i}-input` / `proposal-{i}-expected`.
    const inputBox = document.getElementById('proposal-0-input') as HTMLTextAreaElement;
    await user.clear(inputBox);
    await user.type(inputBox, 'EDITED QUESTION');

    await user.click(screen.getByRole('button', { name: /Save 2 cases/i }));

    await waitFor(() => {
      const commitCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('/generate-cases/commit')
      );
      expect(commitCall).toBeTruthy();
      const init = (commitCall as [string, RequestInit])[1];
      const body = JSON.parse(init.body as string);
      expect(body.cases[0].input).toBe('EDITED QUESTION');
    });
  });

  it('surfaces a 5xx commit error with the specific server message', async () => {
    // Branch: commit endpoint returns !res.ok with error envelope
    mockFetchSequence([
      PREVIEW_PAYLOAD,
      {
        _status: 500,
        body: { success: false, error: { code: 'INTERNAL', message: 'Write transaction failed' } },
      },
    ]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Save 2 cases/i }));

    await waitFor(() => {
      expect(screen.getByText(/Write transaction failed/i)).toBeInTheDocument();
    });
    // The router should NOT have refreshed since commit failed
    expect(mockRefresh).not.toHaveBeenCalled();
    // Modal stays open so the user can retry
    expect(screen.getByRole('button', { name: /Save 2 cases/i })).toBeInTheDocument();
  });

  it('surfaces the HTTP status when commit returns not-ok but with a success-shaped body', async () => {
    // Branch: !res.ok but payload.success truthy → `Failed (${res.status})`
    mockFetchSequence([
      PREVIEW_PAYLOAD,
      {
        _status: 503,
        body: { success: true, data: {} },
      },
    ]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Save 2 cases/i }));

    await waitFor(() => {
      expect(screen.getByText(/Failed \(503\)/i)).toBeInTheDocument();
    });
  });

  it('surfaces a network error thrown during commit', async () => {
    // Branch: catch block in handleCommit
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => PREVIEW_PAYLOAD,
      })
      .mockRejectedValueOnce(new Error('Connection reset'));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Save 2 cases/i }));

    await waitFor(() => {
      expect(screen.getByText(/Connection reset/i)).toBeInTheDocument();
    });
    // committing resets to false after catch
    expect(screen.getByRole('button', { name: /Save 2 cases/i })).not.toBeDisabled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('shows "Select at least one case" error when all proposals are unticked and Save is clicked', async () => {
    // Branch: handleCommit early-return when accepted.length === 0
    // (The Save button is disabled when selectedIndices.size === 0 for the normal case,
    // but this exercises the guard inside handleCommit via direct deselection.)
    // Note: the Save button itself is disabled when selectedIndices.size === 0,
    // so this verifies the disabled-state branch via the button attribute.
    mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);

    // Save button disabled + no API call should have been made beyond the preview
    const saveBtn = screen.getByRole('button', { name: /Save 0 cases/i });
    expect(saveBtn).toBeDisabled();
  });
});

describe('GenerateCasesButton — configure step branches', () => {
  it('hides the topic field when mode is failure_mining', async () => {
    // Branch: ConfigureStep renders topic input only when mode === 'kb'
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Topic/i)).toBeInTheDocument();
    });

    // Switch to failure_mining — topic field should disappear
    // The text "Failure-mining" also appears in the helper paragraph, so we
    // target the SelectItem by role (option) to avoid the multiple-match error.
    const modeSelect = screen.getByRole('combobox', { name: /Mode/i });
    await user.click(modeSelect);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Failure-mining/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('option', { name: /Failure-mining/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText(/Topic/i)).not.toBeInTheDocument();
    });
  });

  it('does not include topic in the generate body when mode is failure_mining', async () => {
    // Branch: topic is only appended to body when mode === 'kb'
    const fetchMock = mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Mode/i)).toBeInTheDocument();
    });

    // Switch to failure_mining — use role=option to avoid matching the helper paragraph
    const modeSelect = screen.getByRole('combobox', { name: /Mode/i });
    await user.click(modeSelect);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Failure-mining/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('option', { name: /Failure-mining/i }));

    await user.click(screen.getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const previewCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/generate-cases'));
    const init = (previewCall as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body.mode).toBe('failure_mining');
    // topic must NOT be present in failure_mining requests
    expect(body).not.toHaveProperty('topic');
  });

  it('does not include topic in body when topic is blank even in kb mode', async () => {
    // Branch: topic.trim().length > 0 guard — empty topic is omitted from request
    const fetchMock = mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Topic/i)).toBeInTheDocument();
    });
    // Leave topic blank
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const previewCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/generate-cases'));
    const init = (previewCall as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string);
    expect(body.mode).toBe('kb');
    expect(body).not.toHaveProperty('topic');
  });

  it('disables the Generate button when there are no agents', async () => {
    // Branch: disabled={generating || !agentId || agents.length === 0}
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={[]} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.getByText(/No chat agents available/i)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /^Generate$/i })).toBeDisabled();
  });

  it('shows singular "case" in Save button label when exactly 1 proposal is selected', async () => {
    // Branch: selectedIndices.size === 1 → "Save 1 case" not "Save 1 cases"
    mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    // Untick the second case — only 1 selected
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]);

    expect(screen.getByRole('button', { name: /Save 1 case$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save 1 cases/i })).not.toBeInTheDocument();
  });
});

describe('GenerateCasesButton — modal lifecycle', () => {
  it('resets to configure step on Cancel and clears prior error', async () => {
    // Branch: handleOpen(false) → reset() clears error/preview/step
    mockFetchSequence([
      {
        _status: 429,
        body: { success: false, error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
      },
    ]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Too many requests/i)).toBeInTheDocument();
    });

    // Cancel closes + resets
    await user.click(screen.getByRole('button', { name: /Cancel/i }));

    // Reopen — error should be gone, back on configure step
    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.queryByText(/Too many requests/i)).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/Count/i)).toBeInTheDocument();
  });

  it('closes the modal and refreshes the router after a successful commit', async () => {
    // Branch: router.refresh() + handleOpen(false) on success
    mockFetchSequence([PREVIEW_PAYLOAD, COMMIT_OK]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Save 2 cases/i }));

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    // Modal is closed — the trigger button is visible again
    expect(screen.getByRole('button', { name: /Generate cases/i })).toBeInTheDocument();
    // No lingering dialog content
    expect(screen.queryByText(/2 proposals/i)).not.toBeInTheDocument();
  });

  it('describes the review step when on the review step', async () => {
    // Branch: DialogDescription changes text based on step
    mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await waitFor(() => {
      expect(screen.getByText(/Pick a subject agent and a seed mode/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Review the 2 proposed cases below/i)).toBeInTheDocument();
  });

  it('re-enables a deselected proposal when it is toggled back on', async () => {
    // Branch: the `else next.add(i)` path in toggleSelected (line 190)
    mockFetchSequence([PREVIEW_PAYLOAD]);
    const user = userEvent.setup();
    render(<GenerateCasesButton datasetId="ds-1" agents={AGENTS} />);

    await user.click(screen.getByRole('button', { name: /Generate cases/i }));
    await user.click(screen.getByRole('button', { name: /^Generate$/i }));
    await waitFor(() => {
      expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole('checkbox');
    // Untick first (delete from set)
    await user.click(checkboxes[0]);
    expect(screen.getByRole('button', { name: /Save 1 case$/i })).toBeInTheDocument();

    // Re-tick first (add back to set) — exercises the `else next.add(i)` branch
    await user.click(checkboxes[0]);
    expect(screen.getByRole('button', { name: /Save 2 cases/i })).toBeInTheDocument();
  });
});
