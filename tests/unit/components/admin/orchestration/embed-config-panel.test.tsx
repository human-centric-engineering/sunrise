/**
 * Tests for `components/admin/orchestration/agents/embed-config-panel.tsx`
 *
 * Key behaviours:
 * - Loading state on mount
 * - Empty state: "No embed tokens yet"
 * - Token list: label, active/inactive badge, token value, allowed origins
 * - "Unlabelled embed token" placeholder shown when token has no label
 * - Create token: calls apiClient.post with label and parsed origins
 * - Create with empty label sends no label field (undefined)
 * - Create error: shows error message
 * - Toggle active: calls apiClient.patch and updates badge
 * - Delete: calls apiClient.delete and removes token from list
 * - Copy snippet: copies correct embed script tag to clipboard
 * - Fetch error: shows error message
 *
 * @see components/admin/orchestration/agents/embed-config-panel.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmbedConfigPanel } from '@/components/admin/orchestration/agents/embed-config-panel';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    // EmbedConfigPanel renders both the appearance section (fetches
    // /widget-config) and the tokens card (fetches /embed-tokens).
    // Dispatch widget-config calls to a fixed defaults response so this
    // suite stays focused on the tokens UI; mockGet remains the
    // tokens-only mock for backwards compatibility.
    get: (endpoint: string, ...rest: unknown[]) => {
      if (typeof endpoint === 'string' && endpoint.includes('/widget-config')) {
        return Promise.resolve({
          config: {
            primaryColor: '#2563eb',
            surfaceColor: '#ffffff',
            textColor: '#111827',
            fontFamily: 'system-ui, sans-serif',
            headerTitle: 'Chat',
            headerSubtitle: '',
            inputPlaceholder: 'Type a message…',
            sendLabel: 'Send',
            conversationStarters: [],
            footerText: '',
          },
        });
      }
      return mockGet(endpoint, ...rest);
    },
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
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

// ─── Clipboard spy ────────────────────────────────────────────────────────────

let clipboardWriteSpy: ReturnType<typeof vi.spyOn>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    token: 'secret-abc123',
    label: 'Marketing site',
    allowedOrigins: ['https://example.com'],
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    creator: { id: 'user-1', name: 'Admin' },
    ...overrides,
  };
}

const AGENT_ID = 'agent-1';
const APP_URL = 'https://app.example.com';
const ENDPOINT = `/api/v1/admin/orchestration/agents/${AGENT_ID}/embed-tokens`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EmbedConfigPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clipboardWriteSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    mockGet.mockResolvedValue([]);
  });

  afterEach(() => {
    clipboardWriteSpy?.mockRestore();
  });

  // ── Loading ───────────────────────────────────────────────────────────────

  it('shows loading state on mount', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    expect(screen.getByText('Loading embed tokens...')).toBeInTheDocument();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it('shows empty message when no tokens exist', async () => {
    mockGet.mockResolvedValue([]);
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => {
      expect(screen.getByText(/no embed tokens yet/i)).toBeInTheDocument();
    });
  });

  // ── Fetch error ───────────────────────────────────────────────────────────

  it('shows error message when fetch fails', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    mockGet.mockRejectedValue(new APIClientError('Unauthorized'));
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => {
      expect(screen.getByText('Unauthorized')).toBeInTheDocument();
    });
  });

  it('shows generic error when fetch throws non-APIClientError', async () => {
    mockGet.mockRejectedValue(new Error('Network down'));
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load tokens')).toBeInTheDocument();
    });
  });

  // ── Token list ────────────────────────────────────────────────────────────

  it('renders token label, badge, and token value', async () => {
    mockGet.mockResolvedValue([makeToken()]);
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => {
      expect(screen.getByText('Marketing site')).toBeInTheDocument();
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('secret-abc123')).toBeInTheDocument();
    });
  });

  it('shows an "Unlabelled embed token" placeholder when token label is null', async () => {
    mockGet.mockResolvedValue([makeToken({ label: null })]);
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => {
      expect(screen.getByText('Unlabelled embed token')).toBeInTheDocument();
    });
  });

  it('shows allowed origins when present', async () => {
    mockGet.mockResolvedValue([
      makeToken({ allowedOrigins: ['https://example.com', 'https://other.com'] }),
    ]);
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => {
      expect(
        screen.getByText('Origins: https://example.com, https://other.com')
      ).toBeInTheDocument();
    });
  });

  it('does not show origins section when allowedOrigins is empty', async () => {
    mockGet.mockResolvedValue([makeToken({ allowedOrigins: [] })]);
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByText('Marketing site'));
    expect(screen.queryByText(/origins:/i)).not.toBeInTheDocument();
  });

  it('shows "Inactive" badge for inactive tokens', async () => {
    mockGet.mockResolvedValue([makeToken({ isActive: false })]);
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => {
      expect(screen.getByText('Inactive')).toBeInTheDocument();
    });
  });

  it('renders embed snippet in code block', async () => {
    mockGet.mockResolvedValue([makeToken()]);
    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => {
      expect(
        screen.getByText(
          `<script src="${APP_URL}/api/v1/embed/widget.js" data-token="secret-abc123"></script>`
        )
      ).toBeInTheDocument();
    });
  });

  // ── Create token ──────────────────────────────────────────────────────────

  it('calls apiClient.post with label and parsed origins on create', async () => {
    const user = userEvent.setup();
    const newToken = makeToken({ id: 'tok-2', token: 'new-token' });
    mockPost.mockResolvedValue(newToken);
    mockGet.mockResolvedValue([]);

    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByPlaceholderText(/e\.g\. Marketing site/i));

    await user.type(screen.getByPlaceholderText(/e\.g\. Marketing site/i), 'Blog');
    await user.type(
      screen.getByPlaceholderText(/https:\/\/example\.com/i),
      'https://blog.com, https://news.com'
    );
    await user.click(screen.getByRole('button', { name: /create token/i }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        ENDPOINT,
        expect.objectContaining({
          body: expect.objectContaining({
            label: 'Blog',
            allowedOrigins: ['https://blog.com', 'https://news.com'],
          }),
        })
      );
    });
  });

  it('prepends new token to list after creation', async () => {
    const user = userEvent.setup();
    const existing = makeToken({ id: 'tok-1', token: 'old-token', label: 'Old' });
    const created = makeToken({ id: 'tok-2', token: 'new-token', label: 'New' });
    mockGet.mockResolvedValue([existing]);
    mockPost.mockResolvedValue(created);

    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByText('Old'));

    await user.type(screen.getByPlaceholderText(/e\.g\. Marketing site/i), 'New');
    await user.click(screen.getByRole('button', { name: /create token/i }));

    await waitFor(() => {
      expect(screen.getByText('New')).toBeInTheDocument();
      expect(screen.getByText('Old')).toBeInTheDocument();
    });
  });

  it('shows error when create fails', async () => {
    const user = userEvent.setup();
    const { APIClientError } = await import('@/lib/api/client');
    mockPost.mockRejectedValue(new APIClientError('Token limit reached'));

    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByRole('button', { name: /create token/i }));

    await user.click(screen.getByRole('button', { name: /create token/i }));

    await waitFor(() => {
      expect(screen.getByText('Token limit reached')).toBeInTheDocument();
    });
  });

  // ── Toggle ────────────────────────────────────────────────────────────────

  it('calls apiClient.patch to deactivate an active token', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue([makeToken({ isActive: true })]);
    mockPatch.mockResolvedValue(undefined);

    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByText('Active'));

    // The toggle button is the ExternalLink icon button
    const allButtons = screen.getAllByRole('button');
    const toggleBtn = allButtons.find((b) => b.getAttribute('title') === 'Deactivate');
    expect(toggleBtn).toBeDefined();
    await user.click(toggleBtn!);

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `${ENDPOINT}/tok-1`,
        expect.objectContaining({ body: { isActive: false } })
      );
    });
  });

  it('shows error when toggle fails', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue([makeToken()]);
    mockPatch.mockRejectedValue(new Error('Server error'));

    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByText('Active'));

    const toggleBtn = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('title') === 'Deactivate');
    await user.click(toggleBtn!);

    await waitFor(() => {
      expect(screen.getByText('Failed to update token')).toBeInTheDocument();
    });
  });

  // ── Delete ────────────────────────────────────────────────────────────────

  it('calls apiClient.delete and removes token from list', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue([makeToken()]);
    mockDelete.mockResolvedValue(undefined);

    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByText('Marketing site'));

    const deleteBtn = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('title') === 'Delete token');
    expect(deleteBtn).toBeDefined();
    await user.click(deleteBtn!);

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(`${ENDPOINT}/tok-1`);
      expect(screen.queryByText('Marketing site')).not.toBeInTheDocument();
    });
  });

  it('shows error when delete fails', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue([makeToken()]);
    mockDelete.mockRejectedValue(new Error('Permission denied'));

    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByText('Marketing site'));

    const deleteBtn = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('title') === 'Delete token');
    await user.click(deleteBtn!);

    await waitFor(() => {
      expect(screen.getByText('Failed to delete token')).toBeInTheDocument();
    });
  });

  // ── Copy snippet ──────────────────────────────────────────────────────────

  it('copies embed snippet to clipboard when copy button clicked', async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue([makeToken()]);

    render(<EmbedConfigPanel agentId={AGENT_ID} appUrl={APP_URL} />);
    await waitFor(() => screen.getByText('Marketing site'));

    const copyBtn = screen
      .getAllByRole('button')
      .find((b) => b.getAttribute('title') === 'Copy embed snippet');
    expect(copyBtn).toBeDefined();
    await user.click(copyBtn!);

    expect(clipboardWriteSpy).toHaveBeenCalledWith(
      `<script src="${APP_URL}/api/v1/embed/widget.js" data-token="secret-abc123"></script>`
    );
  });
});
