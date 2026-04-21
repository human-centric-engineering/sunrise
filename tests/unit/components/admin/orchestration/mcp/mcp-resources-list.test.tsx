import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { McpResourcesList } from '@/components/admin/orchestration/mcp/mcp-resources-list';
import { API } from '@/lib/api/endpoints';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
  // Render only the value as text — <option> cannot contain <span> children
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

// ---------------------------------------------------------------------------
// Fetch mock setup
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
// Test data factory
// ---------------------------------------------------------------------------

interface ResourceRow {
  id: string;
  name: string;
  uri: string;
  description: string;
  mimeType: string;
  resourceType: string;
  isEnabled: boolean;
}

function makeResource(overrides: Partial<ResourceRow> = {}): ResourceRow {
  return {
    id: 'r-1',
    name: 'Knowledge Search',
    uri: 'sunrise://knowledge/search',
    description: 'Search your KB',
    mimeType: 'application/json',
    resourceType: 'knowledge_search',
    isEnabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// describe: empty state
// ---------------------------------------------------------------------------

describe('empty state', () => {
  it('renders Database icon heading "No resources exposed yet" when initialResources=[]', () => {
    // Arrange & Act
    render(<McpResourcesList initialResources={[]} />);

    // Assert
    expect(screen.getByText('No resources exposed yet')).toBeInTheDocument();
  });

  it('renders all 4 RESOURCE_TYPES hint cards in the empty state', () => {
    // Arrange & Act
    render(<McpResourcesList initialResources={[]} />);

    // Assert
    expect(screen.getByText('Knowledge Search')).toBeInTheDocument();
    expect(screen.getByText('Agent List')).toBeInTheDocument();
    expect(screen.getByText('Workflow List')).toBeInTheDocument();
    expect(screen.getByText('Pattern Detail')).toBeInTheDocument();
  });

  it('"Create Your First Resource" button opens the create dialog', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);

    // Act
    await user.click(screen.getByRole('button', { name: 'Create Your First Resource' }));

    // Assert
    expect(await screen.findByText('Create MCP Resource')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// describe: create dialog — triggers
// ---------------------------------------------------------------------------

describe('create dialog — triggers', () => {
  it('top-right "Create Resource" button opens the create dialog', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);

    // Act — the DialogTrigger button carries data-testid="create-resource-trigger"
    await user.click(screen.getByTestId('create-resource-trigger'));

    // Assert
    expect(await screen.findByText('Create MCP Resource')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// describe: table render — non-empty
// ---------------------------------------------------------------------------

describe('table render — non-empty', () => {
  it('renders table (not empty state) when initialResources has ≥1 item', () => {
    // Arrange & Act
    render(<McpResourcesList initialResources={[makeResource()]} />);

    // Assert
    expect(screen.queryByText('No resources exposed yet')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('table row shows name, description, URI in code, resourceType Badge, mimeType, Switch, Remove', () => {
    // Arrange
    const resource = makeResource({
      description: 'Search your KB',
      uri: 'sunrise://knowledge/search',
      resourceType: 'knowledge_search',
      mimeType: 'application/json',
    });
    render(<McpResourcesList initialResources={[resource]} />);

    // Assert
    const row = screen.getByRole('row', { name: /Knowledge Search/i });
    expect(within(row).getByText('Knowledge Search')).toBeInTheDocument();
    expect(within(row).getByText('Search your KB')).toBeInTheDocument();
    expect(within(row).getByText('sunrise://knowledge/search')).toBeInTheDocument();
    expect(within(row).getByText('knowledge_search')).toBeInTheDocument();
    expect(within(row).getByText('application/json')).toBeInTheDocument();
    expect(within(row).getByRole('switch')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /Remove/i })).toBeInTheDocument();
  });

  it('Switch reflects isEnabled=true (checked)', () => {
    // Arrange
    render(<McpResourcesList initialResources={[makeResource({ isEnabled: true })]} />);

    // Assert
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('Switch reflects isEnabled=false (unchecked)', () => {
    // Arrange
    render(<McpResourcesList initialResources={[makeResource({ isEnabled: false })]} />);

    // Assert
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('multiple resources render in input order', () => {
    // Arrange
    const r1 = makeResource({ id: 'r-1', name: 'Alpha Resource' });
    const r2 = makeResource({ id: 'r-2', name: 'Beta Resource' });
    render(<McpResourcesList initialResources={[r1, r2]} />);

    // Assert — both names present in the table
    const rows = screen.getAllByRole('row');
    const names = rows.map((r) => r.textContent ?? '');
    const alphaIdx = names.findIndex((t) => t.includes('Alpha Resource'));
    const betaIdx = names.findIndex((t) => t.includes('Beta Resource'));
    expect(alphaIdx).toBeLessThan(betaIdx);
  });
});

// ---------------------------------------------------------------------------
// describe: resource type select
// ---------------------------------------------------------------------------

describe('resource type select', () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('create-resource-trigger'));
    await screen.findByText('Create MCP Resource');
  }

  it('all 4 RESOURCE_TYPES are available as options', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);
    await openDialog(user);

    // Assert — the mocked <select> renders each type as an <option>
    // Query all option elements under the select rather than casting HTMLSelectElement
    const options = screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toContain('knowledge_search');
    expect(options).toContain('agent_list');
    expect(options).toContain('workflow_list');
    expect(options).toContain('pattern_detail');
  });

  it('selecting knowledge_search auto-fills URI with sunrise://knowledge/search when URI is empty', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);
    await openDialog(user);

    // Act
    await user.selectOptions(screen.getByTestId('select-root'), 'knowledge_search');

    // Assert
    expect(screen.getByLabelText(/^URI/i)).toHaveValue('sunrise://knowledge/search');
  });

  it('selecting a type does NOT overwrite an already-populated URI', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);
    await openDialog(user);

    // Pre-fill URI
    await user.type(screen.getByLabelText(/^URI/i), 'sunrise://custom/path');

    // Act — pick a type
    await user.selectOptions(screen.getByTestId('select-root'), 'agent_list');

    // Assert — URI unchanged
    expect(screen.getByLabelText(/^URI/i)).toHaveValue('sunrise://custom/path');
  });

  it('after selecting a type, description hint text appears', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);
    await openDialog(user);

    // Act
    await user.selectOptions(screen.getByTestId('select-root'), 'knowledge_search');

    // Assert — the inline hint paragraph inside the dialog carries data-testid="resource-type-hint"
    const hint = screen.getByTestId('resource-type-hint');
    expect(hint).toHaveTextContent(/Search your knowledge base documents/i);
  });
});

// ---------------------------------------------------------------------------
// describe: form validation — submit button
// ---------------------------------------------------------------------------

describe('form validation — submit button', () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('create-resource-trigger'));
    await screen.findByText('Create MCP Resource');
  }

  function getSubmitButton() {
    // The footer "Create Resource" button inside the dialog
    return screen.getByRole('button', { name: /^Create Resource$/i });
  }

  it('submit button disabled when name is blank', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);
    await openDialog(user);

    await user.type(screen.getByLabelText(/^URI/i), 'sunrise://knowledge/search');
    await user.selectOptions(screen.getByTestId('select-root'), 'knowledge_search');

    // Assert — name still empty
    expect(getSubmitButton()).toBeDisabled();
  });

  it('submit button disabled when URI is blank', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);
    await openDialog(user);

    await user.type(screen.getByLabelText(/^Name/i), 'My Resource');
    await user.selectOptions(screen.getByTestId('select-root'), 'knowledge_search');
    // Clear the auto-filled URI
    await user.clear(screen.getByLabelText(/^URI/i));

    // Assert
    expect(getSubmitButton()).toBeDisabled();
  });

  it('submit button disabled when resourceType is not set', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);
    await openDialog(user);

    await user.type(screen.getByLabelText(/^Name/i), 'My Resource');
    await user.type(screen.getByLabelText(/^URI/i), 'sunrise://foo');

    // Assert — resourceType still empty
    expect(getSubmitButton()).toBeDisabled();
  });

  it('submit button enabled when name + URI + resourceType all filled', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<McpResourcesList initialResources={[]} />);
    await openDialog(user);

    await user.selectOptions(screen.getByTestId('select-root'), 'knowledge_search');
    await user.type(screen.getByLabelText(/^Name/i), 'My Resource');
    // URI auto-filled by type selection

    // Assert
    expect(getSubmitButton()).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// describe: create submit flow
// ---------------------------------------------------------------------------

describe('create submit flow', () => {
  async function openDialogAndFill(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('create-resource-trigger'));
    await screen.findByText('Create MCP Resource');

    await user.selectOptions(screen.getByTestId('select-root'), 'knowledge_search');
    await user.type(screen.getByLabelText(/^Name/i), 'My KB Resource');
    await user.type(screen.getByLabelText(/^Description/i), 'A description');
  }

  it('clicking submit while valid sends POST to MCP_RESOURCES with correct payload', async () => {
    // Arrange
    const user = userEvent.setup();
    const newResource = makeResource({ id: 'r-new', name: 'My KB Resource' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: newResource }),
    } as Response);

    render(<McpResourcesList initialResources={[]} />);
    await openDialogAndFill(user);

    // Act
    await user.click(screen.getByRole('button', { name: /^Create Resource$/i }));

    // Assert
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.MCP_RESOURCES,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"name":"My KB Resource"'),
        })
      );
    });
  });

  it('while submitting, button shows "Creating..." and is disabled', async () => {
    // Arrange
    const user = userEvent.setup();
    let resolveRequest!: (value: unknown) => void;
    const deferred = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    mockFetch.mockReturnValue(deferred);

    render(<McpResourcesList initialResources={[]} />);
    await openDialogAndFill(user);

    // Act — click but do NOT await resolution yet
    void user.click(screen.getByRole('button', { name: /^Create Resource$/i }));

    // Assert intermediate state
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Creating\.\.\./i })).toBeDisabled();
    });

    // Cleanup — resolve to avoid hanging
    resolveRequest({ ok: false });
  });

  it('on success: new resource appended to the table', async () => {
    // Arrange
    const user = userEvent.setup();
    const newResource = makeResource({ id: 'r-new', name: 'My KB Resource' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: newResource }),
    } as Response);

    render(<McpResourcesList initialResources={[]} />);
    await openDialogAndFill(user);

    // Act
    await user.click(screen.getByRole('button', { name: /^Create Resource$/i }));

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getByText('My KB Resource')).toBeInTheDocument();
    });
  });

  it('on success: dialog closes (table visible, dialog title gone)', async () => {
    // Arrange
    const user = userEvent.setup();
    const newResource = makeResource({ id: 'r-new', name: 'My KB Resource' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: newResource }),
    } as Response);

    render(<McpResourcesList initialResources={[]} />);
    await openDialogAndFill(user);

    // Act
    await user.click(screen.getByRole('button', { name: /^Create Resource$/i }));

    // Assert
    await waitFor(() => {
      expect(screen.queryByText('Create MCP Resource')).not.toBeInTheDocument();
    });
  });

  it('on success: form resets (reopen dialog → all fields empty/default)', async () => {
    // Arrange
    const user = userEvent.setup();
    const newResource = makeResource({ id: 'r-new', name: 'My KB Resource' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: newResource }),
    } as Response);

    render(<McpResourcesList initialResources={[]} />);
    await openDialogAndFill(user);
    await user.click(screen.getByRole('button', { name: /^Create Resource$/i }));

    // Wait for dialog to close
    await waitFor(() => {
      expect(screen.queryByText('Create MCP Resource')).not.toBeInTheDocument();
    });

    // Reopen
    const row = screen.getByRole('row', { name: /My KB Resource/i });
    // Reopen via Create Resource button (top trigger)
    await user.click(screen.getByRole('button', { name: /^Create Resource$/i }));
    await screen.findByText('Create MCP Resource');

    // Assert fields reset
    expect(screen.getByLabelText(/^Name/i)).toHaveValue('');
    expect(screen.getByLabelText(/^URI/i)).toHaveValue('');
    expect(screen.getByLabelText(/^Description/i)).toHaveValue('');
    expect(screen.getByLabelText(/MIME Type/i)).toHaveValue('application/json');
    // Void row reference warning suppression
    void row;
  });

  it('on res.ok but body.success=false: resource NOT added; dialog stays open', async () => {
    // Arrange
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: false }),
    } as Response);

    render(<McpResourcesList initialResources={[]} />);
    await openDialogAndFill(user);

    // Act
    await user.click(screen.getByRole('button', { name: /^Create Resource$/i }));

    // Assert — dialog still open, no new rows
    await waitFor(() => {
      expect(screen.getByText('Create MCP Resource')).toBeInTheDocument();
    });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('on res.ok=false: resource NOT added; creating resets to "Create Resource"', async () => {
    // Arrange
    const user = userEvent.setup();
    mockFetch.mockResolvedValue({ ok: false } as Response);

    render(<McpResourcesList initialResources={[]} />);
    await openDialogAndFill(user);

    // Act
    await user.click(screen.getByRole('button', { name: /^Create Resource$/i }));

    // Assert — button reverts, no table
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Create Resource$/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('fetch throws (network error): creating resets via finally', async () => {
    // Arrange
    const user = userEvent.setup();
    mockFetch.mockRejectedValue(new Error('Network error'));

    // The component uses `void handleCreate()` which means the rejected promise escapes
    // as an unhandled rejection. Suppress at the process level so Vitest doesn't count
    // it as a suite error. Guard with try/finally so the handler is removed even if the
    // waitFor assertion throws.
    const suppress = (reason: Error) => {
      if (reason?.message === 'Network error') return;
      throw reason;
    };
    process.on('unhandledRejection', suppress);

    try {
      render(<McpResourcesList initialResources={[]} />);
      await openDialogAndFill(user);

      // Act
      try {
        await user.click(screen.getByRole('button', { name: /^Create Resource$/i }));
      } catch {
        // expected — userEvent may surface the rejection
      }

      // Assert — button resets via finally, no crash
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Create Resource$/i })).toBeInTheDocument();
      });
    } finally {
      process.off('unhandledRejection', suppress);
    }
  });
});

// ---------------------------------------------------------------------------
// describe: toggle handler
// ---------------------------------------------------------------------------

describe('toggle handler', () => {
  it('clicking Switch sends PATCH to mcpResourceById with { isEnabled: <new> }', async () => {
    // Arrange
    const user = userEvent.setup();
    const resource = makeResource({ id: 'r-1', isEnabled: false });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    } as Response);
    render(<McpResourcesList initialResources={[resource]} />);

    // Act
    await user.click(screen.getByRole('switch'));

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      API.ADMIN.ORCHESTRATION.mcpResourceById('r-1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: true }),
      })
    );
  });

  it('on res.ok: Switch reflects new state after response', async () => {
    // Arrange
    const user = userEvent.setup();
    const resource = makeResource({ id: 'r-1', isEnabled: false });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    } as Response);
    render(<McpResourcesList initialResources={[resource]} />);

    // Act
    await user.click(screen.getByRole('switch'));

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeChecked();
    });
  });

  it('on res.ok=false: Switch stays at original state', async () => {
    // Arrange
    const user = userEvent.setup();
    const resource = makeResource({ id: 'r-1', isEnabled: false });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ success: false, error: { code: 'ERROR', message: 'fail' } }),
    } as Response);
    render(<McpResourcesList initialResources={[resource]} />);

    // Act
    await user.click(screen.getByRole('switch'));

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('switch')).not.toBeChecked();
    });
  });
});

// ---------------------------------------------------------------------------
// describe: remove handler
// ---------------------------------------------------------------------------

describe('remove handler', () => {
  it('clicking Remove sends DELETE to mcpResourceById(id)', async () => {
    // Arrange
    const user = userEvent.setup();
    const resource = makeResource({ id: 'r-1', name: 'Knowledge Search' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    } as Response);
    render(<McpResourcesList initialResources={[resource]} />);

    // Act
    await user.click(screen.getByRole('button', { name: /Remove/i }));

    // Assert
    expect(mockFetch).toHaveBeenCalledWith(
      API.ADMIN.ORCHESTRATION.mcpResourceById('r-1'),
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('on res.ok: resource is removed from the table', async () => {
    // Arrange
    const user = userEvent.setup();
    // Use a name that doesn't appear in the RESOURCE_TYPES hint cards shown in empty state
    const resource = makeResource({ id: 'r-1', name: 'My Custom Resource' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: {} }),
    } as Response);
    render(<McpResourcesList initialResources={[resource]} />);

    // Act
    await user.click(screen.getByRole('button', { name: /Remove/i }));

    // Assert — after removal table is gone and the unique name is no longer present
    await waitFor(() => {
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });
  });

  it('on res.ok=false: resource stays in the table', async () => {
    // Arrange
    const user = userEvent.setup();
    const resource = makeResource({ id: 'r-1', name: 'Knowledge Search' });
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ success: false, error: { code: 'ERROR', message: 'fail' } }),
    } as Response);
    render(<McpResourcesList initialResources={[resource]} />);

    // Act
    await user.click(screen.getByRole('button', { name: /Remove/i }));

    // Assert
    await waitFor(() => {
      expect(screen.getByText('Knowledge Search')).toBeInTheDocument();
    });
  });
});
