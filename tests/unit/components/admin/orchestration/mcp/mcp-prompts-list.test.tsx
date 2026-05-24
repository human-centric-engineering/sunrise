import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpPromptsList } from '@/components/admin/orchestration/mcp/mcp-prompts-list';
import { API } from '@/lib/api/endpoints';
import type { PromptRow } from '@/lib/validations/mcp';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ---------------------------------------------------------------------------
// Fetch mock (apiClient under the hood uses global fetch)
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = mockFetch as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePrompt(overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    id: 'p-1',
    name: 'analyze-pattern',
    description: 'Analyze a pattern',
    template: 'analyze {{pattern_number}}',
    argumentsSpec: [{ name: 'pattern_number', description: 'pattern number', required: true }],
    isEnabled: true,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function mockOk(body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: body }),
  });
}

function mockNotOk(status: number, message = 'boom', code?: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({
      success: false,
      error: code ? { message, code } : { message },
    }),
  });
}

// ---------------------------------------------------------------------------
// describe: empty state
// ---------------------------------------------------------------------------

describe('empty state', () => {
  it('renders the empty-state card when no prompts exist', () => {
    render(<McpPromptsList initialPrompts={[]} />);
    expect(screen.getByText(/No prompts yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Your First Prompt/i })).toBeInTheDocument();
  });

  it('explains prompts are slash-command templates surfaced to end users', () => {
    // Critical UX disambiguation: prompts must not be conflated with tools.
    // The empty-state copy is the first thing a new admin sees. "not" is
    // wrapped in <em> for emphasis, so the relevant text spans multiple
    // text nodes — match by paragraph textContent. Multiple ancestor
    // elements also include the text, so use getAllByText + length check.
    render(<McpPromptsList initialPrompts={[]} />);
    expect(screen.getByText(/slash-command templates/i)).toBeInTheDocument();
    expect(
      screen.getAllByText((_, el) =>
        Boolean(el?.textContent && /not auto-invoked/i.test(el.textContent))
      ).length
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// describe: table rendering
// ---------------------------------------------------------------------------

describe('table rendering', () => {
  it('renders one row per prompt with name, description, and argument count', () => {
    render(
      <McpPromptsList
        initialPrompts={[
          makePrompt(),
          makePrompt({
            id: 'p-2',
            name: 'search-knowledge',
            description: 'Search the knowledge base',
            argumentsSpec: [],
          }),
        ]}
      />
    );

    expect(screen.getAllByText('analyze-pattern').length).toBeGreaterThan(0);
    expect(screen.getAllByText('search-knowledge').length).toBeGreaterThan(0);
    expect(screen.getByText('Analyze a pattern')).toBeInTheDocument();
    expect(screen.getByText('Search the knowledge base')).toBeInTheDocument();
  });

  it('shows the Switch in checked state when isEnabled', () => {
    render(<McpPromptsList initialPrompts={[makePrompt()]} />);
    expect(screen.getByRole('switch', { name: /Enable analyze-pattern/i })).toBeChecked();
  });

  it('shows the Switch in unchecked state when not enabled', () => {
    render(<McpPromptsList initialPrompts={[makePrompt({ isEnabled: false })]} />);
    expect(screen.getByRole('switch', { name: /Enable analyze-pattern/i })).not.toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// describe: toggle flow
// ---------------------------------------------------------------------------

describe('toggle handler', () => {
  it('sends PATCH with {isEnabled: false} when toggling off', async () => {
    const user = userEvent.setup();
    mockOk({ id: 'p-1' });

    render(<McpPromptsList initialPrompts={[makePrompt()]} />);
    await user.click(screen.getByRole('switch', { name: /Enable analyze-pattern/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.mcpPromptById('p-1'),
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('"isEnabled":false'),
        })
      );
    });
  });

  it('surfaces a generic error message when the PATCH fails', async () => {
    const user = userEvent.setup();
    mockNotOk(500);

    render(<McpPromptsList initialPrompts={[makePrompt()]} />);
    await user.click(screen.getByRole('switch', { name: /Enable analyze-pattern/i }));

    await waitFor(() => {
      // extractErrorMessage returns the API message when present, else the fallback.
      expect(screen.getByText(/boom|Failed to toggle prompt/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// describe: create flow
// ---------------------------------------------------------------------------

describe('create flow', () => {
  it('opens the create dialog from the empty-state button', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[]} />);
    await user.click(screen.getByRole('button', { name: /Create Your First Prompt/i }));
    expect(await screen.findByText(/Create MCP Prompt/i)).toBeInTheDocument();
  });

  it('opens the create dialog from the header trigger', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[makePrompt()]} />);
    await user.click(screen.getByTestId('create-prompt-trigger'));
    expect(await screen.findByText(/Create MCP Prompt/i)).toBeInTheDocument();
  });

  it('disables the submit button until name and template are non-empty', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[]} />);

    await user.click(screen.getByRole('button', { name: /Create Your First Prompt/i }));
    const submit = await screen.findByTestId('create-prompt-submit');
    expect(submit).toBeDisabled();

    // Fill name only — still disabled.
    const nameInput = screen.getByTestId('prompt-name-input');
    await user.type(nameInput, 'my-prompt');
    expect(submit).toBeDisabled();

    // Fill template — now enabled.
    const templateInput = screen.getByLabelText(/Template/i);
    await user.type(templateInput, 'hello');
    expect(submit).toBeEnabled();
  });

  it('POSTs to MCP_PROMPTS with the assembled body and closes the dialog on success', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[]} />);

    await user.click(screen.getByRole('button', { name: /Create Your First Prompt/i }));
    await user.type(screen.getByTestId('prompt-name-input'), 'my-prompt');
    await user.type(screen.getByLabelText(/Template/i), 'hello');

    mockOk(makePrompt({ id: 'new-p', name: 'my-prompt', template: 'hello' }));

    await user.click(screen.getByTestId('create-prompt-submit'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.MCP_PROMPTS,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"name":"my-prompt"'),
        })
      );
    });

    // Dialog should close — the title is gone from the DOM.
    await waitFor(() => {
      expect(screen.queryByText(/Create MCP Prompt/i)).not.toBeInTheDocument();
    });

    // The new prompt appears in the table.
    expect(screen.getByText('my-prompt')).toBeInTheDocument();
  });

  it('does not POST when name/template are blank (button stays disabled)', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[]} />);

    await user.click(screen.getByRole('button', { name: /Create Your First Prompt/i }));
    const submit = await screen.findByTestId('create-prompt-submit');
    // The button is disabled; clicking it has no effect. Verifying the
    // handler is wired to also guard so a programmatic click is harmless.
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces a server error and keeps the dialog open on POST failure', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[]} />);

    await user.click(screen.getByRole('button', { name: /Create Your First Prompt/i }));
    await user.type(screen.getByTestId('prompt-name-input'), 'my-prompt');
    await user.type(screen.getByLabelText(/Template/i), 'hello');

    mockNotOk(409, 'Cap exceeded');
    await user.click(screen.getByTestId('create-prompt-submit'));

    await waitFor(() => {
      expect(screen.getByText(/Cap exceeded|Failed to create prompt/i)).toBeInTheDocument();
    });
    // Dialog still open.
    expect(screen.getByText(/Create MCP Prompt/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// describe: argument editor
// ---------------------------------------------------------------------------

describe('argument editor', () => {
  it('starts with no arguments and adds one via the Add button', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[]} />);
    await user.click(screen.getByRole('button', { name: /Create Your First Prompt/i }));

    expect(screen.getByText(/No arguments — this prompt is static/i)).toBeInTheDocument();

    await user.click(screen.getByTestId('add-argument'));
    expect(screen.getByTestId('arg-name-0')).toBeInTheDocument();
  });

  it('updates an argument name, description, and required toggle, then removes it', async () => {
    // Exercises updateArg, removeArg, and the row-level input handlers
    // (name field, description field, required checkbox, X button).
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[]} />);

    await user.click(screen.getByRole('button', { name: /Create Your First Prompt/i }));
    await user.click(screen.getByTestId('add-argument'));

    const nameField = screen.getByTestId('arg-name-0');
    await user.type(nameField, 'pattern_number');
    expect(nameField).toHaveValue('pattern_number');

    // Description is the second input in the arg-row grid. Use placeholder
    // to find it precisely (the prompt-level description placeholder is
    // different and doesn't collide).
    const descField = screen.getAllByPlaceholderText('description')[0];
    await user.type(descField, 'the pattern number');
    expect(descField).toHaveValue('the pattern number');

    // Required checkbox — its label text is just "required".
    await user.click(screen.getByText('required'));

    // Remove the row via the X button (aria-label "Remove argument").
    await user.click(screen.getByRole('button', { name: /Remove argument/i }));
    expect(screen.queryByTestId('arg-name-0')).not.toBeInTheDocument();
  });

  it('caps argument rows at 20 (Add button disabled when at the cap)', async () => {
    // Build a prompt that's already at 20 args, open edit, and verify the Add
    // button is disabled. Using edit keeps the form populated; using create
    // would require 20 user.click() loops.
    const user = userEvent.setup();
    const twentyArgs = Array.from({ length: 20 }, (_, i) => ({
      name: `arg_${String(i)}`,
      description: 'd',
      required: false,
    }));
    render(<McpPromptsList initialPrompts={[makePrompt({ argumentsSpec: twentyArgs })]} />);

    await user.click(screen.getByTestId('edit-prompt-p-1'));
    expect(screen.getByTestId('add-argument')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// describe: edit flow
// ---------------------------------------------------------------------------

describe('edit flow', () => {
  it('opens with the row data pre-populated', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[makePrompt()]} />);

    await user.click(screen.getByTestId('edit-prompt-p-1'));

    expect(await screen.findByText(/Edit Prompt: analyze-pattern/i)).toBeInTheDocument();
    // Name input rendered but disabled (immutable post-create).
    const nameInput = screen.getByTestId('prompt-name-input');
    expect(nameInput).toHaveValue('analyze-pattern');
    expect(nameInput).toBeDisabled();
  });

  it('warns that name is immutable and suggests versioned naming', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[makePrompt()]} />);

    await user.click(screen.getByTestId('edit-prompt-p-1'));

    expect(await screen.findByText(/cannot be changed/i)).toBeInTheDocument();
    // Versioned-naming guidance landed after the prompts-doc review.
    // "-v2" appears in two places (dialog header + FieldHelp body), so use
    // getAllByText to match both rather than tripping the "multiple matches"
    // error of getByText.
    expect(
      screen.getAllByText((_, el) => /-v2/i.test(el?.textContent ?? '')).length
    ).toBeGreaterThan(0);
  });

  it('PATCHes with the changed fields and updates the local row', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[makePrompt()]} />);

    await user.click(screen.getByTestId('edit-prompt-p-1'));
    const desc = await screen.findByLabelText(/Description/i);
    await user.clear(desc);
    await user.type(desc, 'Better description');

    mockOk(makePrompt({ description: 'Better description' }));
    await user.click(screen.getByTestId('edit-prompt-save'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.mcpPromptById('p-1'),
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('Better description'),
        })
      );
    });

    // Local row reflects the edit.
    expect(screen.getByText('Better description')).toBeInTheDocument();
  });

  it('surfaces a server error inside the dialog on PATCH failure', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[makePrompt()]} />);

    await user.click(screen.getByTestId('edit-prompt-p-1'));
    mockNotOk(500, 'server unavailable');
    await user.click(screen.getByTestId('edit-prompt-save'));

    await waitFor(() => {
      expect(screen.getByText(/server unavailable|Failed to update prompt/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// describe: preview flow
// ---------------------------------------------------------------------------

describe('preview flow', () => {
  it('renders the template with mock arg values applied to declared names', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[makePrompt()]} />);

    await user.click(screen.getByRole('button', { name: /Preview/i }));

    expect(await screen.findByText(/Preview: analyze-pattern/i)).toBeInTheDocument();
    // Seed input is empty; rendered output shows the empty interpolation.
    expect(screen.getByTestId('preview-output').textContent).toBe('analyze ');

    // Fill the arg and verify substitution happens client-side.
    await user.type(screen.getByLabelText(/pattern_number/i), '7');
    expect(screen.getByTestId('preview-output').textContent).toBe('analyze 7');
  });

  it('renders undeclared placeholders literally (safety mirror of server-side rule)', async () => {
    const user = userEvent.setup();
    // Template references {{secret}} which is NOT in argumentsSpec — must
    // render literally, not be evaluated against any client-side value.
    render(
      <McpPromptsList
        initialPrompts={[
          makePrompt({
            template: 'value={{name}} undeclared={{secret}}',
            argumentsSpec: [{ name: 'name', description: 'n', required: true }],
          }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { name: /Preview/i }));
    // The arg input is rendered with id="preview-arg-name"; target it by id
    // rather than label text because required-arg labels include a "*" span
    // that breaks getByLabelText's text matching.
    const nameArgInput = document.getElementById('preview-arg-name') as HTMLInputElement;
    await user.type(nameArgInput, 'alice');

    expect(screen.getByTestId('preview-output').textContent).toBe(
      'value=alice undeclared={{secret}}'
    );
  });
});

// ---------------------------------------------------------------------------
// describe: remove flow
// ---------------------------------------------------------------------------

describe('remove flow', () => {
  it('sends DELETE and removes the row from the table on confirm', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[makePrompt()]} />);

    await user.click(screen.getByRole('button', { name: /Remove/i }));
    // Confirm dialog — click the destructive action button.
    mockOk({ id: 'p-1', deleted: true });
    await user.click(screen.getByRole('button', { name: /^Remove$/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.mcpPromptById('p-1'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('analyze-pattern')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// describe: error-message extraction + edge branches
// ---------------------------------------------------------------------------

describe('error extraction', () => {
  it('surfaces the PROMPT_CAP_EXCEEDED message verbatim when the API returns that code', async () => {
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[]} />);

    await user.click(screen.getByRole('button', { name: /Create Your First Prompt/i }));
    await user.type(screen.getByTestId('prompt-name-input'), 'my-prompt');
    await user.type(screen.getByLabelText(/Template/i), 'hello');

    // APIClientError preserves the error.code from the API response body,
    // which extractErrorMessage uses to render the cap message verbatim.
    mockNotOk(
      409,
      'Cannot create another enabled prompt — the limit of 200 has been reached.',
      'PROMPT_CAP_EXCEEDED'
    );
    await user.click(screen.getByTestId('create-prompt-submit'));

    await waitFor(() => {
      expect(screen.getByText(/limit of 200/i)).toBeInTheDocument();
    });
  });
});

describe('edit dialog edge branches', () => {
  it('skips the network call when no diff (apiClient still receives a PATCH with the unchanged body)', async () => {
    // The component does not guard against zero-diff submits — clicking
    // Save with no changes still fires a PATCH carrying the current
    // values. Verify the request shape so a future no-op short-circuit
    // would be a deliberate behaviour change.
    const user = userEvent.setup();
    mockOk(makePrompt());

    render(<McpPromptsList initialPrompts={[makePrompt()]} />);
    await user.click(screen.getByTestId('edit-prompt-p-1'));
    await user.click(screen.getByTestId('edit-prompt-save'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.mcpPromptById('p-1'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  it('filters argument rows whose name is blank when saving', async () => {
    // Add an empty argument row before save — the handler must drop it
    // so the server never sees `{ name: '' }`.
    const user = userEvent.setup();
    render(<McpPromptsList initialPrompts={[makePrompt({ argumentsSpec: [] })]} />);

    await user.click(screen.getByTestId('edit-prompt-p-1'));
    await user.click(screen.getByTestId('add-argument'));
    // Leave the new arg's name blank.

    mockOk(makePrompt());
    await user.click(screen.getByTestId('edit-prompt-save'));

    await waitFor(() => {
      const body = JSON.parse((vi.mocked(mockFetch).mock.calls[0][1] as { body: string }).body) as {
        argumentsSpec: unknown[];
      };
      expect(body.argumentsSpec).toEqual([]);
    });
  });
});

describe('preview dialog with empty argumentsSpec', () => {
  it('renders the template as-is when the prompt has no arguments', async () => {
    const user = userEvent.setup();
    render(
      <McpPromptsList
        initialPrompts={[makePrompt({ template: 'static text', argumentsSpec: [] })]}
      />
    );

    await user.click(screen.getByRole('button', { name: /Preview/i }));

    expect(screen.getByTestId('preview-output').textContent).toBe('static text');
  });
});
