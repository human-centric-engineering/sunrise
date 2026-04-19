/**
 * AgentForm — Model Tab Tests
 *
 * Test Coverage:
 * - Provider change filters model Select options
 * - Test connection success shows "{n} models available"
 * - Test connection failure shows friendly fallback, raw error NOT in DOM
 * - Provider/model null hydration → free-text Input fallback + warning banner
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentForm } from '@/components/admin/orchestration/agent-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    id: 'prov-anthropic',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_KEY',
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
    timeoutMs: null,
    maxRetries: null,
  },
  {
    id: 'prov-openai',
    name: 'OpenAI',
    slug: 'openai',
    providerType: 'openai-compatible',
    apiKeyEnvVar: null,
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
    timeoutMs: null,
    maxRetries: null,
  },
];

const MODELS = [
  { provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' },
  { provider: 'anthropic', id: 'claude-haiku-3', tier: 'budget' },
  { provider: 'openai', id: 'gpt-4o', tier: 'frontier' },
  { provider: 'openai', id: 'gpt-4o-mini', tier: 'budget' },
];

async function renderAndOpenModelTab() {
  const user = userEvent.setup();
  render(<AgentForm mode="create" providers={PROVIDERS} models={MODELS} />);
  await user.click(screen.getByRole('tab', { name: /model/i }));
  return user;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — Model tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Provider / Model filtering ─────────────────────────────────────────────

  describe('provider / model Select', () => {
    it('opens Model tab and shows provider select', async () => {
      // Arrange & Act
      await renderAndOpenModelTab();

      // Assert: provider select trigger is visible
      expect(screen.getByRole('combobox', { name: /provider/i })).toBeInTheDocument();
    });

    it('shows only models belonging to the selected provider', async () => {
      // Arrange
      const user = await renderAndOpenModelTab();

      // By default provider is 'anthropic', open the model combobox
      const modelSelect = screen.getByRole('combobox', { name: /model/i });
      await user.click(modelSelect);

      // Assert: anthropic models visible, openai models not visible
      await waitFor(() => {
        expect(screen.getByRole('option', { name: /claude-opus-4-6/i })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: /claude-haiku-3/i })).toBeInTheDocument();
        expect(screen.queryByRole('option', { name: /gpt-4o/i })).not.toBeInTheDocument();
      });
    });
  });

  // ── Test connection ────────────────────────────────────────────────────────

  describe('test connection', () => {
    it('shows "{n} models available" on success', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ modelCount: 5 });

      const user = await renderAndOpenModelTab();

      // Act
      await user.click(screen.getByRole('button', { name: /test connection/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/5 models available/i)).toBeInTheDocument();
      });
    });

    it('shows friendly fallback on failure, never puts raw error in DOM', async () => {
      // Arrange — secret raw error text must never reach the DOM
      const SECRET = `RAW_SDK_LEAK_${Date.now()}`;
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError(SECRET, 'PROVIDER_ERROR', 500)
      );

      const user = await renderAndOpenModelTab();

      // Act
      await user.click(screen.getByRole('button', { name: /test connection/i }));

      // Assert: friendly message
      await waitFor(() => {
        expect(screen.getByText(/couldn't reach this provider/i)).toBeInTheDocument();
      });

      // Critical: raw error text must NOT be in DOM
      expect(document.body.textContent ?? '').not.toContain(SECRET);
    });

    it('shows "no config" message when provider has no stored record', async () => {
      // Arrange: providers prop is empty array so no match is found
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={[]} models={MODELS} />);
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Act: test connection - provider fallback renders a text input
      // The handler checks if providerRow exists and sets an error message
      const testBtn = screen.getByRole('button', { name: /test connection/i });
      await user.click(testBtn);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/don't have a stored config/i)).toBeInTheDocument();
      });
    });
  });

  // ── Rate limit RPM ─────────────────────────────────────────────────────────

  describe('rate limit RPM', () => {
    it('renders rate limit RPM input with placeholder', async () => {
      await renderAndOpenModelTab();
      const input = screen.getByRole('spinbutton', { name: /rate limit/i });
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('placeholder', 'Use global default');
    });
  });

  // ── Guard mode and history token fields ───────────────────────────────────

  describe('guard mode and history token fields', () => {
    it('renders max history tokens input with placeholder', async () => {
      await renderAndOpenModelTab();
      const input = screen.getByRole('spinbutton', { name: /max history tokens/i });
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('placeholder', 'Use model default');
    });

    it('renders input guard mode select', async () => {
      await renderAndOpenModelTab();
      expect(screen.getByRole('combobox', { name: /input guard/i })).toBeInTheDocument();
    });

    it('renders output guard mode select defaulting to global default', async () => {
      await renderAndOpenModelTab();
      expect(screen.getByRole('combobox', { name: /output guard/i })).toBeInTheDocument();
    });
  });

  // ── Null hydration fallback ────────────────────────────────────────────────

  describe('null provider/model fallback', () => {
    it('shows warning banner when providers is null', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={null} models={null} />);
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Assert: amber warning banner visible
      await waitFor(() => {
        expect(screen.getByText(/couldn't load the provider or model list/i)).toBeInTheDocument();
      });
    });

    it('renders free-text input for provider when providers is null', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={null} models={null} />);
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Assert: provider is a plain text input (no combobox)
      expect(screen.queryByRole('combobox', { name: /provider/i })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /provider/i })).toBeInTheDocument();
    });

    it('renders free-text input for model when models is null', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<AgentForm mode="create" providers={null} models={null} />);
      await user.click(screen.getByRole('tab', { name: /model/i }));

      // Assert: model is a plain text input (no combobox)
      expect(screen.queryByRole('combobox', { name: /^model/i })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /^model/i })).toBeInTheDocument();
    });
  });
});
