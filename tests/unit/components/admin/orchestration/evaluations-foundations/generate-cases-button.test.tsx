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

function mockFetchSequence(
  responses: Array<Record<string, unknown> | { _status: number; body: Record<string, unknown> }>
): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockImplementation(async () => {
    const next = responses.shift();
    if (!next) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ success: false, error: { message: 'no more mocks' } }),
      } as Response;
    }
    if ('_status' in next) {
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
});
