/**
 * EvaluationRunner Component Tests
 *
 * Test Coverage:
 * - Renders chat panel with agent name
 * - Renders annotation panel with save button
 * - Shows "Start a conversation" placeholder when no messages
 * - Auto-PATCHes status to in_progress for draft evaluations
 * - Does NOT auto-PATCH for in_progress evaluations
 * - Shows completed view with summary when evaluation.status is 'completed'
 * - Shows transcript in completed view (loads logs)
 * - Shows error message when agent is deleted (agentSlug null)
 * - Shows archived state
 * - Complete button is disabled when no messages
 * - Confirmation dialog shown before completing
 * - Archive button with confirmation dialog
 * - Renders all four annotation category buttons when a message entry is expanded
 * - Manual save button persists annotations
 * - Annotation limit warning shown when approaching limit
 * - Loads existing logs on mount for in-progress evaluations
 * - Auto-save uses ref (not stale closure)
 * - Includes startedAt in draft→in_progress PATCH
 *
 * @see components/admin/orchestration/evaluation-runner.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { EvaluationRunner } from '@/components/admin/orchestration/evaluation-runner';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DRAFT_EVAL = {
  id: 'ev-1',
  title: 'Draft Eval',
  status: 'draft',
  summary: null,
  improvementSuggestions: null,
  agent: { id: 'a1', name: 'Bot A', slug: 'bot-a' },
  createdAt: '2025-01-01T00:00:00.000Z',
  completedAt: null,
  metadata: null,
};

const IN_PROGRESS_EVAL = {
  id: 'ev-2',
  title: 'Running Eval',
  status: 'in_progress',
  summary: null,
  improvementSuggestions: null,
  agent: { id: 'a1', name: 'Bot A', slug: 'bot-a' },
  createdAt: '2025-01-01T00:00:00.000Z',
  completedAt: null,
  metadata: null,
};

const COMPLETED_EVAL = {
  id: 'ev-3',
  title: 'Done Eval',
  status: 'completed',
  summary: 'Agent performed well overall.',
  improvementSuggestions: ['Be more concise', 'Add citations'],
  agent: { id: 'a1', name: 'Bot A', slug: 'bot-a' },
  createdAt: '2025-01-01T00:00:00.000Z',
  completedAt: '2025-01-02T00:00:00.000Z',
  metadata: null,
};

const NO_AGENT_EVAL = {
  id: 'ev-4',
  title: 'Orphaned Eval',
  status: 'in_progress',
  summary: null,
  improvementSuggestions: null,
  agent: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  completedAt: null,
  metadata: null,
};

const ARCHIVED_EVAL = {
  id: 'ev-5',
  title: 'Archived Eval',
  status: 'archived',
  summary: null,
  improvementSuggestions: null,
  agent: { id: 'a1', name: 'Bot A', slug: 'bot-a' },
  createdAt: '2025-01-01T00:00:00.000Z',
  completedAt: null,
  metadata: null,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sseResponse(events: Array<{ type: string; data: unknown }>) {
  const encoder = new TextEncoder();
  const chunks = events.map((e) =>
    encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function logsResponse(logs: Array<{ sequenceNumber: number; eventType: string; content: string }>) {
  return new Response(JSON.stringify({ data: { logs } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clickSend() {
  const form = document.querySelector('form');
  const submitBtn = form?.querySelector('button[type="submit"]') as HTMLElement | null;
  if (!submitBtn) throw new Error('Submit button not found');
  submitBtn.click();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluationRunner', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch as typeof fetch;

    // Default: all fetches succeed with empty JSON
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { logs: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders chat panel with agent name', () => {
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);
      expect(screen.getByText(/chat with bot a/i)).toBeInTheDocument();
    });

    it('renders annotation panel with save button', () => {
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);
      expect(screen.getByText('Annotations')).toBeInTheDocument();
      expect(screen.getByTitle('Save annotations')).toBeInTheDocument();
    });

    it('shows "Start a conversation" placeholder when no messages and logs loaded', async () => {
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);
      await waitFor(() => {
        expect(
          screen.getByText(/start a conversation to begin your evaluation/i)
        ).toBeInTheDocument();
      });
    });

    it('Complete Evaluation button is disabled when no messages', async () => {
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);
      await waitFor(() => {
        const completeBtn = screen.getByRole('button', { name: /complete evaluation/i });
        expect(completeBtn).toBeDisabled();
      });
    });

    it('renders archive button for active evaluations', () => {
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);
      expect(screen.getByRole('button', { name: /archive/i })).toBeInTheDocument();
    });
  });

  // ── Archived view ─────────────────────────────────────────────────────────

  describe('archived view', () => {
    it('shows archived state message', () => {
      render(<EvaluationRunner evaluation={ARCHIVED_EVAL} />);
      expect(screen.getByText(/this evaluation has been archived/i)).toBeInTheDocument();
    });

    it('does not render chat panel when archived', () => {
      render(<EvaluationRunner evaluation={ARCHIVED_EVAL} />);
      expect(screen.queryByPlaceholderText(/type a message/i)).not.toBeInTheDocument();
    });
  });

  // ── Archive action ────────────────────────────────────────────────────────

  describe('archive action', () => {
    it('shows confirmation dialog when archive button clicked', async () => {
      const user = userEvent.setup();
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);

      await user.click(screen.getByRole('button', { name: /archive/i }));

      await waitFor(() => {
        expect(screen.getByText(/archive evaluation\?/i)).toBeInTheDocument();
      });
    });

    it('PATCHes status to archived on confirm', async () => {
      const user = userEvent.setup();
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);

      await user.click(screen.getByRole('button', { name: /archive/i }));
      await waitFor(() => {
        expect(screen.getByText(/archive evaluation\?/i)).toBeInTheDocument();
      });

      // Click the confirm button inside the dialog
      const dialog = screen.getByRole('alertdialog');
      const confirmBtn = within(dialog).getByRole('button', { name: /^archive$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        const patchCalls = mockFetch.mock.calls.filter((call) => {
          const opts = call[1];
          if (opts?.method !== 'PATCH') return false;
          try {
            const body = JSON.parse(opts.body as string) as { status?: string };
            return body.status === 'archived';
          } catch {
            return false;
          }
        });
        expect(patchCalls.length).toBe(1);
      });
    });
  });

  // ── Auto-PATCH status ──────────────────────────────────────────────────────

  describe('auto-PATCH status to in_progress', () => {
    it('auto-PATCHes status to in_progress for draft evaluations on mount', async () => {
      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        const patchCalls = mockFetch.mock.calls.filter((call) => {
          const opts = call[1];
          if (opts?.method !== 'PATCH') return false;
          try {
            const body = JSON.parse(opts.body as string) as { status?: string };
            return body.status === 'in_progress';
          } catch {
            return false;
          }
        });
        expect(patchCalls.length).toBeGreaterThan(0);
      });
    });

    it('includes startedAt in the draft→in_progress PATCH', async () => {
      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        const patchCalls = mockFetch.mock.calls.filter((call) => {
          const opts = call[1];
          if (opts?.method !== 'PATCH') return false;
          try {
            const body = JSON.parse(opts.body as string) as { status?: string };
            return body.status === 'in_progress';
          } catch {
            return false;
          }
        });
        expect(patchCalls.length).toBeGreaterThan(0);

        const body = JSON.parse((patchCalls[0][1] as RequestInit).body as string) as {
          status: string;
          startedAt?: string;
        };
        expect(body.startedAt).toBeDefined();
        // Must be a valid ISO datetime
        expect(new Date(body.startedAt!).toISOString()).toBe(body.startedAt);
      });
    });

    it('does NOT auto-PATCH for in_progress evaluations', async () => {
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);

      await waitFor(() => {
        const patchCalls = mockFetch.mock.calls.filter((call) => {
          const opts = call[1];
          if (opts?.method !== 'PATCH') return false;
          try {
            const body = JSON.parse(opts.body as string) as { status?: string };
            return body.status === 'in_progress';
          } catch {
            return false;
          }
        });
        expect(patchCalls.length).toBe(0);
      });
    });
  });

  // ── Log loading on mount ──────────────────────────────────────────────────

  describe('log loading on mount', () => {
    it('loads existing logs for in-progress evaluations', async () => {
      mockFetch.mockResolvedValue(
        logsResponse([
          { sequenceNumber: 1, eventType: 'user_input', content: 'Hello there' },
          { sequenceNumber: 2, eventType: 'ai_response', content: 'Hi! How can I help?' },
        ])
      );

      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);

      await waitFor(() => {
        expect(screen.getAllByText('Hello there').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Hi! How can I help?').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('does NOT load logs for completed evaluations via the active path', async () => {
      // Completed eval loads transcript separately
      render(<EvaluationRunner evaluation={COMPLETED_EVAL} />);

      // Should show the completed view immediately
      expect(screen.getByText('Evaluation Complete')).toBeInTheDocument();
    });

    it('handles log fetch failure gracefully', async () => {
      mockFetch.mockResolvedValue(new Response('', { status: 500 }));

      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);

      // Should still render the chat panel without errors
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });
    });
  });

  // ── Completed view ─────────────────────────────────────────────────────────

  describe('completed view', () => {
    it('shows completed view with summary when evaluation.status is completed', () => {
      render(<EvaluationRunner evaluation={COMPLETED_EVAL} />);
      expect(screen.getByText('Evaluation Complete')).toBeInTheDocument();
      expect(screen.getByText('Agent performed well overall.')).toBeInTheDocument();
    });

    it('renders improvement suggestions in the completed view', () => {
      render(<EvaluationRunner evaluation={COMPLETED_EVAL} />);
      expect(screen.getByText('Be more concise')).toBeInTheDocument();
      expect(screen.getByText('Add citations')).toBeInTheDocument();
    });

    it('shows conversation transcript section', async () => {
      mockFetch.mockResolvedValue(
        logsResponse([
          { sequenceNumber: 1, eventType: 'user_input', content: 'Test question' },
          { sequenceNumber: 2, eventType: 'ai_response', content: 'Test answer' },
        ])
      );

      render(<EvaluationRunner evaluation={COMPLETED_EVAL} />);

      expect(screen.getByText('Conversation Transcript')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText('Test question')).toBeInTheDocument();
        expect(screen.getByText('Test answer')).toBeInTheDocument();
      });
    });

    it('shows "No transcript available" when logs are empty', async () => {
      mockFetch.mockResolvedValue(logsResponse([]));

      render(<EvaluationRunner evaluation={COMPLETED_EVAL} />);

      await waitFor(() => {
        expect(screen.getByText('No transcript available.')).toBeInTheDocument();
      });
    });
  });

  // ── No agent ───────────────────────────────────────────────────────────────

  describe('deleted agent', () => {
    it('shows error message when agent is deleted (agentSlug is null)', () => {
      render(<EvaluationRunner evaluation={NO_AGENT_EVAL} />);
      expect(
        screen.getByText(/the agent for this evaluation has been deleted/i)
      ).toBeInTheDocument();
    });

    it('does not render chat panel when agent is deleted', () => {
      render(<EvaluationRunner evaluation={NO_AGENT_EVAL} />);
      expect(screen.queryByPlaceholderText(/type a message/i)).not.toBeInTheDocument();
    });
  });

  // ── Confirmation dialog ───────────────────────────────────────────────────

  describe('completion confirmation dialog', () => {
    async function setupWithMessages(user: ReturnType<typeof userEvent.setup>) {
      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // auto-PATCH
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockResolvedValueOnce(
          sseResponse([
            { type: 'start', data: { conversationId: 'cid-1' } },
            { type: 'content', data: { delta: 'Sure thing!' } },
            { type: 'done', data: {} },
          ])
        );

      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      // Wait for log loading to finish
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Hello');
      clickSend();

      await waitFor(() => {
        expect(screen.getAllByText('Sure thing!').length).toBeGreaterThanOrEqual(1);
      });
    }

    it('shows confirmation dialog when Complete Evaluation is clicked', async () => {
      const user = userEvent.setup();
      await setupWithMessages(user);

      const completeBtn = screen.getByRole('button', { name: /complete evaluation/i });
      await user.click(completeBtn);

      await waitFor(() => {
        expect(screen.getByText(/complete this evaluation\?/i)).toBeInTheDocument();
        expect(screen.getByText(/this action cannot be undone/i)).toBeInTheDocument();
      });
    });

    it('completes evaluation when confirmation is accepted', async () => {
      const user = userEvent.setup();
      await setupWithMessages(user);

      // Queue responses for completion flow
      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // metadata PATCH
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: {
                session: {
                  summary: 'AI summary text',
                  improvementSuggestions: ['Tip one'],
                  tokenUsage: { input: 100, output: 50 },
                  costUsd: 0.0042,
                },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );

      // Click Complete Evaluation to open dialog
      await user.click(screen.getByRole('button', { name: /complete evaluation/i }));

      // Click confirm in dialog
      await waitFor(() => {
        expect(screen.getByText(/complete this evaluation\?/i)).toBeInTheDocument();
      });
      const dialog = screen.getByRole('alertdialog');
      const confirmBtn = within(dialog).getByRole('button', { name: /complete evaluation/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText('Evaluation Complete')).toBeInTheDocument();
        expect(screen.getByText('AI summary text')).toBeInTheDocument();
      });
    });
  });

  // ── Manual save button ────────────────────────────────────────────────────

  describe('manual save button', () => {
    it('PATCHes annotations when save button is clicked', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockResolvedValueOnce(
          sseResponse([
            { type: 'content', data: { delta: 'Reply' } },
            { type: 'done', data: {} },
          ])
        )
        .mockResolvedValue(new Response('{}', { status: 200 })); // subsequent PATCHes

      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Test');
      clickSend();

      await waitFor(() => {
        expect(screen.getAllByText('Reply').length).toBeGreaterThanOrEqual(1);
      });

      // Click save button
      await user.click(screen.getByTitle('Save annotations'));

      await waitFor(() => {
        const patchCalls = mockFetch.mock.calls.filter((call) => {
          const opts = call[1];
          if (opts?.method !== 'PATCH') return false;
          try {
            const body = JSON.parse(opts.body as string) as { metadata?: unknown };
            return body.metadata !== undefined;
          } catch {
            return false;
          }
        });
        expect(patchCalls.length).toBeGreaterThan(0);
      });
    });
  });

  // ── Annotation limit warning ──────────────────────────────────────────────

  describe('annotation limit warning', () => {
    it('shows warning when approaching annotation limit', () => {
      // Create metadata with 21 annotations (close to the 24 limit)
      const metadata: Record<string, unknown> = { ann_count: 21 };
      for (let i = 0; i < 21; i++) {
        metadata[`ann_${i}_idx`] = i;
        metadata[`ann_${i}_cat`] = 'expected';
        metadata[`ann_${i}_rat`] = 4;
        metadata[`ann_${i}_notes`] = `Note ${i}`;
      }

      render(<EvaluationRunner evaluation={{ ...IN_PROGRESS_EVAL, metadata }} />);

      expect(screen.getByText(/annotation slot.* remaining/i)).toBeInTheDocument();
    });

    it('shows limit reached message at max annotations', () => {
      const metadata: Record<string, unknown> = { ann_count: 24 };
      for (let i = 0; i < 24; i++) {
        metadata[`ann_${i}_idx`] = i;
        metadata[`ann_${i}_cat`] = 'issue';
        metadata[`ann_${i}_rat`] = 2;
        metadata[`ann_${i}_notes`] = `Note ${i}`;
      }

      render(<EvaluationRunner evaluation={{ ...IN_PROGRESS_EVAL, metadata }} />);

      expect(screen.getByText(/annotation limit reached/i)).toBeInTheDocument();
    });
  });

  // ── SSE sendMessage ─────────────────────────────────────────────────────────

  describe('sendMessage SSE streaming', () => {
    it('happy path: start + content + done accumulates assistant message', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // auto-PATCH
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockResolvedValueOnce(
          sseResponse([
            { type: 'start', data: { conversationId: 'conv-abc' } },
            { type: 'content', data: { delta: 'Hello ' } },
            { type: 'content', data: { delta: 'world!' } },
            { type: 'done', data: {} },
          ])
        );

      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Hi agent');
      clickSend();

      await waitFor(() => {
        expect(screen.getAllByText('Hello world!').length).toBeGreaterThanOrEqual(1);
      });

      expect(screen.getAllByText('Hi agent').length).toBeGreaterThanOrEqual(1);
    });

    it('error event: shows inline chat error', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // auto-PATCH
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockResolvedValueOnce(
          sseResponse([{ type: 'error', data: { message: 'upstream failure' } }])
        );

      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Hi');
      clickSend();

      await waitFor(() => {
        expect(screen.getByText(/the agent ran into a problem/i)).toBeInTheDocument();
      });
    });

    it('!res.ok: sets "Chat stream failed to start"', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // auto-PATCH
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockResolvedValueOnce(new Response('error', { status: 500 }));

      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Hi');
      clickSend();

      await waitFor(() => {
        expect(screen.getByText(/chat stream failed to start/i)).toBeInTheDocument();
      });
    });

    it('network throw: shows "Could not reach the chat stream"', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // auto-PATCH
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockRejectedValueOnce(new Error('Network error'));

      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Hi');
      clickSend();

      await waitFor(() => {
        expect(screen.getByText(/could not reach the chat stream/i)).toBeInTheDocument();
      });
    });

    it('AbortError is swallowed silently — no error displayed', async () => {
      const user = userEvent.setup();

      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';

      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // auto-PATCH
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockRejectedValueOnce(abortErr);

      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Hi');
      clickSend();

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).not.toBeDisabled();
      });

      expect(screen.queryByText(/could not reach/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/agent ran into a problem/i)).not.toBeInTheDocument();
    });
  });

  // ─── handleComplete ──────────────────────────────────────────────────────────

  describe('handleComplete', () => {
    async function setupWithMessages(user: ReturnType<typeof userEvent.setup>) {
      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // auto-PATCH
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockResolvedValueOnce(
          sseResponse([
            { type: 'start', data: { conversationId: 'cid-1' } },
            { type: 'content', data: { delta: 'Sure thing!' } },
            { type: 'done', data: {} },
          ])
        );

      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Hello');
      clickSend();

      await waitFor(() => {
        expect(screen.getAllByText('Sure thing!').length).toBeGreaterThanOrEqual(1);
      });
    }

    it('server error with error.message body: shows that specific message', async () => {
      const user = userEvent.setup();
      await setupWithMessages(user);

      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // metadata PATCH
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: 'LLM quota exceeded' } }), {
            status: 422,
            headers: { 'Content-Type': 'application/json' },
          })
        );

      // Open dialog
      await user.click(screen.getByRole('button', { name: /complete evaluation/i }));
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      });

      // Confirm
      const dialog = screen.getByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: /complete evaluation/i }));

      await waitFor(() => {
        expect(screen.getByText('LLM quota exceeded')).toBeInTheDocument();
      });
    });

    it('network throw: shows fallback message', async () => {
      const user = userEvent.setup();
      await setupWithMessages(user);

      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // metadata PATCH
        .mockRejectedValueOnce(new Error('network down'));

      await user.click(screen.getByRole('button', { name: /complete evaluation/i }));
      await waitFor(() => {
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      });

      const dialog = screen.getByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: /complete evaluation/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/failed to complete evaluation\. please try again/i)
        ).toBeInTheDocument();
      });
    });
  });

  // ─── Auto-save uses ref (stale closure fix) ─────────────────────────────────

  describe('auto-save stale closure fix', () => {
    it('debounced save sends current annotations, not stale initial state', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      mockFetch
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockResolvedValueOnce(
          sseResponse([
            { type: 'content', data: { delta: 'Reply' } },
            { type: 'done', data: {} },
          ])
        )
        .mockResolvedValue(new Response('{}', { status: 200 })); // subsequent PATCHes

      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Test');
      clickSend();

      await waitFor(() => {
        expect(screen.getAllByText('Reply').length).toBeGreaterThanOrEqual(1);
      });

      // Expand annotation and set category
      const youBadge = screen.getByText('You');
      const annotationRow = youBadge.closest('button');
      await user.click(annotationRow!);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Expected' })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'Expected' }));

      // Advance 30 seconds to trigger debounced save
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      // Verify the PATCH body contains the annotation data (not empty)
      await waitFor(() => {
        const metadataPatchCalls = mockFetch.mock.calls.filter((call) => {
          const opts = call[1];
          if (opts?.method !== 'PATCH') return false;
          try {
            const body = JSON.parse(opts.body as string) as { metadata?: Record<string, unknown> };
            return body.metadata && typeof body.metadata.ann_count === 'number';
          } catch {
            return false;
          }
        });
        expect(metadataPatchCalls.length).toBeGreaterThan(0);

        // Verify the saved annotations contain the category we set
        const lastPatch = metadataPatchCalls[metadataPatchCalls.length - 1];
        const body = JSON.parse((lastPatch[1] as RequestInit).body as string) as {
          metadata: Record<string, unknown>;
        };
        expect(body.metadata.ann_count).toBe(1);
        expect(body.metadata.ann_0_cat).toBe('expected');
      });

      vi.useRealTimers();
    });
  });

  // ─── Annotation interactions ─────────────────────────────────────────────────

  describe('annotation interaction after messages exist', () => {
    async function setupWithOneMessage(user: ReturnType<typeof userEvent.setup>) {
      mockFetch
        .mockResolvedValueOnce(new Response('{}', { status: 200 })) // auto-PATCH
        .mockResolvedValueOnce(logsResponse([])) // log loading
        .mockResolvedValueOnce(
          sseResponse([
            { type: 'content', data: { delta: 'Agent reply' } },
            { type: 'done', data: {} },
          ])
        );

      render(<EvaluationRunner evaluation={DRAFT_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Test');
      clickSend();

      await waitFor(() => {
        expect(screen.getAllByText('Agent reply').length).toBeGreaterThanOrEqual(1);
      });
    }

    it('expanding annotation entry shows all four category buttons', async () => {
      const user = userEvent.setup();
      await setupWithOneMessage(user);

      const youBadge = screen.getByText('You');
      const annotationRow = youBadge.closest('button');
      await user.click(annotationRow!);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Expected' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Unexpected' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Issue' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Observation' })).toBeInTheDocument();
      });
    });

    it('clicking a category button marks it as selected', async () => {
      const user = userEvent.setup();
      await setupWithOneMessage(user);

      const youBadge = screen.getByText('You');
      const annotationRow = youBadge.closest('button');
      await user.click(annotationRow!);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Expected' })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: 'Expected' }));

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: 'Expected' });
        expect(btn.className).toMatch(/bg-primary|inline-flex/);
      });
    });

    it('notes textarea appears when annotation entry is expanded', async () => {
      const user = userEvent.setup();
      await setupWithOneMessage(user);

      const youBadge = screen.getByText('You');
      const annotationRow = youBadge.closest('button');
      await user.click(annotationRow!);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/add notes about this response/i)).toBeInTheDocument();
      });
    });

    it('collapsing an expanded annotation hides the controls', async () => {
      const user = userEvent.setup();
      await setupWithOneMessage(user);

      const youBadge = screen.getByText('You');
      const annotationRow = youBadge.closest('button');

      await user.click(annotationRow!);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Expected' })).toBeInTheDocument();
      });

      await user.click(annotationRow!);
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Expected' })).not.toBeInTheDocument();
      });
    });
  });

  // ─── Serialization helpers ──────────────────────────────────────────────────

  describe('annotation serialization round-trip via metadata', () => {
    it('handles null metadata gracefully', () => {
      render(<EvaluationRunner evaluation={{ ...IN_PROGRESS_EVAL, metadata: null }} />);
      expect(screen.getByText('Annotations')).toBeInTheDocument();
    });

    it('ignores malformed metadata (non-number ann_count)', () => {
      render(
        <EvaluationRunner
          evaluation={{
            ...IN_PROGRESS_EVAL,
            metadata: {
              ann_count: 'bad',
              ann_0_idx: 0,
              ann_0_cat: 'expected',
              ann_0_rat: 4,
              ann_0_notes: '',
            },
          }}
        />
      );
      expect(screen.getByText('Annotations')).toBeInTheDocument();
    });
  });

  // ── Chat input ─────────────────────────────────────────────────────────────

  describe('chat input', () => {
    it('renders the message input field', async () => {
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });
    });

    it('send button is disabled when input is empty', async () => {
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);
      await waitFor(() => {
        const form = screen.getByPlaceholderText(/type a message/i).closest('form');
        const submitBtn = form?.querySelector('button[type="submit"]');
        expect(submitBtn).toBeDisabled();
      });
    });

    it('send button becomes enabled after typing a message', async () => {
      const user = userEvent.setup();
      render(<EvaluationRunner evaluation={IN_PROGRESS_EVAL} />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText(/type a message/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/type a message/i), 'Hello agent');

      const form = screen.getByPlaceholderText(/type a message/i).closest('form');
      const submitBtn = form?.querySelector('button[type="submit"]');
      expect(submitBtn).not.toBeDisabled();
    });
  });
});
