// @vitest-environment happy-dom

/**
 * McpPromptsList — failed saves (§124)
 *
 * - Create: the failure shows inside the create dialog, above its footer. It
 *   used to be drawn at the top of the page, behind the dialog's overlay.
 * - Remove: the confirm dialog stays open with the failure inside it. It used
 *   to close and draw the error at the top of the page.
 * - Toggle: a row action; its failure shows above the table and takes focus.
 *
 * Sends through the real `apiClient`, onto a mocked `fetch` answering with
 * real error envelopes.
 *
 * @see components/admin/orchestration/mcp/mcp-prompts-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { McpPromptsList } from '@/components/admin/orchestration/mcp/mcp-prompts-list';
import type { PromptRow } from '@/lib/validations/mcp';

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const PROMPT: PromptRow = {
  id: 'p-1',
  name: 'analyze-pattern',
  description: 'Analyze a pattern',
  template: 'analyze {{pattern_number}}',
  argumentsSpec: [],
  isEnabled: true,
  createdAt: '2025-01-01T00:00:00Z',
};

const mockFetch = vi.fn();
const originalFetch = global.fetch;

function refuse(status: number, code: string, message: string) {
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ success: false, error: { code, message } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

/** A request held open until the test answers it with a refusal. */
function holdThenRefuse(): (status: number, code: string, message: string) => void {
  let answer: (r: Response) => void = () => {};
  mockFetch.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
  return (status, code, message) =>
    answer(
      new Response(JSON.stringify({ success: false, error: { code, message } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    );
}

describe('McpPromptsList — failed saves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as typeof fetch;
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('shows a failed create inside the dialog, above its footer', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[PROMPT]} />);

    await user.click(screen.getByTestId('create-prompt-trigger'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByTestId('prompt-name-input'), 'my-prompt');
    await user.type(within(dialog).getByLabelText(/Template/i), 'hello');
    refuse(409, 'PROMPT_CAP_EXCEEDED', 'The limit of 200 has been reached.');
    await user.click(within(dialog).getByTestId('create-prompt-submit'));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('The limit of 200 has been reached.');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByTestId('create-prompt-submit')
    );
    expect(alert).toHaveFocus();
  });

  it('keeps the remove dialog open with the failure inside it', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[PROMPT]} />);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    refuse(500, 'INTERNAL_ERROR', 'Prompt is locked');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Prompt is locked');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: 'Remove' })
    );
    expect(alert).toHaveFocus();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows a failed toggle directly above the table and focuses it', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[PROMPT]} />);

    refuse(500, 'INTERNAL_ERROR', 'Toggle refused');
    await user.click(screen.getByRole('switch', { name: /Enable analyze-pattern/i }));

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent('Couldn\'t disable "analyze-pattern": Toggle refused');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('commits the remove dialog while it runs: both buttons disabled, a second click sends nothing', async () => {
    let answer: (res: Response) => void = () => {};
    mockFetch.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[PROMPT]} />);

    await user.click(screen.getByRole('button', { name: /^Remove$/i }));
    const dialog = await screen.findByRole('alertdialog');
    const remove = within(dialog).getByRole('button', { name: /^Remove$/i });
    await user.click(remove);

    expect(remove).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^Cancel$/i })).toBeDisabled();
    await user.click(remove);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    answer(
      new Response(JSON.stringify({ success: true, data: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps row A's late remove failure in row A's dialog, never in row B's", async () => {
    let answer: (res: Response) => void = () => {};
    mockFetch.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    const other = { ...PROMPT, id: 'p-2', name: 'other-prompt' };
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[PROMPT, other]} />);

    await user.click(screen.getAllByRole('button', { name: /^Remove$/i })[0]);
    let dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^Remove$/i }));
    // Escape while the remove runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    answer(
      new Response(
        JSON.stringify({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Boom A' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    );

    dialog = screen.getByRole('alertdialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    await user.click(within(dialog).getByRole('button', { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /^Remove$/i })[1]);
    await screen.findByRole('alertdialog');
    expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
  });

  it('holds the create dialog open on Escape while the prompt is being created', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[PROMPT]} />);

    await user.click(screen.getByTestId('create-prompt-trigger'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByTestId('prompt-name-input'), 'my-prompt');
    await user.type(within(dialog).getByLabelText(/Template/i), 'hello');
    const refuseLate = holdThenRefuse();
    await user.click(within(dialog).getByTestId('create-prompt-submit'));
    await within(dialog).findByRole('button', { name: /creating/i });
    await user.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();

    refuseLate(500, 'INTERNAL_ERROR', 'Late create failure');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Late create failure');
  });

  it('holds the edit dialog open on Escape while the save is in flight', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[PROMPT]} />);

    await user.click(screen.getByTestId('edit-prompt-p-1'));
    const dialog = await screen.findByRole('dialog');
    const refuseLate = holdThenRefuse();
    await user.click(within(dialog).getByTestId('edit-prompt-save'));
    await within(dialog).findByRole('button', { name: /saving/i });
    await user.keyboard('{Escape}');
    expect(dialog).toBeInTheDocument();

    refuseLate(500, 'INTERNAL_ERROR', 'Late edit failure');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Late edit failure');
  });
});
