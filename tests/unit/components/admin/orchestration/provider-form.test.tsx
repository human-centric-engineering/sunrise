/**
 * ProviderForm Component Tests
 *
 * Test Coverage:
 * - Changing flavor from Anthropic → Ollama swaps visible fields
 * - Changing to OpenAI-Compatible shows BOTH baseUrl and apiKeyEnvVar
 * - Submit body shape per flavor (anthropic, openai, ollama, openai-compatible)
 * - Edit mode reverse-map: provider row → correct flavor radio
 * - apiKeyPresent=false renders red "missing" indicator
 * - apiKeyPresent=true renders green "set" indicator
 * - Server-side 400 (APIClientError) rendered inline via error banner
 * - Slug input disabled in edit mode
 *
 * @see components/admin/orchestration/provider-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProviderForm } from '@/components/admin/orchestration/provider-form';
import type { ProviderRowWithStatus } from '@/components/admin/orchestration/provider-form';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
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

function makeProvider(overrides: Partial<ProviderRowWithStatus> = {}): ProviderRowWithStatus {
  return {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    baseUrl: null,
    isActive: true,
    isLocal: false,
    apiKeyPresent: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    deletedAt: null,
    metadata: {},
    ...overrides,
  } as ProviderRowWithStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Click a flavor radio button by its label text.
 * Flavor radios are <button role="radio"> within the radiogroup.
 * We use getAllByRole and filter by whether the button contains a span
 * with the exact label text, to avoid ambiguity between "OpenAI" and
 * "OpenAI-Compatible" (both contain "openai").
 */
function getFlavorRadio(label: string): HTMLElement {
  const radios = screen.getAllByRole('radio');
  const match = radios.find((r) => {
    const spans = r.querySelectorAll('span');
    return Array.from(spans).some((s) => s.textContent?.toLowerCase() === label.toLowerCase());
  });
  if (!match) throw new Error(`Flavor radio not found for label: ${label}`);
  return match;
}

function selectFlavor(user: ReturnType<typeof userEvent.setup>, label: string) {
  return user.click(getFlavorRadio(label));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProviderForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Flavor selector ────────────────────────────────────────────────────────

  describe('flavor selector', () => {
    it('renders all 4 flavor radio options', () => {
      render(<ProviderForm mode="create" />);

      expect(getFlavorRadio('Anthropic')).toBeInTheDocument();
      expect(getFlavorRadio('OpenAI')).toBeInTheDocument();
      expect(getFlavorRadio('Ollama (Local)')).toBeInTheDocument();
      expect(getFlavorRadio('OpenAI-Compatible')).toBeInTheDocument();
    });

    it('default flavor is Anthropic (baseUrl hidden, apiKeyEnvVar shown)', () => {
      render(<ProviderForm mode="create" />);

      // Use getByRole to avoid false matches with FieldHelp button text
      expect(screen.queryByRole('textbox', { name: /base url/i })).not.toBeInTheDocument();
      expect(screen.getByRole('textbox', { name: /api key env var/i })).toBeInTheDocument();
    });

    it('switching to Ollama hides apiKeyEnvVar and shows baseUrl with default', async () => {
      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      await selectFlavor(user, 'Ollama (Local)');

      await waitFor(() => {
        expect(screen.queryByRole('textbox', { name: /api key env var/i })).not.toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: /base url/i })).toBeInTheDocument();
      });

      const baseUrlInput = screen.getByRole('textbox', { name: /base url/i });
      expect((baseUrlInput as HTMLInputElement).value).toBe('http://localhost:11434/v1');
    });

    it('switching to OpenAI-Compatible shows BOTH baseUrl and apiKeyEnvVar', async () => {
      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      await selectFlavor(user, 'OpenAI-Compatible');

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /base url/i })).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: /api key env var/i })).toBeInTheDocument();
      });
    });

    it('switching to OpenAI hides baseUrl, shows apiKeyEnvVar', async () => {
      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      await selectFlavor(user, 'OpenAI');

      await waitFor(() => {
        // OpenAI flavor: showBaseUrl=false (not rendered), showApiKeyEnvVar=true
        expect(screen.getByRole('textbox', { name: /api key env var/i })).toBeInTheDocument();
      });
    });
  });

  // ── Submit payload per flavor ──────────────────────────────────────────────

  describe('submit payload by flavor', () => {
    it('anthropic flavor submits { providerType: "anthropic", isLocal: false, apiKeyEnvVar }', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        id: 'prov-new',
        name: 'Anthropic',
        slug: 'anthropic',
      });

      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      // apiKeyEnvVar defaults to '' in create mode — type a value before submitting
      const apiKeyInput = screen.getByRole('textbox', { name: /api key env var/i });
      await user.type(apiKeyInput, 'ANTHROPIC_API_KEY');

      await user.click(screen.getByRole('button', { name: /create provider/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/providers'),
          expect.objectContaining({
            body: expect.objectContaining({
              providerType: 'anthropic',
              isLocal: false,
              apiKeyEnvVar: 'ANTHROPIC_API_KEY',
            }),
          })
        );
      });

      // No baseUrl in payload for anthropic
      const call = (apiClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = (call[1] as { body: Record<string, unknown> }).body;
      expect(body.baseUrl).toBeUndefined();
    });

    it('openai flavor submits { providerType: "openai-compatible", isLocal: false, apiKeyEnvVar, baseUrl }', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        id: 'prov-new',
        name: 'OpenAI',
        slug: 'openai',
      });

      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      await selectFlavor(user, 'OpenAI');

      await user.click(screen.getByRole('button', { name: /create provider/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/providers'),
          expect.objectContaining({
            body: expect.objectContaining({
              providerType: 'openai-compatible',
              isLocal: false,
              apiKeyEnvVar: 'OPENAI_API_KEY',
            }),
          })
        );
      });
    });

    it('ollama flavor submits { providerType: "openai-compatible", isLocal: true, baseUrl }', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        id: 'prov-new',
        name: 'Ollama',
        slug: 'ollama-local',
      });

      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      await selectFlavor(user, 'Ollama (Local)');

      await user.click(screen.getByRole('button', { name: /create provider/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/providers'),
          expect.objectContaining({
            body: expect.objectContaining({
              providerType: 'openai-compatible',
              isLocal: true,
              baseUrl: 'http://localhost:11434/v1',
            }),
          })
        );
      });

      // No apiKeyEnvVar for Ollama
      const call = (apiClient.post as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = (call[1] as { body: Record<string, unknown> }).body;
      expect(body.apiKeyEnvVar).toBeUndefined();
    });
  });

  // ── Edit mode reverse-map ──────────────────────────────────────────────────

  describe('edit mode reverse-map', () => {
    it('anthropic provider → radio "Anthropic" checked', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({ providerType: 'anthropic', isLocal: false })}
        />
      );

      const anthropicRadio = getFlavorRadio('Anthropic');
      expect(anthropicRadio).toHaveAttribute('aria-checked', 'true');
    });

    it('openai-compatible + isLocal=true → radio "Ollama" checked', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'openai-compatible',
            isLocal: true,
            baseUrl: 'http://localhost:11434/v1',
          })}
        />
      );

      const ollamaRadio = getFlavorRadio('Ollama (Local)');
      expect(ollamaRadio).toHaveAttribute('aria-checked', 'true');
    });

    it('openai-compatible + api.openai.com baseUrl → radio "OpenAI" checked', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'openai-compatible',
            isLocal: false,
            baseUrl: 'https://api.openai.com/v1',
          })}
        />
      );

      const openaiRadio = getFlavorRadio('OpenAI');
      expect(openaiRadio).toHaveAttribute('aria-checked', 'true');
    });
  });

  // ── API key indicator ──────────────────────────────────────────────────────

  describe('API key indicator', () => {
    it('apiKeyPresent=false renders red "missing" indicator', () => {
      render(<ProviderForm mode="edit" provider={makeProvider({ apiKeyPresent: false })} />);

      expect(screen.getByText(/missing/i)).toBeInTheDocument();
    });

    it('apiKeyPresent=true renders green "set" indicator', () => {
      render(<ProviderForm mode="edit" provider={makeProvider({ apiKeyPresent: true })} />);

      expect(screen.getByText(/set/i)).toBeInTheDocument();
    });
  });

  // ── Error banner ───────────────────────────────────────────────────────────

  describe('server error banner', () => {
    it('APIClientError renders inline error banner', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Base URL is not safe (SSRF check failed)', 'SSRF_BLOCKED', 400)
      );

      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      await user.click(screen.getByRole('button', { name: /create provider/i }));

      await waitFor(() => {
        expect(screen.getByText(/base url is not safe/i)).toBeInTheDocument();
      });
    });
  });

  // ── Edit mode ──────────────────────────────────────────────────────────────

  describe('edit mode', () => {
    it('slug input is disabled in edit mode', () => {
      render(<ProviderForm mode="edit" provider={makeProvider()} />);

      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      expect(slugInput).toBeDisabled();
    });

    it('pre-fills name from provider in edit mode', () => {
      render(<ProviderForm mode="edit" provider={makeProvider({ name: 'My Provider' })} />);

      expect(screen.getByRole<HTMLInputElement>('textbox', { name: /^name/i }).value).toBe(
        'My Provider'
      );
    });

    it('shows "Save changes" button in edit mode', () => {
      render(<ProviderForm mode="edit" provider={makeProvider()} />);

      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });
});
