/**
 * RunCreateForm Component Tests
 *
 * Test coverage:
 * - Renders heuristic graders in their own subsection
 * - Renders built-in and custom judge agents in distinct subsections
 * - Ticking a heuristic adds a metric entry with the grader's defaultConfig
 * - Ticking a judge adds { slug: 'judge_agent', config: { agentSlug } }
 * - Per-grader inline editors appear for regex / length_between / tool_was_called / citation_count_at_least
 * - Submit requires name + agent + dataset + ≥1 metric
 * - Successful submit POSTs the right body shape and navigates to /runs/{id}
 * - "Create custom judge" CTA links to /admin/orchestration/agents/new?kind=judge
 * - Prefilled datasetId via useSearchParams().get('datasetId') is honoured
 *
 * @see components/admin/orchestration/evaluations-foundations/run-create-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
const mockBack = vi.fn();
const mockSearchParamsGet = vi.fn<(k: string) => string | null>(() => null);

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: mockBack,
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => ({ get: mockSearchParamsGet }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  RunCreateForm,
  type AgentOption,
  type DatasetOption,
  type HeuristicGraderOption,
  type JudgeAgentOption,
} from '@/components/admin/orchestration/evaluations-foundations/run-create-form';
import { API } from '@/lib/api/endpoints';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENTS: AgentOption[] = [
  { id: 'a-1', name: 'Bot Alpha', slug: 'bot-alpha' },
  { id: 'a-2', name: 'Bot Beta', slug: 'bot-beta' },
];

const DATASETS: DatasetOption[] = [
  { id: 'ds-1', name: 'FAQ', caseCount: 10 },
  { id: 'ds-2', name: 'Refunds', caseCount: 5 },
];

const HEURISTICS: HeuristicGraderOption[] = [
  {
    slug: 'exact_match',
    family: 'heuristic',
    description: 'Exact match check',
    referenceRequired: true,
    defaultConfig: { normalise: true },
  },
  {
    slug: 'regex',
    family: 'heuristic',
    description: 'Regex match',
    referenceRequired: false,
    defaultConfig: { pattern: '', flags: '' },
  },
  {
    slug: 'length_between',
    family: 'heuristic',
    description: 'Length check',
    referenceRequired: false,
    defaultConfig: { min: 0, max: 1000 },
  },
  {
    slug: 'tool_was_called',
    family: 'heuristic',
    description: 'Tool was called',
    referenceRequired: false,
    defaultConfig: { slug: '', min: 1 },
  },
  {
    slug: 'citation_count_at_least',
    family: 'heuristic',
    description: 'Min citations',
    referenceRequired: false,
    defaultConfig: { min: 1 },
  },
];

const JUDGES: JudgeAgentOption[] = [
  {
    id: 'j-1',
    slug: 'faithfulness-judge',
    name: 'Faithfulness',
    description: 'Built-in faithfulness scorer',
    isSystem: true,
    model: 'claude-opus-4-6',
    provider: 'anthropic',
  },
  {
    id: 'j-2',
    slug: 'policy-judge',
    name: 'Policy compliance',
    description: 'Custom domain judge',
    isSystem: false,
    model: 'gpt-4o',
    provider: 'openai',
  },
];

/**
 * The ConfigEditor's `<Label>` has no `htmlFor`, so `getByLabelText` does
 * not associate it with the sibling `<Input>`. This helper finds the
 * Input by sibling traversal off the matched label text.
 */
function getConfigInput(labelText: RegExp): HTMLInputElement {
  const label = screen.getByText(labelText);
  const wrapper = label.parentElement;
  if (!wrapper) throw new Error(`No wrapper for label matching ${String(labelText)}`);
  const input = wrapper.querySelector('input');
  if (!input) throw new Error(`No input next to label matching ${String(labelText)}`);
  return input;
}

function defaultProps(): {
  agents: AgentOption[];
  datasets: DatasetOption[];
  heuristicGraders: HeuristicGraderOption[];
  judgeAgents: JudgeAgentOption[];
} {
  return {
    agents: AGENTS,
    datasets: DATASETS,
    heuristicGraders: HEURISTICS,
    judgeAgents: JUDGES,
  };
}

function mockFetchSuccess(runId = 'run-99'): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { id: runId } }),
  } as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchServerError(message: string, status = 400): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ success: false, error: { code: 'BAD_REQUEST', message } }),
  } as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RunCreateForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParamsGet.mockReset();
    mockSearchParamsGet.mockImplementation(() => null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('rendering', () => {
    it('renders the heuristic graders subsection with each grader', () => {
      render(<RunCreateForm {...defaultProps()} />);
      // CardTitle renders as a div, not a heading element, so match on text.
      expect(screen.getByText(/Heuristic graders/i)).toBeInTheDocument();
      // Each grader slug is shown
      for (const g of HEURISTICS) {
        expect(screen.getByText(g.slug)).toBeInTheDocument();
      }
    });

    it('renders judge agents split into built-in and custom subsections', () => {
      render(<RunCreateForm {...defaultProps()} />);
      // The Built-in <h4> exists (and also a per-judge "built-in" badge — assert at least one).
      expect(screen.getAllByText(/Built-in/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/^Custom$/i)).toBeInTheDocument();
      expect(screen.getByText('Faithfulness')).toBeInTheDocument();
      expect(screen.getByText('Policy compliance')).toBeInTheDocument();
    });

    it('shows the "No custom judges yet" hint when there are no custom judges', () => {
      render(<RunCreateForm {...defaultProps()} judgeAgents={JUDGES.filter((j) => j.isSystem)} />);
      expect(screen.getByText(/No custom judges yet/i)).toBeInTheDocument();
    });

    it('renders the "Create custom judge" CTA linking to /agents/new?kind=judge', () => {
      render(<RunCreateForm {...defaultProps()} />);
      const cta = screen.getByRole('link', { name: /create custom judge/i });
      expect(cta).toHaveAttribute('href', '/admin/orchestration/agents/new?kind=judge');
    });

    it('hides the heuristic-graders card when no heuristics are provided', () => {
      render(<RunCreateForm {...defaultProps()} heuristicGraders={[]} />);
      // No "Heuristic graders" heading text when card is hidden
      expect(screen.queryByText(/^Heuristic graders/i)).not.toBeInTheDocument();
    });

    it('shows a "no agents" hint when the agents list is empty', () => {
      render(<RunCreateForm {...defaultProps()} agents={[]} />);
      expect(screen.getByText(/No agents available/i)).toBeInTheDocument();
    });

    it('shows a "no datasets" hint when the datasets list is empty', () => {
      render(<RunCreateForm {...defaultProps()} datasets={[]} />);
      expect(screen.getByText(/No datasets available/i)).toBeInTheDocument();
    });
  });

  describe('searchParams prefill', () => {
    it('honours useSearchParams().get("datasetId") for the default dataset', async () => {
      mockSearchParamsGet.mockImplementation((k) => (k === 'datasetId' ? 'ds-2' : null));
      mockFetchSuccess('run-1');
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);

      // Fill the rest of the form and submit so we can assert the dataset id in the body.
      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      // Pick exact_match to satisfy ≥1 metric
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      await user.click(screen.getByRole('button', { name: /queue run/i }));

      await waitFor(() => {
        expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      });
      const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        RequestInit,
      ];
      const body = JSON.parse(init.body as string);
      expect(body.datasetId).toBe('ds-2');
    });
  });

  describe('heuristic toggling', () => {
    it('ticking a heuristic seeds metricConfig with the grader defaultConfig on submit', async () => {
      const fetchMock = mockFetchSuccess('run-1');
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);

      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      await user.click(screen.getByRole('button', { name: /queue run/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.metricConfigs).toContainEqual({
        slug: 'exact_match',
        config: { normalise: true },
      });
    });

    it('un-ticking a heuristic removes it from metricConfigs', async () => {
      const fetchMock = mockFetchSuccess('run-1');
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);

      const exactCb = screen.getByRole('checkbox', { name: /exact_match/i });
      const regexCb = screen.getByRole('checkbox', { name: /regex/i });
      await user.click(exactCb);
      await user.click(regexCb);
      // Untick exact_match
      await user.click(exactCb);

      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      await user.click(screen.getByRole('button', { name: /queue run/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      const slugs = body.metricConfigs.map((m: { slug: string }) => m.slug);
      expect(slugs).toContain('regex');
      expect(slugs).not.toContain('exact_match');
    });

    it('renders the regex config editor when regex is ticked', async () => {
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.click(screen.getByRole('checkbox', { name: /regex/i }));
      expect(getConfigInput(/Pattern \(regex\)/i)).toBeInTheDocument();
      expect(getConfigInput(/^Flags$/i)).toBeInTheDocument();
    });

    it('renders the length_between config editor when length_between is ticked', async () => {
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.click(screen.getByRole('checkbox', { name: /length_between/i }));
      expect(getConfigInput(/Min chars/i)).toBeInTheDocument();
      expect(getConfigInput(/Max chars/i)).toBeInTheDocument();
    });

    it('renders the tool_was_called config editor when ticked', async () => {
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.click(screen.getByRole('checkbox', { name: /tool_was_called/i }));
      expect(getConfigInput(/Tool slug/i)).toBeInTheDocument();
      expect(getConfigInput(/Min invocations/i)).toBeInTheDocument();
    });

    it('renders the citation_count_at_least config editor when ticked', async () => {
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.click(screen.getByRole('checkbox', { name: /citation_count_at_least/i }));
      expect(getConfigInput(/Minimum citations/i)).toBeInTheDocument();
    });

    it('writes user edits back into the regex config and submits them', async () => {
      const fetchMock = mockFetchSuccess('run-1');
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);

      await user.click(screen.getByRole('checkbox', { name: /regex/i }));
      await user.type(getConfigInput(/Pattern \(regex\)/i), '\\d+');
      await user.type(getConfigInput(/^Flags$/i), 'i');

      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      await user.click(screen.getByRole('button', { name: /queue run/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      const regex = body.metricConfigs.find((m: { slug: string }) => m.slug === 'regex');
      expect(regex.config.pattern).toBe('\\d+');
      expect(regex.config.flags).toBe('i');
    });
  });

  describe('judge toggling', () => {
    it('ticking a judge adds { slug: "judge_agent", config: { agentSlug } }', async () => {
      const fetchMock = mockFetchSuccess('run-1');
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);

      await user.click(screen.getByRole('checkbox', { name: /faithfulness/i }));
      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      await user.click(screen.getByRole('button', { name: /queue run/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.metricConfigs).toContainEqual({
        slug: 'judge_agent',
        config: { agentSlug: 'faithfulness-judge' },
      });
    });

    it('un-ticking a judge removes it from metricConfigs', async () => {
      const fetchMock = mockFetchSuccess('run-1');
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);

      const judgeCb = screen.getByRole('checkbox', { name: /faithfulness/i });
      await user.click(judgeCb);
      // Add a second metric so submit passes
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      // Now untick the judge
      await user.click(judgeCb);

      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      await user.click(screen.getByRole('button', { name: /queue run/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      // No judge_agent metric should remain
      expect(body.metricConfigs.some((m: { slug: string }) => m.slug === 'judge_agent')).toBe(
        false
      );
    });
  });

  describe('submit validation', () => {
    it('shows "Give the run a name" when name is empty', async () => {
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      await user.click(screen.getByRole('button', { name: /queue run/i }));
      await waitFor(() => {
        expect(screen.getByText(/Give the run a name/i)).toBeInTheDocument();
      });
    });

    it('disables Queue run button while no metric is selected', () => {
      render(<RunCreateForm {...defaultProps()} />);
      expect(screen.getByRole('button', { name: /queue run/i })).toBeDisabled();
    });

    it('enables Queue run once a metric is selected', async () => {
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      expect(screen.getByRole('button', { name: /queue run/i })).not.toBeDisabled();
    });
  });

  describe('successful submit', () => {
    it('POSTs the run-create body to EVAL_RUNS and navigates to the new run', async () => {
      const fetchMock = mockFetchSuccess('run-77');
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);

      await user.type(document.querySelector('#name') as HTMLInputElement, 'Smoke run');
      await user.type(
        document.querySelector('#description') as HTMLTextAreaElement,
        'after refactor'
      );
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      await user.click(screen.getByRole('checkbox', { name: /faithfulness/i }));
      await user.click(screen.getByRole('button', { name: /queue run/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          API.ADMIN.ORCHESTRATION.EVAL_RUNS,
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          })
        );
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.name).toBe('Smoke run');
      expect(body.description).toBe('after refactor');
      expect(body.subjectKind).toBe('agent');
      expect(body.agentId).toBe('a-1'); // first agent is default
      expect(body.datasetId).toBe('ds-1'); // first dataset is default
      expect(Array.isArray(body.metricConfigs)).toBe(true);
      expect(body.metricConfigs.length).toBe(2);

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/evaluations/runs/run-77');
      });
    });

    it('omits a blank description from the body', async () => {
      const fetchMock = mockFetchSuccess('run-1');
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);

      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      await user.click(screen.getByRole('button', { name: /queue run/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.description).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('renders the server error message inline', async () => {
      mockFetchServerError('Dataset is empty', 400);
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      await user.click(screen.getByRole('button', { name: /queue run/i }));
      await waitFor(() => {
        expect(screen.getByText(/Dataset is empty/i)).toBeInTheDocument();
      });
      expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard
    });

    it('renders a fallback error when fetch itself rejects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.type(document.querySelector('#name') as HTMLInputElement, 'My Run');
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      await user.click(screen.getByRole('button', { name: /queue run/i }));
      await waitFor(() => {
        expect(screen.getByText(/Network down/i)).toBeInTheDocument();
      });
    });
  });

  describe('cancel', () => {
    it('calls router.back() when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<RunCreateForm {...defaultProps()} />);
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(mockBack).toHaveBeenCalledTimes(1);
    });
  });

  describe('summary footer', () => {
    it('reflects selected heuristic and judge counts', async () => {
      const user = userEvent.setup();
      const { container } = render(<RunCreateForm {...defaultProps()} />);
      await user.click(screen.getByRole('checkbox', { name: /exact_match/i }));
      await user.click(screen.getByRole('checkbox', { name: /regex/i }));
      await user.click(screen.getByRole('checkbox', { name: /faithfulness/i }));
      // The footer is the only <p> containing both "heuristic" and "judge agent".
      const paragraphs = Array.from(container.querySelectorAll('p'));
      const summary = paragraphs.find((p) => {
        const txt = p.textContent ?? '';
        return /heuristic/.test(txt) && /judge agent/.test(txt);
      });
      expect(summary).toBeDefined();
      const text = summary?.textContent ?? '';
      expect(text).toMatch(/2\s+heuristic/);
      expect(text).toMatch(/1\s+judge agent/);
    });
  });
});
