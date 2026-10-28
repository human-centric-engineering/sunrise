// @vitest-environment happy-dom

/**
 * EditableSection Component Tests
 *
 * Test Coverage:
 * - View mode: renders <pre> with section.body; pencil button present in DOM (hidden via CSS)
 * - Click pencil → acquireLock called; on false return, stays in view mode (no textarea)
 * - Click pencil → acquireLock returns true → enters edit mode (textarea, Save/Cancel/Refine buttons)
 * - Save POSTs /cleanup/section with { sectionId, content, expectedFingerprint } using real sha256Hex
 * - 423 response → error banner matching /another admin is editing/i; stays in edit mode
 * - 409 response → conflict panel with Keep mine / Take theirs; clicking Take theirs replaces draft
 * - Save success → exits edit mode; onSaved callback fires
 * - Cancel exits edit mode without firing fetch
 * - Refine button reveals instructions input + Refine/Cancel; Refine POSTs /cleanup/section/refine
 * - Refine success → onPendingChange called with returned id; prompt closed
 * - Live diff strip shows +N chars when text is added to the textarea
 *
 * Mocking: globalThis.fetch per test; acquireLock is a prop (vi.fn()).
 * sha256Hex is NOT mocked — we use the real implementation for end-to-end fingerprint integrity.
 *
 * @see components/admin/orchestration/knowledge/editable-section.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EditableSection } from '@/components/admin/orchestration/knowledge/editable-section';
import { sha256Hex } from '@/lib/orchestration/knowledge/cleanup-client';
import type { Section } from '@/lib/orchestration/knowledge/section-detection';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DOC_ID = 'doc-abc-123';
const SECTION_MARKER = '## Introduction';
// Sections are addressed by id — markers repeat within a document.
const SECTION_ID = 'section-id-001';
const SECTION_BODY = 'This is the introduction section body.';

function makeSection(overrides?: Partial<Section>): Section {
  return {
    id: SECTION_ID,
    marker: SECTION_MARKER,
    body: SECTION_BODY,
    startOffset: 0,
    endOffset: SECTION_BODY.length,
    ...overrides,
  };
}

const BASE_PROPS = {
  documentId: DOC_ID,
  section: makeSection(),
  // Generous default so the existing tests don't trip the over-budget gate.
  contextWindow: 200_000,
  acquireLock: vi.fn().mockResolvedValue(true),
  onSaved: vi.fn(),
  onPendingChange: vi.fn(),
};

// ─── Fetch helpers ────────────────────────────────────────────────────────────

function makeSectionUrl(docId: string) {
  return `/api/v1/admin/orchestration/knowledge/documents/${docId}/cleanup/section`;
}

function makeRefineUrl(docId: string) {
  return `${makeSectionUrl(docId)}/refine`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditableSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // happy-dom has no scrollIntoView; <SaveError> calls it when it appears.
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: {} }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── View mode ─────────────────────────────────────────────────────────────────

  it('renders a <pre> with section.body in view mode', () => {
    render(<EditableSection {...BASE_PROPS} />);

    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(SECTION_BODY);
  });

  it('pencil button is present in the DOM (hidden via CSS but queryable by aria-label)', () => {
    render(<EditableSection {...BASE_PROPS} />);

    // The button is in DOM but hidden via CSS (opacity-0 + group-hover classes)
    const pencilButton = document.querySelector(`[aria-label="Edit section ${SECTION_MARKER}"]`);
    expect(pencilButton).not.toBeNull();
  });

  it('clicking pencil calls acquireLock', async () => {
    const acquireLock = vi.fn().mockResolvedValue(true);
    render(<EditableSection {...BASE_PROPS} acquireLock={acquireLock} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(acquireLock).toHaveBeenCalledTimes(1);
    });
  });

  it('stays in view mode (no textarea) when acquireLock returns false', async () => {
    const acquireLock = vi.fn().mockResolvedValue(false);
    render(<EditableSection {...BASE_PROPS} acquireLock={acquireLock} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(acquireLock).toHaveBeenCalled();
    });

    // No textarea should appear — still in view mode
    expect(document.querySelector('textarea')).toBeNull();
  });

  // ── Edit mode ─────────────────────────────────────────────────────────────────

  it('enters edit mode with textarea and action buttons when acquireLock returns true', async () => {
    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refine with agent/i })).toBeInTheDocument();
  });

  // ── Save: fingerprint integrity ───────────────────────────────────────────────

  it('Save POSTs with expectedFingerprint = sha256Hex(section.body) — fingerprint contract is end-to-end verifiable', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    globalThis.fetch = fetchMock;

    render(<EditableSection {...BASE_PROPS} />);

    // Enter edit mode
    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    // Click Save
    const saveButton = screen.getByRole('button', { name: /Save/i });
    fireEvent.click(saveButton);

    // Compute the expected fingerprint using the REAL sha256Hex (not a mock)
    const expectedFingerprint = await sha256Hex(SECTION_BODY);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        makeSectionUrl(DOC_ID),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sectionId: SECTION_ID,
            content: SECTION_BODY,
            expectedFingerprint,
          }),
        })
      );
    });
  });

  it('Save fingerprints the body the editor OPENED against, not the prop as it stands at save time', async () => {
    // Arrange: section.body is derived from the parent's processedContent,
    // which refetches on every chat turn and capability result. If the
    // fingerprint were computed at save time it would match whatever the
    // agent just wrote, the server's 409 CONTENT_MISMATCH guard would never
    // fire, and the agent's change would be silently overwritten.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    globalThis.fetch = fetchMock;

    const { rerender } = render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    // A capability mutated this section while the editor was open.
    const AGENT_BODY = 'The agent rewrote this section underneath the editor.';
    rerender(<EditableSection {...BASE_PROPS} section={makeSection({ body: AGENT_BODY })} />);

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    const openedAgainstFingerprint = await sha256Hex(SECTION_BODY);
    const agentBodyFingerprint = await sha256Hex(AGENT_BODY);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as {
      expectedFingerprint: string;
    };
    expect(sentBody.expectedFingerprint).toBe(openedAgainstFingerprint);
    expect(sentBody.expectedFingerprint).not.toBe(agentBodyFingerprint);
  });

  // ── Save: 423 lock-held response ──────────────────────────────────────────────

  it('423 response shows error banner matching /another admin is editing/i; stays in edit mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 423,
      json: () => Promise.resolve({ success: false, error: { code: 'LOCK_HELD' } }),
    });
    globalThis.fetch = fetchMock;

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    // The save error, directly above the row holding Save, focused.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Another admin is editing/i);
    expect(alert.parentElement?.nextElementSibling).toContainElement(
      screen.getByRole('button', { name: /^Save$/i })
    );
    expect(alert).toHaveFocus();

    // Should still be in edit mode (textarea present)
    expect(document.querySelector('textarea')).not.toBeNull();
  });

  // ── Save: 409 conflict response ───────────────────────────────────────────────

  it('409 response renders conflict panel with Keep mine / Take theirs buttons', async () => {
    const serverBody = 'Server version of the content';
    const serverFingerprint = 'abc123fingerprint';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          success: false,
          error: {
            code: 'CONTENT_MISMATCH',
            details: {
              currentBody: [serverBody],
              currentFingerprint: [serverFingerprint],
            },
          },
        }),
    });

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Keep mine/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Take theirs/i })).toBeInTheDocument();
    });
  });

  it('clicking Take theirs replaces the textarea content with currentBody from response', async () => {
    const serverBody = 'Server version replaces draft';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          success: false,
          error: {
            code: 'CONTENT_MISMATCH',
            details: {
              currentBody: [serverBody],
              currentFingerprint: ['fp-xyz'],
            },
          },
        }),
    });

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Take theirs/i })).toBeInTheDocument();
    });

    // Click Take theirs
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Take theirs/i }));

    // Textarea content should now be the server body
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe(serverBody);

    // Conflict panel should be gone
    expect(screen.queryByRole('button', { name: /Keep mine/i })).not.toBeInTheDocument();
  });

  // ── Save: success ─────────────────────────────────────────────────────────────

  it('save success exits edit mode and calls onSaved callback', async () => {
    const onSaved = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });

    render(<EditableSection {...BASE_PROPS} onSaved={onSaved} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      // Textarea gone — back to view mode
      expect(document.querySelector('textarea')).toBeNull();
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  // ── Cancel ────────────────────────────────────────────────────────────────────

  it('Cancel exits edit mode without firing any fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));

    // Back to view mode
    expect(document.querySelector('textarea')).toBeNull();

    // No fetch should have been called (fetch was not set up to resolve, would hang if called)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Refine with agent ─────────────────────────────────────────────────────────

  it('Refine button reveals instructions input + Refine/Cancel buttons', async () => {
    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refine with agent/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refine with agent/i }));

    // Instructions input should appear
    expect(screen.getByPlaceholderText(/shorten to one paragraph/i)).toBeInTheDocument();

    // Refine and Cancel buttons within the prompt panel
    const refineButtons = screen.getAllByRole('button', { name: /^Refine$/i });
    expect(refineButtons.length).toBeGreaterThan(0);
  });

  it('Refine POSTs /cleanup/section/refine with { sectionId, instructions }', async () => {
    const instructions = 'Make it shorter and clearer';
    const pendingChangeId = 'change-abc-789';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: { pendingChangeId } }),
    });
    globalThis.fetch = fetchMock;

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refine with agent/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refine with agent/i }));

    const instructionsInput = screen.getByPlaceholderText(/shorten to one paragraph/i);
    await user.type(instructionsInput, instructions);

    // Click the Refine button (inside the prompt panel)
    const refineButtons = screen.getAllByRole('button', { name: /^Refine$/i });
    await user.click(refineButtons[refineButtons.length - 1]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        makeRefineUrl(DOC_ID),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            sectionId: SECTION_ID,
            instructions,
          }),
        })
      );
    });
  });

  it('Refine success calls onPendingChange with the returned pendingChangeId', async () => {
    const onPendingChange = vi.fn();
    const pendingChangeId = 'change-xyz-999';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: { pendingChangeId } }),
    });

    render(<EditableSection {...BASE_PROPS} onPendingChange={onPendingChange} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refine with agent/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refine with agent/i }));

    const instructionsInput = screen.getByPlaceholderText(/shorten to one paragraph/i);
    await user.type(instructionsInput, 'Shorten it');

    const refineButtons = screen.getAllByRole('button', { name: /^Refine$/i });
    await user.click(refineButtons[refineButtons.length - 1]);

    await waitFor(() => {
      expect(onPendingChange).toHaveBeenCalledWith(pendingChangeId);
    });
  });

  // ── Save: non-ok with no error.message ───────────────────────────────────────

  it('shows the fallback when save returns 500 with no error envelope in the body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ success: false }),
    });

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save the section. Try again.');
    });
  });

  // ── Save: non-Error thrown by fetch ──────────────────────────────────────────

  it('shows the fallback when fetch rejects with a non-Error value', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue('plain string — not an Error');

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save the section. Try again.');
    });
  });

  // ── Refine: non-Error thrown by fetch ────────────────────────────────────────

  it('shows "Refine failed" when refine fetch rejects with a non-Error value', async () => {
    // Exercises the `err instanceof Error ? err.message : 'Refine failed'` branch in refineWithAgent.
    globalThis.fetch = vi.fn().mockRejectedValue('boom — not an Error object');

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refine with agent/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refine with agent/i }));

    const instructionsInput = screen.getByPlaceholderText(/shorten to one paragraph/i);
    await user.type(instructionsInput, 'Clean it up');

    const refineButtons = screen.getAllByRole('button', { name: /^Refine$/i });
    await user.click(refineButtons[refineButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText('Refine failed')).toBeInTheDocument();
    });
  });

  // ── Refine: response missing pendingChangeId ──────────────────────────────────

  it('does NOT call onPendingChange when refine response has no data.pendingChangeId', async () => {
    // Exercises the `if (body.data?.pendingChangeId)` guard at L157.
    // When the response has no pendingChangeId, onPendingChange must not fire.
    const onPendingChange = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: {} }), // no pendingChangeId
    });

    render(<EditableSection {...BASE_PROPS} onPendingChange={onPendingChange} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refine with agent/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refine with agent/i }));

    const instructionsInput = screen.getByPlaceholderText(/shorten to one paragraph/i);
    await user.type(instructionsInput, 'Shorten it');

    const refineButtons = screen.getAllByRole('button', { name: /^Refine$/i });
    await user.click(refineButtons[refineButtons.length - 1]);

    await waitFor(() => {
      // Prompt should close on success (refinePromptOpen → false)
      expect(screen.queryByPlaceholderText(/shorten to one paragraph/i)).not.toBeInTheDocument();
    });

    // onPendingChange must NOT have been called because there was no pendingChangeId
    expect(onPendingChange).not.toHaveBeenCalled();
  });

  // ── keepMine: re-saves with server fingerprint ───────────────────────────────

  it('Keep mine re-saves the draft using the server fingerprint from the conflict', async () => {
    const serverFingerprint = 'server-fp-abc123';
    // First fetch returns 409 with a conflict
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () =>
          Promise.resolve({
            success: false,
            error: {
              code: 'CONTENT_MISMATCH',
              details: {
                currentBody: ['server body'],
                currentFingerprint: [serverFingerprint],
              },
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });
    globalThis.fetch = fetchMock;

    const onSaved = vi.fn();
    render(<EditableSection {...BASE_PROPS} onSaved={onSaved} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    // Trigger first save → 409 conflict
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Keep mine/i })).toBeInTheDocument();
    });

    // Click Keep mine → should re-save using the server fingerprint
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Keep mine/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // The second fetch must use the server's fingerprint (overrideFingerprint)
    const secondCall = fetchMock.mock.calls[1];
    const secondBody = JSON.parse(secondCall[1].body as string) as {
      expectedFingerprint: string;
    };
    expect(secondBody.expectedFingerprint).toBe(serverFingerprint);

    // After the second save succeeds, component exits edit mode and fires onSaved
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  });

  // ── Refine: non-ok with error.message in the body ─────────────────────────────

  it('shows the server error message when refine returns non-ok with error.message in the body', async () => {
    // Exercises the `body?.error?.message ?? \`Refine failed (${res.status})\`` path at L154
    // where the body DOES have an error.message.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: () =>
        Promise.resolve({
          success: false,
          error: { message: 'Instructions too vague' },
        }),
    });

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refine with agent/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Refine with agent/i }));

    const instructionsInput = screen.getByPlaceholderText(/shorten to one paragraph/i);
    await user.type(instructionsInput, 'Clean it');

    const refineButtons = screen.getAllByRole('button', { name: /^Refine$/i });
    await user.click(refineButtons[refineButtons.length - 1]);

    await waitFor(() => {
      expect(screen.getByText('Instructions too vague')).toBeInTheDocument();
    });
  });

  // ── Refine prompt Cancel button ───────────────────────────────────────────────

  it('clicking Cancel inside the refine prompt panel closes the prompt without calling fetch', async () => {
    // Exercises the onClick={() => setRefinePromptOpen(false)} handler at L253.
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Refine with agent/i })).toBeInTheDocument();
    });

    const user = userEvent.setup();
    // Open the refine prompt
    await user.click(screen.getByRole('button', { name: /Refine with agent/i }));

    // The instructions input should be visible
    expect(screen.getByPlaceholderText(/shorten to one paragraph/i)).toBeInTheDocument();

    // The refine panel renders: [instructions input] [Refine button] [Cancel button]
    // The edit footer renders: [Refine with agent (disabled)] [Cancel] [Save]
    // DOM order: panel Cancel comes BEFORE footer Cancel.
    // We identify the panel's Cancel button as the FIRST Cancel button in the DOM.
    const cancelButtons = screen.getAllByRole('button', { name: /^Cancel$/i });
    // First Cancel is the refine-prompt Cancel (panel is rendered before the footer row).
    await user.click(cancelButtons[0]);

    // The instructions input should no longer be visible — refine prompt closed.
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/shorten to one paragraph/i)).not.toBeInTheDocument();
    });

    // No fetch should have been called (Refine was never submitted)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Live diff strip ───────────────────────────────────────────────────────────

  it('live diff strip shows +N chars when text is typed into the textarea', async () => {
    render(<EditableSection {...BASE_PROPS} />);

    const pencilButton = document.querySelector(
      `[aria-label="Edit section ${SECTION_MARKER}"]`
    ) as HTMLElement;
    fireEvent.click(pencilButton);

    await waitFor(() => {
      expect(document.querySelector('textarea')).not.toBeNull();
    });

    const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
    const addedText = ' extra added text here';
    const expectedDelta = addedText.length;

    // Use fireEvent.change to set the new value directly (avoids userEvent brace escaping)
    fireEvent.change(textarea, { target: { value: SECTION_BODY + addedText } });

    // The action bar should show the positive char delta
    await waitFor(() => {
      expect(
        screen.getByText(new RegExp(`\\+${expectedDelta.toLocaleString()}\\s*chars`, 'i'))
      ).toBeInTheDocument();
    });
  });

  // ── Size badge & refine gating ────────────────────────────────────────────────

  describe('size-vs-context-window signalling', () => {
    it('does not render the size badge in view mode when well under 80% of the context window', () => {
      // SECTION_BODY = ~38 chars → ~10 tokens. With contextWindow=200k, the
      // ratio is far below the 80% soft-warning threshold.
      render(<EditableSection {...BASE_PROPS} />);
      expect(screen.queryByText(/tok\b/i)).toBeNull();
    });

    it('renders an amber size badge in view mode when the section is in the 80–100% band', () => {
      // 4 chars/token. To land at 90% of a 2000-token window, we need
      // 0.9 * 2000 - 4096(response budget) = -2296 tokens of content — which
      // is impossible. The refine response budget alone exceeds the small
      // window, so any section is over-budget. Use a window where the body
      // pushes the ratio into the warning band but stays under 1.0.
      // contextWindow = 5500; budget reserve = 4096; soft window = 0.8 * 5500 = 4400.
      // We want refineBudgetTokens >= 4400 but < 5500 → estimatedTokens in
      // [304, 1403]. 1500 chars / 4 = 375 tokens, total 4471 → ratio ≈ 81%.
      const section = makeSection({ body: 'x'.repeat(1500) });
      render(<EditableSection {...BASE_PROPS} section={section} contextWindow={5500} />);
      const badge = screen.getByText(/~375\s*tok/i);
      expect(badge).toBeInTheDocument();
      expect(badge.className).toMatch(/amber/);
    });

    it('renders a red size badge in view mode and disables the refine button after entering edit mode when over budget', async () => {
      // contextWindow=4000 → budget reserve alone (4096) exceeds it, so any
      // section is over-budget. Use a clearly-large body so the token count
      // is meaningful in the title attribute.
      const section = makeSection({ body: 'x'.repeat(400) });
      render(<EditableSection {...BASE_PROPS} section={section} contextWindow={4000} />);

      const badge = screen.getByText(/~100\s*tok/i);
      expect(badge.className).toMatch(/red/);

      // Enter edit mode and confirm the refine button is disabled with a
      // tooltip-style title attribute describing the over-budget state.
      const pencilButton = document.querySelector(
        `[aria-label="Edit section ${SECTION_MARKER}"]`
      ) as HTMLElement;
      fireEvent.click(pencilButton);
      await waitFor(() => expect(document.querySelector('textarea')).not.toBeNull());

      const refineBtn = screen.getByRole('button', { name: /refine with agent/i });
      expect(refineBtn).toBeDisabled();
      expect(refineBtn.getAttribute('title') ?? '').toMatch(/too large/i);
    });

    it('keeps the refine button enabled when the section fits the context window', async () => {
      // Short section, generous window — should not be disabled and the
      // tooltip should be absent.
      render(<EditableSection {...BASE_PROPS} />);
      const pencilButton = document.querySelector(
        `[aria-label="Edit section ${SECTION_MARKER}"]`
      ) as HTMLElement;
      fireEvent.click(pencilButton);
      await waitFor(() => expect(document.querySelector('textarea')).not.toBeNull());

      const refineBtn = screen.getByRole('button', { name: /refine with agent/i });
      expect(refineBtn).not.toBeDisabled();
      // No over-budget tooltip when within budget.
      expect(refineBtn.getAttribute('title')).toBeFalsy();
    });
  });
});
