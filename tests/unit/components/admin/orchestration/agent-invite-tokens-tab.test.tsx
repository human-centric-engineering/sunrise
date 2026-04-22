/**
 * AgentInviteTokensTab Tests
 *
 * Test Coverage:
 * - Loading spinner shown while fetch is in progress
 * - Empty state when no tokens exist
 * - Token list renders label, truncated token, status badge, usage, expiry, created date
 * - Status badge variants: active, revoked, expired, exhausted
 * - "No label" italic placeholder for unlabelled tokens
 * - Active token count / total summary line
 * - Create token button opens dialog
 * - Create flow: POST with label / maxUses / expiresAt, dialog closes, list refetches
 * - Create with all fields blank (minimal body) still calls POST
 * - Revoke button visible only for active tokens, calls DELETE then refetches
 * - Copy-to-clipboard button copies full token and shows "Copied" feedback
 * - Error banner on initial fetch failure (APIClientError)
 * - Error banner on create failure
 * - Error banner on revoke failure
 *
 * @see components/admin/orchestration/agent-invite-tokens-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  // Match the real APIClientError signature: (message, code?, status?, details?)
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code?: string,
      public status?: number,
      public details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        agentInviteTokens: (id: string) => `/api/v1/admin/orchestration/agents/${id}/invite-tokens`,
        agentInviteTokenById: (id: string, tokenId: string) =>
          `/api/v1/admin/orchestration/agents/${id}/invite-tokens/${tokenId}`,
      },
    },
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { apiClient, APIClientError } from '@/lib/api/client';
import { AgentInviteTokensTab } from '@/components/admin/orchestration/agent-invite-tokens-tab';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_ID = 'agent-abc-123';

// A future date so it is not expired in tests
const FUTURE_DATE = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
// A past date so it reads as expired
const PAST_DATE = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();

const TOKEN_ACTIVE = {
  id: 'tok-active',
  token: 'abcdefgh12345678',
  label: 'Acme Corp',
  maxUses: 10,
  useCount: 3,
  expiresAt: FUTURE_DATE,
  revokedAt: null,
  createdBy: 'user-1',
  createdAt: '2026-01-01T00:00:00Z',
};

const TOKEN_REVOKED = {
  id: 'tok-revoked',
  token: 'xxxxxxxx99999999',
  label: 'Revoked token',
  maxUses: null,
  useCount: 0,
  expiresAt: null,
  revokedAt: '2026-02-01T00:00:00Z',
  createdBy: 'user-1',
  createdAt: '2026-01-15T00:00:00Z',
};

const TOKEN_EXPIRED = {
  id: 'tok-expired',
  token: 'expiredx00000000',
  label: null,
  maxUses: null,
  useCount: 0,
  expiresAt: PAST_DATE,
  revokedAt: null,
  createdBy: 'user-1',
  createdAt: '2026-01-10T00:00:00Z',
};

const TOKEN_EXHAUSTED = {
  id: 'tok-exhausted',
  token: 'exhstdxx11111111',
  label: 'Beta testers',
  maxUses: 5,
  useCount: 5,
  expiresAt: FUTURE_DATE,
  revokedAt: null,
  createdBy: 'user-1',
  createdAt: '2026-01-20T00:00:00Z',
};

const EMPTY_RESPONSE = { tokens: [] };
const POPULATED_RESPONSE = {
  tokens: [TOKEN_ACTIVE, TOKEN_REVOKED, TOKEN_EXPIRED, TOKEN_EXHAUSTED],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentInviteTokensTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Loading state ──────────────────────────────────────────────────────────

  describe('loading state', () => {
    it('renders a loading spinner before fetch resolves', async () => {
      // Arrange: never-resolving promise so spinner stays visible
      vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: spinner present, table not yet rendered
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  describe('empty state', () => {
    it('renders empty state message when no tokens exist', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/no invite tokens yet/i)).toBeInTheDocument();
      });
    });

    it('shows "No tokens yet" in the summary line for empty list', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: subtitle reads "No tokens yet"
      await waitFor(() => {
        expect(screen.getByText(/no tokens yet/i)).toBeInTheDocument();
      });
    });
  });

  // ── Token list rendering ───────────────────────────────────────────────────

  describe('token list rendering', () => {
    it('renders token table with column headers after fetch', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(POPULATED_RESPONSE);

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('columnheader', { name: /label/i })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: /token/i })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: /usage/i })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: /expires/i })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: /created/i })).toBeInTheDocument();
      });
    });

    it('renders token label for labelled tokens', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Acme Corp')).toBeInTheDocument();
      });
    });

    it('renders italic "No label" placeholder for unlabelled tokens', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_EXPIRED] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('No label')).toBeInTheDocument();
      });
    });

    it('renders truncated token (first 8 chars + last 4)', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: TOKEN_ACTIVE.token = 'abcdefgh12345678' → 'abcdefgh…5678'
      await waitFor(() => {
        expect(screen.getByText(/abcdefgh/)).toBeInTheDocument();
        expect(screen.getByText(/5678/)).toBeInTheDocument();
      });
    });

    it('shows usage count without cap for tokens with no maxUses', async () => {
      // Arrange: TOKEN_REVOKED has maxUses=null, useCount=0
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_REVOKED] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: just "0" with no "/ N" suffix
      await waitFor(() => {
        // The cell renders useCount without a denominator
        const rows = screen.getAllByRole('row');
        // row 0 = header, row 1 = first data row
        expect(rows[1]).toHaveTextContent('0');
        expect(rows[1]).not.toHaveTextContent('/ ');
      });
    });

    it('shows usage count with cap for tokens with maxUses', async () => {
      // Arrange: TOKEN_ACTIVE has useCount=3, maxUses=10
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: "3 / 10"
      await waitFor(() => {
        expect(screen.getByText('3 / 10')).toBeInTheDocument();
      });
    });

    it('shows "Never" expiry for tokens with no expiresAt', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_REVOKED] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Never')).toBeInTheDocument();
      });
    });

    it('shows active count and total in summary line', async () => {
      // Arrange: 1 active, 3 others (revoked / expired / exhausted)
      vi.mocked(apiClient.get).mockResolvedValue(POPULATED_RESPONSE);

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: "1 active of 4 total"
      await waitFor(() => {
        expect(screen.getByText(/1 active of 4 total/i)).toBeInTheDocument();
      });
    });
  });

  // ── Status badges ──────────────────────────────────────────────────────────

  describe('status badges', () => {
    it('renders "active" badge for an active token', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('active')).toBeInTheDocument();
      });
    });

    it('renders "revoked" badge for a revoked token', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_REVOKED] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('revoked')).toBeInTheDocument();
      });
    });

    it('renders "expired" badge for an expired token', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_EXPIRED] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('expired')).toBeInTheDocument();
      });
    });

    it('renders "exhausted" badge for a use-count-exhausted token', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_EXHAUSTED] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('exhausted')).toBeInTheDocument();
      });
    });

    it('treats revokedAt as highest-priority status (revoked wins over expired)', async () => {
      // Arrange: token is BOTH revokedAt set AND past expiresAt
      const bothRevokedAndExpired = {
        ...TOKEN_EXPIRED,
        id: 'tok-both',
        revokedAt: '2026-02-01T00:00:00Z',
      };
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [bothRevokedAndExpired] });

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: badge reads "revoked", not "expired"
      await waitFor(() => {
        expect(screen.getByText('revoked')).toBeInTheDocument();
        expect(screen.queryByText('expired')).not.toBeInTheDocument();
      });
    });
  });

  // ── Revoke button visibility ───────────────────────────────────────────────

  describe('revoke button visibility', () => {
    it('shows revoke button only for the active token', async () => {
      // Arrange: all four status types present
      vi.mocked(apiClient.get).mockResolvedValue(POPULATED_RESPONSE);

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      await waitFor(() => {
        expect(screen.getByText('active')).toBeInTheDocument();
      });

      // Assert: exactly one revoke button (only active row has it).
      // The Trash2 icon button is only rendered for active tokens.
      // Active row has 2 buttons (copy + revoke), non-active rows have 1 (copy only).
      const allRows = screen.getAllByRole('row').slice(1); // skip header
      let revokeCount = 0;
      for (const row of allRows) {
        const btns = row.querySelectorAll('button');
        // last button in each row is the optional revoke button (Trash2)
        // copy button is always present; revoke is conditional
        // active row has 2 buttons (copy + revoke), others have 1 (copy only)
        if (btns.length === 2) revokeCount++;
      }
      expect(revokeCount).toBe(1);
    });
  });

  // ── Create token flow ──────────────────────────────────────────────────────

  describe('create token flow', () => {
    it('opens create dialog when "Create token" button is clicked', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);
      const user = userEvent.setup();

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText(/no invite tokens yet/i)).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /create token/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText(/create invite token/i)).toBeInTheDocument();
      });
    });

    it('dialog contains label, max uses, and expires fields', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText(/no invite tokens yet/i)).toBeInTheDocument());

      // Act: open dialog
      await user.click(screen.getByRole('button', { name: /create token/i }));

      // Assert
      await waitFor(() => {
        expect(document.getElementById('token-label')).toBeInTheDocument();
        expect(document.getElementById('token-max-uses')).toBeInTheDocument();
        expect(document.getElementById('token-expires')).toBeInTheDocument();
      });
    });

    it('POSTs with label, maxUses, and expiresAt when all fields are filled', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);
      vi.mocked(apiClient.post).mockResolvedValue({ token: TOKEN_ACTIVE });
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText(/no invite tokens yet/i)).toBeInTheDocument());

      // Act: open dialog and fill fields
      await user.click(screen.getByRole('button', { name: /create token/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

      await user.type(document.getElementById('token-label')!, 'Test label');
      await user.type(document.getElementById('token-max-uses')!, '5');

      // Submit
      await user.click(screen.getByRole('button', { name: /^create token$/i }));

      // Assert: POST called with correct body
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          `/api/v1/admin/orchestration/agents/${AGENT_ID}/invite-tokens`,
          expect.objectContaining({
            body: expect.objectContaining({ label: 'Test label', maxUses: 5 }),
          })
        );
      });
    });

    it('POSTs with empty body when no fields are filled', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);
      vi.mocked(apiClient.post).mockResolvedValue({ token: TOKEN_ACTIVE });
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText(/no invite tokens yet/i)).toBeInTheDocument());

      // Act: open dialog and submit immediately (no fields filled)
      await user.click(screen.getByRole('button', { name: /create token/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^create token$/i }));

      // Assert: POST called with empty body object
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          `/api/v1/admin/orchestration/agents/${AGENT_ID}/invite-tokens`,
          expect.objectContaining({ body: {} })
        );
      });
    });

    it('closes dialog and refetches list after successful create', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);
      vi.mocked(apiClient.post).mockResolvedValue({ token: TOKEN_ACTIVE });
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText(/no invite tokens yet/i)).toBeInTheDocument());

      // Act: open and submit dialog
      await user.click(screen.getByRole('button', { name: /create token/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^create token$/i }));

      // Assert: dialog closes, GET called a second time (refetch)
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(apiClient.get).toHaveBeenCalledTimes(2);
      });
    });

    it('Cancel button closes the dialog without POSTing', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText(/no invite tokens yet/i)).toBeInTheDocument());

      // Act
      await user.click(screen.getByRole('button', { name: /create token/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      // Assert
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(apiClient.post).not.toHaveBeenCalled();
    });
  });

  // ── Revoke flow ────────────────────────────────────────────────────────────

  describe('revoke flow', () => {
    it('calls DELETE with correct URL when revoke button is clicked', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });
      const user = userEvent.setup();

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());

      // Locate the trash button via its destructive styling class
      const trashBtn = document.querySelector('button[class*="text-destructive"]') as HTMLElement;
      expect(trashBtn).not.toBeNull();
      await user.click(trashBtn);

      // Assert
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith(
          `/api/v1/admin/orchestration/agents/${AGENT_ID}/invite-tokens/${TOKEN_ACTIVE.id}`
        );
      });
    });

    it('refetches the list after a successful revoke', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());

      // Act
      const trashBtn = document.querySelector('button[class*="text-destructive"]') as HTMLElement;
      await user.click(trashBtn);

      // Assert: GET called twice — initial load + post-revoke refetch
      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ── Copy to clipboard ──────────────────────────────────────────────────────

  describe('copy to clipboard', () => {
    it('copies the full token (not the truncated display) to the clipboard', async () => {
      // Arrange: happy-dom provides a real clipboard implementation.
      // We verify the written value by reading it back rather than spying on
      // writeText (happy-dom's Clipboard prototype is not spy-able from the
      // outside — it uses internal Symbol-keyed state).
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });
      const user = userEvent.setup();

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());

      const copyBtn = screen.getByTitle('Copy full token');
      await user.click(copyBtn);

      // Assert: clipboard contains the FULL token, not the truncated code display
      await waitFor(async () => {
        const clipboardText = await navigator.clipboard.readText();
        expect(clipboardText).toBe(TOKEN_ACTIVE.token);
      });
    });

    it('shows "Copied" feedback text after clicking copy', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });
      const user = userEvent.setup();

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());

      await user.click(screen.getByTitle('Copy full token'));

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Copied')).toBeInTheDocument();
      });
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('shows error banner when initial fetch fails with APIClientError', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockRejectedValue(
        new APIClientError('Service unavailable', 'SERVICE_UNAVAILABLE', 503)
      );

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: error message rendered, no crash
      await waitFor(() => {
        expect(screen.getByText(/service unavailable/i)).toBeInTheDocument();
      });
    });

    it('shows generic error message when fetch throws non-APIClientError', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockRejectedValue(new Error('Network error'));

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert: falls back to generic message
      await waitFor(() => {
        expect(screen.getByText(/failed to load tokens/i)).toBeInTheDocument();
      });
    });

    it('shows error banner when create POST fails with APIClientError', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Token creation failed', 'INTERNAL_ERROR', 500)
      );
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText(/no invite tokens yet/i)).toBeInTheDocument());

      // Act
      await user.click(screen.getByRole('button', { name: /create token/i }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^create token$/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/token creation failed/i)).toBeInTheDocument();
      });
    });

    it('shows error banner when revoke DELETE fails with APIClientError', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Revoke failed', 'INTERNAL_ERROR', 500)
      );
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());

      // Act
      const trashBtn = document.querySelector('button[class*="text-destructive"]') as HTMLElement;
      await user.click(trashBtn);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/revoke failed/i)).toBeInTheDocument();
      });
    });

    it('shows generic error message when revoke throws non-APIClientError', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue({ tokens: [TOKEN_ACTIVE] });
      vi.mocked(apiClient.delete).mockRejectedValue(new Error('Unknown error'));
      const user = userEvent.setup();

      render(<AgentInviteTokensTab agentId={AGENT_ID} />);
      await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument());

      // Act
      const trashBtn = document.querySelector('button[class*="text-destructive"]') as HTMLElement;
      await user.click(trashBtn);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/failed to revoke token/i)).toBeInTheDocument();
      });
    });
  });

  // ── API call verification ──────────────────────────────────────────────────

  describe('API call verification', () => {
    it('calls GET with the correct agent invite tokens URL on mount', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);

      // Act
      render(<AgentInviteTokensTab agentId={AGENT_ID} />);

      // Assert
      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          `/api/v1/admin/orchestration/agents/${AGENT_ID}/invite-tokens`
        );
      });
    });

    it('re-fetches when agentId prop changes', async () => {
      // Arrange
      vi.mocked(apiClient.get).mockResolvedValue(EMPTY_RESPONSE);
      const { rerender } = render(<AgentInviteTokensTab agentId="agent-111" />);

      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/agents/agent-111/invite-tokens'
        );
      });

      // Act: change agentId
      rerender(<AgentInviteTokensTab agentId="agent-222" />);

      // Assert: fetched with new agent id
      await waitFor(() => {
        expect(apiClient.get).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/agents/agent-222/invite-tokens'
        );
      });
    });
  });
});
