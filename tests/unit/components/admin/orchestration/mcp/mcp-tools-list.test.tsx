// @vitest-environment happy-dom

/**
 * McpToolsList Component Tests
 *
 * Test Coverage:
 * - Renders empty state when no tools
 * - Renders tool rows with capability name, slug, category
 * - Shows custom name and rate limit when set
 * - Add tool select and button
 * - Toggle calls apiClient.patch
 * - Remove calls apiClient.delete
 * - Edit dialog opens with current values
 * - Edit save calls apiClient.patch with updated fields
 *
 * @see components/admin/orchestration/mcp/mcp-tools-list.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { apiClient } from '@/lib/api/client';
import { McpToolsList } from '@/components/admin/orchestration/mcp/mcp-tools-list';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CAPABILITY = {
  id: 'cap-1',
  name: 'Send Email',
  slug: 'send_email',
  description: 'Sends an email',
  category: 'communication',
};

const TOOL = {
  id: 'tool-1',
  capabilityId: 'cap-1',
  isEnabled: true,
  customName: null as string | null,
  customDescription: null as string | null,
  rateLimitPerKey: null as number | null,
  requiresScope: null as string | null,
  // MCP 2025-06-18 tool annotations (all null = "no opinion" for the row)
  customTitle: null as string | null,
  readOnlyHint: null as boolean | null,
  destructiveHint: null as boolean | null,
  idempotentHint: null as boolean | null,
  openWorldHint: null as boolean | null,
  capability: CAPABILITY,
};

const TOOL_WITH_OVERRIDES = {
  ...TOOL,
  id: 'tool-2',
  customName: 'custom_send',
  rateLimitPerKey: 30,
};

const UNUSED_CAPABILITY = {
  id: 'cap-2',
  name: 'Search Knowledge',
  slug: 'search_knowledge',
  description: 'Searches the knowledge base',
  category: 'data',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpToolsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Empty state', () => {
    it('renders empty state when no tools', () => {
      render(<McpToolsList initialTools={[]} capabilities={[UNUSED_CAPABILITY]} />);
      expect(screen.getByText(/no tools exposed yet/i)).toBeInTheDocument();
    });
  });

  describe('Tool rows', () => {
    it('renders capability name, slug, and category', () => {
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);
      expect(screen.getByText('Send Email')).toBeInTheDocument();
      expect(screen.getByText('send_email')).toBeInTheDocument();
      expect(screen.getByText('communication')).toBeInTheDocument();
    });

    it('shows "—" when no custom name', () => {
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);
      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('shows custom name when set', () => {
      render(<McpToolsList initialTools={[TOOL_WITH_OVERRIDES]} capabilities={[]} />);
      expect(screen.getByText('custom_send')).toBeInTheDocument();
    });

    it('shows rate limit when set', () => {
      render(<McpToolsList initialTools={[TOOL_WITH_OVERRIDES]} capabilities={[]} />);
      expect(screen.getByText('30/min')).toBeInTheDocument();
    });

    it('shows "default" when no rate limit', () => {
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);
      expect(screen.getByText('default')).toBeInTheDocument();
    });
  });

  describe('Add tool', () => {
    it('shows Add Tool button when available capabilities exist', () => {
      render(<McpToolsList initialTools={[]} capabilities={[UNUSED_CAPABILITY]} />);
      expect(screen.getByText('Add Tool')).toBeInTheDocument();
    });

    it('hides Add Tool select when all capabilities are exposed', () => {
      render(<McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY]} />);
      expect(screen.queryByText('Add Tool')).not.toBeInTheDocument();
    });
  });

  describe('Toggle', () => {
    it('calls apiClient.patch when toggle is clicked', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);

      const toggle = screen.getByRole('switch', { name: /enable send email/i });
      await act(async () => {
        fireEvent.click(toggle);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/tools/tool-1'),
          expect.objectContaining({ body: { isEnabled: false } })
        );
      });
    });
  });

  describe('Remove', () => {
    it('calls apiClient.delete when Remove is confirmed via dialog', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue(undefined);
      render(<McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY]} />);

      // Click the Remove trigger to open confirmation dialog
      await act(async () => {
        fireEvent.click(screen.getByText('Remove'));
      });

      // Click the confirmation button inside the AlertDialog
      const confirmButton = await screen.findByRole('button', { name: /^Remove$/i });
      await act(async () => {
        fireEvent.click(confirmButton);
      });

      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('/mcp/tools/tool-1'));
      });
    });
  });

  describe('Error states', () => {
    it('shows error when toggle fails', async () => {
      vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error('fail'));
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);

      const toggle = screen.getByRole('switch', { name: /enable send email/i });
      await act(async () => {
        fireEvent.click(toggle);
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to toggle tool.')).toBeInTheDocument();
      });
    });

    it('shows error when add fails', async () => {
      vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('fail'));
      render(<McpToolsList initialTools={[]} capabilities={[UNUSED_CAPABILITY]} />);

      // Select a capability — trigger the select change via the hidden select
      const select = screen.getByRole('combobox');
      await act(async () => {
        fireEvent.click(select);
      });

      // Pick the option
      const option = await screen.findByRole('option', { name: /search knowledge/i });
      await act(async () => {
        fireEvent.click(option);
      });

      // Click Add Tool
      await act(async () => {
        fireEvent.click(screen.getByText('Add Tool'));
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to add tool.')).toBeInTheDocument();
      });
    });

    it('shows error when remove fails', async () => {
      vi.mocked(apiClient.delete).mockRejectedValueOnce(new Error('fail'));
      render(<McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Remove'));
      });

      const confirmButton = await screen.findByRole('button', { name: /^Remove$/i });
      await act(async () => {
        fireEvent.click(confirmButton);
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to remove tool.')).toBeInTheDocument();
      });
    });

    it('shows error when edit save fails', async () => {
      vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error('fail'));
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /edit send email/i }));
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Save Changes'));
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to save tool changes.')).toBeInTheDocument();
      });
    });
  });

  describe('Edit dialog', () => {
    it('opens edit dialog when Edit button is clicked', async () => {
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /edit send email/i }));
      });

      expect(screen.getByText(/edit tool: send email/i)).toBeInTheDocument();
      expect(document.getElementById('edit-custom-name')).toBeInTheDocument();
      expect(document.getElementById('edit-custom-desc')).toBeInTheDocument();
      expect(document.getElementById('edit-rate-limit')).toBeInTheDocument();
      expect(document.getElementById('edit-requires-scope')).toBeInTheDocument();
    });

    it('saves changes when Save Changes is clicked', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);

      // Open edit
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /edit send email/i }));
      });

      // Click save
      await act(async () => {
        fireEvent.click(screen.getByText('Save Changes'));
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/tools/tool-1'),
          expect.objectContaining({
            body: expect.objectContaining({
              customName: null,
              customDescription: null,
              rateLimitPerKey: null,
              requiresScope: null,
            }),
          })
        );
      });
    });

    it('saves with filled-in values and closes dialog', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);

      // Open edit
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /edit send email/i }));
      });

      // Fill in custom name
      const nameInput = document.getElementById('edit-custom-name') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(nameInput, { target: { value: 'my_tool' } });
      });

      // Fill in custom description
      const descInput = document.getElementById('edit-custom-desc') as HTMLTextAreaElement;
      await act(async () => {
        fireEvent.change(descInput, { target: { value: 'My custom description' } });
      });

      // Fill in rate limit
      const rateInput = document.getElementById('edit-rate-limit') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(rateInput, { target: { value: '100' } });
      });

      // Fill in scope
      const scopeInput = document.getElementById('edit-requires-scope') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(scopeInput, { target: { value: 'admin:write' } });
      });

      // Save
      await act(async () => {
        fireEvent.click(screen.getByText('Save Changes'));
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/tools/tool-1'),
          expect.objectContaining({
            body: expect.objectContaining({
              customName: 'my_tool',
              customDescription: 'My custom description',
              rateLimitPerKey: 100,
              requiresScope: 'admin:write',
            }),
          })
        );
      });

      // Dialog should close after save
      await waitFor(() => {
        expect(screen.queryByText(/edit tool: send email/i)).not.toBeInTheDocument();
      });
    });

    it('closes edit dialog when dismissed', async () => {
      render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /edit send email/i }));
      });

      expect(screen.getByText(/edit tool: send email/i)).toBeInTheDocument();

      // Close via ESC
      await act(async () => {
        fireEvent.keyDown(document.body, { key: 'Escape' });
      });

      await waitFor(() => {
        expect(screen.queryByText(/edit tool: send email/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('read-only outside the install org (§107 t-753)', () => {
    function renderReadOnly(ui: React.ReactElement) {
      return render(
        <SharedSettingsAccessProvider readOnly canSwitch>
          {ui}
        </SharedSettingsAccessProvider>
      );
    }

    it('hides the Add Tool picker that the same fixture shows when editable', () => {
      const { unmount } = render(
        <McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY, UNUSED_CAPABILITY]} />
      );
      expect(screen.getByText('Add Tool')).toBeInTheDocument();
      unmount();

      renderReadOnly(
        <McpToolsList initialTools={[TOOL]} capabilities={[CAPABILITY, UNUSED_CAPABILITY]} />
      );
      expect(screen.queryByText('Add Tool')).not.toBeInTheDocument();
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      // Row data still renders
      expect(screen.getByText('Send Email')).toBeInTheDocument();
    });

    it('hides row Edit and Remove but keeps row data, and the switch is disabled', async () => {
      const { unmount } = render(<McpToolsList initialTools={[TOOL]} capabilities={[]} />);
      expect(screen.getByRole('button', { name: /edit send email/i })).toBeInTheDocument();
      expect(screen.getByText('Remove')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: /enable send email/i })).toBeEnabled();
      unmount();

      renderReadOnly(<McpToolsList initialTools={[TOOL_WITH_OVERRIDES]} capabilities={[]} />);
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Remove')).not.toBeInTheDocument();
      expect(screen.getByText('custom_send')).toBeInTheDocument();
      expect(screen.getByText('30/min')).toBeInTheDocument();

      const toggle = screen.getByRole('switch', { name: /enable send email/i });
      expect(toggle).toBeDisabled();
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(apiClient.patch).not.toHaveBeenCalled();
      expect(apiClient.post).not.toHaveBeenCalled();
      expect(apiClient.delete).not.toHaveBeenCalled();
    });
  });
});
