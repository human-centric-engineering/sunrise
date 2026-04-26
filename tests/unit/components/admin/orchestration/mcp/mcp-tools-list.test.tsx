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
  });
});
