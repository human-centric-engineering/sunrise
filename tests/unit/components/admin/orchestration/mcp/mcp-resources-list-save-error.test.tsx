// @vitest-environment happy-dom

/**
 * McpResourcesList — failed saves (§124)
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
 * @see components/admin/orchestration/mcp/mcp-resources-list.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { McpResourcesList } from '@/components/admin/orchestration/mcp/mcp-resources-list';
import type { ResourceRow } from '@/lib/validations/mcp';

vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)} data-testid="select-root">
      <option value="">Choose what data to expose...</option>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{value}</option>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}));
vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const RESOURCE: ResourceRow = {
  id: 'r-1',
  name: 'Knowledge Search',
  uri: 'sunrise://knowledge/search',
  description: 'Search your KB',
  mimeType: 'application/json',
  resourceType: 'knowledge_search',
  isEnabled: true,
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

describe('McpResourcesList — failed saves', () => {
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
    render(<McpResourcesList initialResources={[RESOURCE]} />);

    await user.click(screen.getByTestId('create-resource-trigger'));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name/i), 'Agents');
    await user.selectOptions(within(dialog).getByTestId('select-root'), 'agent_list');
    refuse(409, 'CONFLICT', 'That URI is already exposed');
    await user.click(within(dialog).getByRole('button', { name: /^Create Resource$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('That URI is already exposed');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /^Create Resource$/i })
    );
    expect(alert).toHaveFocus();
  });

  it('keeps the remove dialog open with the failure inside it', async () => {
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[RESOURCE]} />);

    await user.click(screen.getByRole('button', { name: /^Remove$/i }));
    const dialog = await screen.findByRole('alertdialog');
    refuse(500, 'INTERNAL_ERROR', 'Resource is locked');
    await user.click(within(dialog).getByRole('button', { name: /^Remove$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Resource is locked');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /^Remove$/i })
    );
    expect(alert).toHaveFocus();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows a failed toggle directly above the table and focuses it', async () => {
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[RESOURCE]} />);

    refuse(500, 'INTERNAL_ERROR', 'Toggle refused');
    await user.click(screen.getByRole('switch', { name: /Enable Knowledge Search/i }));

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent('Couldn\'t disable "Knowledge Search": Toggle refused');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('commits the remove dialog while it runs: both buttons disabled, a second click sends nothing', async () => {
    let answer: (res: Response) => void = () => {};
    mockFetch.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[RESOURCE]} />);

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
    const other = { ...RESOURCE, id: 'r-2', name: 'Other Resource', uri: 'sunrise://other' };
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[RESOURCE, other]} />);

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
});
