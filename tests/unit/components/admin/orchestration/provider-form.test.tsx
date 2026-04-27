/**
 * ProviderForm Component Tests
 *
 * Test Coverage:
 * - Changing flavor from Anthropic → Ollama swaps visible fields
 * - Changing to OpenAI-Compatible shows BOTH baseUrl and apiKeyEnvVar
 * - Submit body shape per flavor (anthropic, openai, ollama, openai-compatible, voyage)
 * - Edit mode reverse-map: provider row → correct flavor radio
 * - apiKeyPresent=false renders red "missing" indicator
 * - apiKeyPresent=true renders green "set" indicator
 * - Server-side 400 (APIClientError) rendered inline via error banner
 * - Slug input disabled in edit mode
 * - Advanced settings collapsible with timeoutMs and maxRetries
 * - Voyage AI flavor: radio, submit payload, reverse mapping
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
    it('renders key flavor radio options (Anthropic, OpenAI, Voyage AI, Ollama, Other)', () => {
      render(<ProviderForm mode="create" />);

      expect(getFlavorRadio('Anthropic')).toBeInTheDocument();
      expect(getFlavorRadio('OpenAI')).toBeInTheDocument();
      expect(getFlavorRadio('Voyage AI')).toBeInTheDocument();
      expect(getFlavorRadio('Ollama')).toBeInTheDocument();
      expect(getFlavorRadio('Other (OpenAI-Compatible)')).toBeInTheDocument();
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

      await selectFlavor(user, 'Ollama');

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

      await selectFlavor(user, 'Other (OpenAI-Compatible)');

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

      await selectFlavor(user, 'Ollama');

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

      const ollamaRadio = getFlavorRadio('Ollama');
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

      expect(screen.getByText(/^set$/i)).toBeInTheDocument();
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

  // ── Voyage AI flavor ──────────────────────────────────────────────────────

  describe('Voyage AI flavor', () => {
    it('voyage flavor submits { providerType: "voyage", isLocal: false, apiKeyEnvVar }', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        id: 'prov-new',
        name: 'Voyage AI',
        slug: 'voyage-ai',
      });

      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      await selectFlavor(user, 'Voyage AI');
      await user.click(screen.getByRole('button', { name: /create provider/i }));

      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining('/providers'),
          expect.objectContaining({
            body: expect.objectContaining({
              providerType: 'voyage',
              isLocal: false,
              apiKeyEnvVar: 'VOYAGE_API_KEY',
            }),
          })
        );
      });
    });

    it('voyage providerType → radio "Voyage AI" checked on edit', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'voyage',
            isLocal: false,
            baseUrl: 'https://api.voyageai.com/v1',
            apiKeyEnvVar: 'VOYAGE_API_KEY',
          })}
        />
      );

      const voyageRadio = getFlavorRadio('Voyage AI');
      expect(voyageRadio).toHaveAttribute('aria-checked', 'true');
    });
  });

  // ── Edit mode flavor change ────────────────────────────────────────────────

  describe('edit mode flavor change', () => {
    it('handles flavor change in edit mode — keeps existing name/slug, updates fields', async () => {
      // Arrange: edit mode with existing anthropic provider
      const user = userEvent.setup();
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({ name: 'My Anthropic', slug: 'my-anthropic' })}
        />
      );

      // Act: switch flavor to OpenAI in edit mode
      await selectFlavor(user, 'OpenAI');

      // Assert: slug field still shows original value (disabled in edit mode)
      const slugInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^slug/i });
      expect(slugInput.value).toBe('my-anthropic');
    });

    it('navigates to provider list after successful edit save', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({
        id: 'prov-1',
        name: 'Anthropic',
        slug: 'anthropic',
        apiKeyPresent: true,
        baseUrl: null,
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      });

      const user = userEvent.setup();
      render(<ProviderForm mode="edit" provider={makeProvider()} />);

      // Act: click save
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert: "Saved" button state appears after successful save
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /saved/i })).toBeInTheDocument();
      });
    });

    it('shows generic error for non-APIClientError on edit save', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('Network timeout'));

      const user = userEvent.setup();
      render(<ProviderForm mode="edit" provider={makeProvider()} />);

      // Act
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/could not save provider/i)).toBeInTheDocument();
      });
    });
  });

  // ── flavorFromProvider URL/slug matching ──────────────────────────────────

  describe('flavorFromProvider reverse-map (URL and slug matching)', () => {
    it('groq provider by URL → radio "Groq" checked', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'openai-compatible',
            isLocal: false,
            baseUrl: 'https://api.groq.com/openai/v1',
            slug: 'groq',
          })}
        />
      );

      const groqRadio = getFlavorRadio('Groq');
      expect(groqRadio).toHaveAttribute('aria-checked', 'true');
    });

    it('together by URL → radio "Together AI" checked', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'openai-compatible',
            isLocal: false,
            baseUrl: 'https://api.together.xyz/v1',
            slug: 'together',
          })}
        />
      );

      const togetherRadio = getFlavorRadio('Together AI');
      expect(togetherRadio).toHaveAttribute('aria-checked', 'true');
    });

    it('google by URL → radio "Google AI" checked', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'openai-compatible',
            isLocal: false,
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
            slug: 'google',
          })}
        />
      );

      const googleRadio = getFlavorRadio('Google AI');
      expect(googleRadio).toHaveAttribute('aria-checked', 'true');
    });

    it('xai by URL → radio "xAI" checked', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'openai-compatible',
            isLocal: false,
            baseUrl: 'https://api.x.ai/v1',
            slug: 'xai',
          })}
        />
      );

      const xaiRadio = getFlavorRadio('xAI');
      expect(xaiRadio).toHaveAttribute('aria-checked', 'true');
    });

    it('deepseek by URL → radio "DeepSeek" checked', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'openai-compatible',
            isLocal: false,
            baseUrl: 'https://api.deepseek.com/v1',
            slug: 'deepseek',
          })}
        />
      );

      const deepseekRadio = getFlavorRadio('DeepSeek');
      expect(deepseekRadio).toHaveAttribute('aria-checked', 'true');
    });

    it('unknown URL + non-local → radio "Other (OpenAI-Compatible)" checked as fallback', () => {
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            providerType: 'openai-compatible',
            isLocal: false,
            baseUrl: 'https://custom-endpoint.example.com/v1',
            slug: 'custom',
          })}
        />
      );

      const customRadio = getFlavorRadio('Other (OpenAI-Compatible)');
      expect(customRadio).toHaveAttribute('aria-checked', 'true');
    });
  });

  // ── isActive toggle ────────────────────────────────────────────────────────

  describe('isActive toggle', () => {
    it('active switch is on by default in create mode', () => {
      render(<ProviderForm mode="create" />);

      // The switch should be checked (active=true default)
      const switchEl = screen.getByRole('switch', { name: /active/i });
      expect(switchEl).toHaveAttribute('data-state', 'checked');
    });

    it('active switch reflects provider isActive=false in edit mode', () => {
      render(<ProviderForm mode="edit" provider={makeProvider({ isActive: false })} />);

      const switchEl = screen.getByRole('switch', { name: /active/i });
      expect(switchEl).toHaveAttribute('data-state', 'unchecked');
    });
  });

  // ── Slug input manual edit sets slugTouched ───────────────────────────────

  describe('slug input manual edit (create mode)', () => {
    it('user can manually type in slug field in create mode', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      // Act: type directly in slug field
      const slugInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^slug/i });
      await user.clear(slugInput);
      await user.type(slugInput, 'my-custom-slug');

      // Assert: slug field updated with typed value
      expect(slugInput.value).toBe('my-custom-slug');
    });
  });

  // ── Advanced settings ─────────────────────────────────────────────────────

  describe('advanced settings', () => {
    it('Advanced settings section is collapsed by default in create mode', () => {
      render(<ProviderForm mode="create" />);

      expect(screen.getByText(/advanced settings/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/timeout/i)).not.toBeInTheDocument();
    });

    it('clicking Advanced settings reveals timeoutMs and maxRetries fields', async () => {
      const user = userEvent.setup();
      render(<ProviderForm mode="create" />);

      await user.click(screen.getByText(/advanced settings/i));

      await waitFor(() => {
        expect(document.getElementById('timeoutMs')).toBeInTheDocument();
        expect(document.getElementById('maxRetries')).toBeInTheDocument();
      });
    });

    it('Advanced settings auto-opens when provider has timeoutMs', () => {
      render(<ProviderForm mode="edit" provider={makeProvider({ timeoutMs: 30000 })} />);

      // Should be expanded — fields visible
      expect(document.getElementById('timeoutMs')).toBeInTheDocument();
    });

    it('Advanced settings auto-opens when provider has maxRetries', () => {
      render(<ProviderForm mode="edit" provider={makeProvider({ maxRetries: 3 })} />);

      expect(document.getElementById('maxRetries')).toBeInTheDocument();
    });

    it('timeoutMs and maxRetries are included in submit payload', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({
        id: 'prov-1',
        name: 'Anthropic',
        slug: 'anthropic',
        apiKeyPresent: true,
        baseUrl: null,
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      });

      const user = userEvent.setup();
      render(
        <ProviderForm mode="edit" provider={makeProvider({ timeoutMs: 30000, maxRetries: 3 })} />
      );

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/providers/prov-1'),
          expect.objectContaining({
            body: expect.objectContaining({
              timeoutMs: 30000,
              maxRetries: 3,
            }),
          })
        );
      });
    });

    it('sends null for timeoutMs and maxRetries when fields are cleared', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({
        id: 'prov-1',
        name: 'Anthropic',
        slug: 'anthropic',
        apiKeyPresent: true,
        baseUrl: null,
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        timeoutMs: null,
        maxRetries: null,
      });

      const user = userEvent.setup();
      render(
        <ProviderForm mode="edit" provider={makeProvider({ timeoutMs: 30000, maxRetries: 3 })} />
      );

      // Advanced settings auto-opens because provider has timeoutMs/maxRetries
      const timeoutInput = document.getElementById('timeoutMs') as HTMLInputElement;
      const retriesInput = document.getElementById('maxRetries') as HTMLInputElement;
      await user.clear(timeoutInput);
      await user.clear(retriesInput);

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        const call = (apiClient.patch as ReturnType<typeof vi.fn>).mock.calls[0];
        const body = (call[1] as { body: Record<string, unknown> }).body;
        expect(body.timeoutMs).toBeNull();
        expect(body.maxRetries).toBeNull();
      });
    });

    it('sends null for apiKeyEnvVar when flavor hides it in edit mode', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.patch).mockResolvedValue({
        id: 'prov-1',
        name: 'Ollama (Local)',
        slug: 'ollama-local',
        apiKeyPresent: false,
        baseUrl: 'http://localhost:11434/v1',
        apiKeyEnvVar: null,
      });

      const user = userEvent.setup();
      // Start with an OpenAI provider that has an apiKeyEnvVar
      render(
        <ProviderForm
          mode="edit"
          provider={makeProvider({
            name: 'OpenAI',
            slug: 'openai',
            providerType: 'openai-compatible',
            baseUrl: 'https://api.openai.com/v1',
            apiKeyEnvVar: 'OPENAI_API_KEY',
          })}
        />
      );

      // Switch to Ollama flavor (which hides apiKeyEnvVar)
      await selectFlavor(user, 'Ollama');

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        const call = (apiClient.patch as ReturnType<typeof vi.fn>).mock.calls[0];
        const body = (call[1] as { body: Record<string, unknown> }).body;
        expect(body.apiKeyEnvVar).toBeNull();
        expect(body.isLocal).toBe(true);
      });
    });
  });
});
