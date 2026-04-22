/**
 * McpKeysList Component Tests
 *
 * Test Coverage:
 * - Renders empty state when no keys
 * - Renders key rows with all columns (name, prefix, scopes, status, expiry, rate limit, dates)
 * - Shows expired badge for expired keys
 * - Create dialog renders with all fields (name, scopes, expiry, rate limit)
 * - Shows plaintext key after creation
 * - Revoke calls apiClient.patch
 * - Rotate calls apiClient.post and shows rotated plaintext
 * - Scope toggle via toggleScope
 * - Create happy path with default scopes
 * - Create with optional fields (expiry + rate limit)
 * - Create button disabled when name is empty or scopes are zero
 * - Post-create state reset
 * - Revoke silent failure
 * - Rotate silent failure
 * - Rotate loading state
 *
 * @see components/admin/orchestration/mcp/mcp-keys-list.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { apiClient } from '@/lib/api/client';
import { McpKeysList } from '@/components/admin/orchestration/mcp/mcp-keys-list';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ACTIVE_KEY = {
  id: 'key-1',
  name: 'Claude Desktop',
  keyPrefix: 'smcp_abc',
  scopes: ['tools:list', 'tools:execute'],
  isActive: true,
  expiresAt: null,
  lastUsedAt: '2026-04-19T10:00:00.000Z',
  rateLimitOverride: null,
  createdAt: '2026-04-01T00:00:00.000Z',
  creator: { name: 'Admin', email: 'admin@test.com' },
};

const EXPIRED_KEY = {
  ...ACTIVE_KEY,
  id: 'key-2',
  name: 'Old Key',
  keyPrefix: 'smcp_old',
  expiresAt: '2025-01-01T00:00:00.000Z', // in the past
};

const KEY_WITH_RATE_LIMIT = {
  ...ACTIVE_KEY,
  id: 'key-3',
  name: 'Rate Limited Key',
  keyPrefix: 'smcp_rl',
  rateLimitOverride: 120,
};

// A fixture that satisfies apiKeyRowSchema (used after create/rotate refetch)
const NEW_KEY_ROW = {
  id: 'key-new',
  name: 'My Key',
  keyPrefix: 'smcp_live_xyz',
  scopes: ['tools:list', 'tools:execute'],
  isActive: true,
  expiresAt: null,
  lastUsedAt: null,
  rateLimitOverride: null,
  createdAt: '2026-04-22T00:00:00.000Z',
  creator: { name: 'Admin', email: 'admin@test.com' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function openCreateDialog() {
  await act(async () => {
    fireEvent.click(screen.getByText('Create API Key'));
  });
  // Dialog is a Radix portal — use document.body scope
  return within(document.body);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpKeysList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Empty state', () => {
    it('renders empty state message when no keys', () => {
      render(<McpKeysList initialKeys={[]} />);
      expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument();
    });
  });

  describe('Key rows', () => {
    it('renders key name and prefix', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
      expect(screen.getByText('smcp_abc...')).toBeInTheDocument();
    });

    it('renders scope badges', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('tools:list')).toBeInTheDocument();
      expect(screen.getByText('tools:execute')).toBeInTheDocument();
    });

    it('renders Active badge for active key', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('renders Expired badge for expired key', () => {
      render(<McpKeysList initialKeys={[EXPIRED_KEY]} />);
      expect(screen.getByText('Expired')).toBeInTheDocument();
    });

    it('renders rate limit override when set', () => {
      render(<McpKeysList initialKeys={[KEY_WITH_RATE_LIMIT]} />);
      expect(screen.getByText('120/min')).toBeInTheDocument();
    });

    it('renders "default" when no rate limit override', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('default')).toBeInTheDocument();
    });

    it('renders expiry date when set', () => {
      render(<McpKeysList initialKeys={[EXPIRED_KEY]} />);
      // The date rendering depends on locale, but should not be '—'
      const cells = screen.getAllByText(/2025|1\/1/);
      expect(cells.length).toBeGreaterThan(0);
    });

    it('renders "—" when no expiry', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      // Multiple '—' cells exist, just check at least one
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThan(0);
    });
  });

  describe('Actions', () => {
    it('renders Revoke and Rotate buttons for active keys', () => {
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);
      expect(screen.getByText('Revoke')).toBeInTheDocument();
      expect(screen.getByText('Rotate')).toBeInTheDocument();
    });

    it('does not render action buttons for inactive keys', () => {
      const revoked = { ...ACTIVE_KEY, isActive: false };
      render(<McpKeysList initialKeys={[revoked]} />);
      expect(screen.queryByText('Revoke')).not.toBeInTheDocument();
      expect(screen.queryByText('Rotate')).not.toBeInTheDocument();
    });

    it('calls apiClient.patch when Revoke is clicked', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Revoke'));
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/keys/key-1'),
          expect.objectContaining({ body: { isActive: false } })
        );
      });
    });

    it('calls apiClient.post when Rotate is clicked and shows plaintext', async () => {
      vi.mocked(apiClient.post).mockResolvedValue({ plaintextKey: 'smcp_new_rotated_key' });
      vi.mocked(apiClient.get).mockResolvedValue([ACTIVE_KEY]);

      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Rotate'));
      });

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/keys/key-1/rotate')
        );
      });

      await waitFor(() => {
        expect(screen.getByText('Key Rotated')).toBeInTheDocument();
        expect(screen.getByText('smcp_new_rotated_key')).toBeInTheDocument();
      });
    });
  });

  describe('Create dialog', () => {
    it('opens create dialog with name, scopes, expiry, and rate limit fields', async () => {
      render(<McpKeysList initialKeys={[]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Create API Key'));
      });

      expect(screen.getByText('Create MCP API Key')).toBeInTheDocument();
      expect(document.getElementById('key-name')).toBeInTheDocument();
      expect(document.getElementById('key-expiry')).toBeInTheDocument();
      expect(document.getElementById('key-rate-limit')).toBeInTheDocument();
    });

    // ── New: Scope toggle ───────────────────────────────────────────────────

    it('unchecking tools:list scope toggles checkbox to unchecked', async () => {
      render(<McpKeysList initialKeys={[]} />);
      const body = await openCreateDialog();

      // tools:list is checked by default
      const toolsListCheckbox = body.getByRole('checkbox', { name: /tools:list/i });
      expect(toolsListCheckbox).toBeChecked();

      // Uncheck it
      await act(async () => {
        fireEvent.click(toolsListCheckbox);
      });

      expect(toolsListCheckbox).not.toBeChecked();
    });

    // ── New: Create happy path ──────────────────────────────────────────────

    it('calls apiClient.post with name and default scopes on create, then shows plaintext', async () => {
      vi.mocked(apiClient.post).mockResolvedValueOnce({ plaintext: 'smcp_live_xyz' });
      vi.mocked(apiClient.get).mockResolvedValueOnce([NEW_KEY_ROW]);

      render(<McpKeysList initialKeys={[]} />);
      const user = userEvent.setup();
      const body = await openCreateDialog();

      // Fill name
      await user.type(body.getByRole('textbox', { name: /name/i }), 'My Key');

      // Click "Create Key"
      await act(async () => {
        fireEvent.click(body.getByRole('button', { name: /create key/i }));
      });

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/keys'),
          expect.objectContaining({
            body: { name: 'My Key', scopes: ['tools:list', 'tools:execute'] },
          })
        );
      });

      // Plaintext shown in dialog
      await waitFor(() => {
        expect(within(document.body).getByText('smcp_live_xyz')).toBeInTheDocument();
        expect(within(document.body).getByText('API Key Created')).toBeInTheDocument();
      });
    });

    // ── New: Create with optional fields ───────────────────────────────────

    it('includes expiresAt and rateLimitOverride as number when filled', async () => {
      vi.mocked(apiClient.post).mockResolvedValueOnce({ plaintext: 'smcp_live_abc' });
      vi.mocked(apiClient.get).mockResolvedValueOnce([NEW_KEY_ROW]);

      render(<McpKeysList initialKeys={[]} />);
      const user = userEvent.setup();
      const body = await openCreateDialog();

      // Fill name
      await user.type(body.getByRole('textbox', { name: /name/i }), 'My Key');

      // Fill expiry
      const expiryInput = document.getElementById('key-expiry') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(expiryInput, { target: { value: '2026-05-01T10:00' } });
      });

      // Fill rate limit
      const rateLimitInput = document.getElementById('key-rate-limit') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(rateLimitInput, { target: { value: '120' } });
      });

      await act(async () => {
        fireEvent.click(body.getByRole('button', { name: /create key/i }));
      });

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/keys'),
          expect.objectContaining({
            body: expect.objectContaining({
              expiresAt: '2026-05-01T10:00',
              rateLimitOverride: 120, // number, not string
            }),
          })
        );
      });
    });

    // ── New: Create button disabled until name is filled ────────────────────

    it('Create Key button is disabled when name is empty and enabled after typing', async () => {
      render(<McpKeysList initialKeys={[]} />);
      const user = userEvent.setup();
      const body = await openCreateDialog();

      const createBtn = body.getByRole('button', { name: /create key/i });

      // Initially disabled (name is empty)
      expect(createBtn).toBeDisabled();

      // Type a name
      await user.type(body.getByRole('textbox', { name: /name/i }), 'Test');

      // Now enabled
      expect(createBtn).not.toBeDisabled();
    });

    it('Create Key button stays disabled for whitespace-only name', async () => {
      render(<McpKeysList initialKeys={[]} />);
      const user = userEvent.setup();
      const body = await openCreateDialog();

      const createBtn = body.getByRole('button', { name: /create key/i });

      await user.type(body.getByRole('textbox', { name: /name/i }), '   ');

      // .trim() === '' so still disabled
      expect(createBtn).toBeDisabled();
    });

    // ── New: Create button disabled when zero scopes selected ───────────────

    it('Create Key button is disabled when all scopes are unchecked', async () => {
      render(<McpKeysList initialKeys={[]} />);
      const user = userEvent.setup();
      const body = await openCreateDialog();

      // Type a name so the only remaining guard is zero scopes
      await user.type(body.getByRole('textbox', { name: /name/i }), 'My Key');

      // Uncheck all scopes — ALL_MCP_SCOPES has 4 scopes
      const checkboxes = body.getAllByRole('checkbox');
      for (const cb of checkboxes) {
        if ((cb as HTMLInputElement).checked) {
          await act(async () => {
            fireEvent.click(cb);
          });
        }
      }

      expect(body.getByRole('button', { name: /create key/i })).toBeDisabled();
    });

    // ── New: Post-create refetch + state reset ──────────────────────────────

    it('after closing plaintext view, dialog re-opens with empty name and default scopes', async () => {
      vi.mocked(apiClient.post).mockResolvedValueOnce({ plaintext: 'smcp_live_xyz' });
      vi.mocked(apiClient.get).mockResolvedValueOnce([NEW_KEY_ROW]);

      render(<McpKeysList initialKeys={[]} />);
      const user = userEvent.setup();

      // Open and create a key
      const body = await openCreateDialog();
      await user.type(body.getByRole('textbox', { name: /name/i }), 'My Key');
      await act(async () => {
        fireEvent.click(body.getByRole('button', { name: /create key/i }));
      });

      // Wait for plaintext view
      await waitFor(() => {
        expect(within(document.body).getByText('API Key Created')).toBeInTheDocument();
      });

      // Close dialog via ESC
      await act(async () => {
        fireEvent.keyDown(document.body, { key: 'Escape' });
      });

      // Wait for dialog to close
      await waitFor(() => {
        expect(within(document.body).queryByText('API Key Created')).not.toBeInTheDocument();
      });

      // Re-open dialog
      const body2 = await openCreateDialog();

      // Name should be empty
      const nameInput = body2.getByRole('textbox', { name: /name/i });
      expect((nameInput as HTMLInputElement).value).toBe('');

      // Default scopes restored: tools:list and tools:execute checked
      const toolsListCb = body2.getByRole('checkbox', { name: /tools:list/i });
      const toolsExecCb = body2.getByRole('checkbox', { name: /tools:execute/i });
      expect(toolsListCb).toBeChecked();
      expect(toolsExecCb).toBeChecked();
    });

    // ── New: Revoke silent failure ──────────────────────────────────────────

    it('when apiClient.patch rejects, row stays Active (no crash, no Revoked badge)', async () => {
      vi.mocked(apiClient.patch).mockRejectedValueOnce(new Error('network error'));
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Revoke'));
      });

      // Wait for promise to settle
      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledTimes(1);
      });

      // Row still shows Active, never Revoked
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.queryByText('Revoked')).not.toBeInTheDocument();
    });

    // ── New: Rotate silent failure ──────────────────────────────────────────

    it('when rotate apiClient.post rejects, rotated plaintext dialog does NOT open', async () => {
      vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('rotate error'));
      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Rotate'));
      });

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledTimes(1);
      });

      expect(screen.queryByText('Key Rotated')).not.toBeInTheDocument();
    });

    // ── New: Rotate loading state ───────────────────────────────────────────

    it('shows "Rotating..." on Rotate button while post is pending, resets when resolved', async () => {
      // Deferred promise — we control when it resolves
      let resolveRotate!: (v: unknown) => void;
      const pendingRotate = new Promise((res) => {
        resolveRotate = res;
      });

      vi.mocked(apiClient.post).mockReturnValueOnce(pendingRotate as any);
      vi.mocked(apiClient.get).mockResolvedValueOnce([ACTIVE_KEY]);

      render(<McpKeysList initialKeys={[ACTIVE_KEY]} />);

      // Click rotate — do NOT await; we want the component in the loading state
      act(() => {
        fireEvent.click(screen.getByText('Rotate'));
      });

      // While pending, the button text should change to "Rotating..."
      await waitFor(() => {
        expect(screen.getByText('Rotating...')).toBeInTheDocument();
      });

      // Resolve the promise
      await act(async () => {
        resolveRotate({ plaintextKey: 'smcp_rotated_final' });
        // Flush all pending microtasks
        await Promise.resolve();
      });

      // After resolution, button goes back to "Rotate" (rotatingId is null)
      await waitFor(() => {
        expect(screen.queryByText('Rotating...')).not.toBeInTheDocument();
        expect(screen.getByText('Rotate')).toBeInTheDocument();
      });
    });
  });
});
