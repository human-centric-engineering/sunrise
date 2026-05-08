/**
 * ProviderTestButton Component Tests
 *
 * Test Coverage:
 * - Success → bare green check icon (model count in aria-label/title only)
 * - Server returns `{ ok: false }` → friendly fallback message
 * - Failure (thrown error) → "Couldn't reach this provider" red text; raw SDK error absent
 * - providerId===null + click → renders the disabledMessage
 * - onResult callback invoked with true on success, false on failure
 *
 * The footer success label was deliberately trimmed: the card body already
 * shows the model count, so duplicating it in the footer crowded the UI.
 *
 * @see components/admin/orchestration/provider-test-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProviderTestButton } from '@/components/admin/orchestration/provider-test-button';

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProviderTestButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Success ────────────────────────────────────────────────────────────────

  describe('success', () => {
    it('renders a bare green check icon on success — model count goes to aria-label/title', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: true,
        models: Array.from({ length: 12 }, (_, i) => `model-${i}`),
      });

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      // The model count must NOT appear as visible text in the footer
      // — the card body already renders it elsewhere. Duplicating
      // crowded the UI.
      await waitFor(() => {
        const success = screen.getByLabelText(/connection succeeded/i);
        expect(success).toBeInTheDocument();
      });
      expect(screen.queryByText(/12 models available/i)).not.toBeInTheDocument();
    });

    it('keeps the model count discoverable via aria-label and title', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: true,
        models: ['m1', 'm2', 'm3', 'm4', 'm5'],
      });

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        const success = screen.getByLabelText(/5 models available/i);
        expect(success).toBeInTheDocument();
        expect(success.getAttribute('title')).toBe('5 models available');
        expect(success.className).toContain('text-green-600');
      });
    });

    it('calls onResult({ ok: true, modelCount }) on success', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: true,
        models: ['m1', 'm2', 'm3'],
      });

      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" onResult={onResult} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith({ ok: true, modelCount: 3 });
      });
    });

    it('still resolves ok=true when the server returns an empty models list', async () => {
      // Defensive regression: a working key with zero models should
      // still render success (rare, but the count was previously the
      // signal of failure for the buggy `modelCount`-reading path).
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: true, models: [] });

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(screen.getByLabelText(/0 models available/i)).toBeInTheDocument();
      });
    });
  });

  // ── ok: false (server returned a sanitised failure) ─────────────────────────

  describe('server-reported failure', () => {
    it('renders friendly fallback when the server returns ok: false', async () => {
      const { apiClient } = await import('@/lib/api/client');
      // The /test route returns 200 with `{ ok: false, models: [], error }`
      // when the provider rejected the connection — exercise that branch
      // explicitly so a misconfigured key surfaces as red, not as
      // "0 models available" green.
      vi.mocked(apiClient.post).mockResolvedValue({
        ok: false,
        models: [],
        error: 'connection_failed',
      });

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(screen.getByText(/couldn't reach this provider/i)).toBeInTheDocument();
      });
      expect(screen.queryByText(/models available/i)).not.toBeInTheDocument();
    });
  });

  // ── Failure ────────────────────────────────────────────────────────────────

  describe('failure', () => {
    it('renders friendly fallback message on failure', async () => {
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Connection refused to upstream', 'PROVIDER_ERROR', 502)
      );

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(screen.getByText(/couldn't reach this provider/i)).toBeInTheDocument();
      });
    });

    it('raw SDK error text is NOT present in DOM on failure', async () => {
      const RAW_SDK_LEAK_SECRET = 'RAW_SDK_LEAK_SECRET_TOKEN_ABC';
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError(RAW_SDK_LEAK_SECRET, 'PROVIDER_ERROR', 500)
      );

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(screen.getByText(/couldn't reach this provider/i)).toBeInTheDocument();
      });

      expect(document.body.textContent ?? '').not.toContain(RAW_SDK_LEAK_SECRET);
    });

    it('renders red text (text-red-600 class present) on failure', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network error'));

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        const redEl = document.querySelector('.text-red-600');
        expect(redEl).toBeTruthy();
      });
    });

    it('calls onResult({ ok: false, message }) on failure', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network error'));

      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" onResult={onResult} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(
          expect.objectContaining({ ok: false, message: expect.stringMatching(/.+/) })
        );
      });
    });
  });

  // ── providerId null ────────────────────────────────────────────────────────

  describe('providerId null', () => {
    it('clicking with null providerId renders the disabledMessage', async () => {
      const { apiClient } = await import('@/lib/api/client');

      const user = userEvent.setup();
      render(
        <ProviderTestButton
          providerId={null}
          disabledMessage="No saved provider config — save it first."
        />
      );

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(screen.getByText(/no saved provider config/i)).toBeInTheDocument();
      });

      // Should NOT make an API call
      expect(apiClient.post).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    });

    it('calls onResult({ ok: false, message }) when providerId is null', async () => {
      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ProviderTestButton providerId={null} onResult={onResult} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(
          expect.objectContaining({ ok: false, message: expect.stringMatching(/.+/) })
        );
      });
    });

    it('uses default disabledMessage when none is provided', async () => {
      const user = userEvent.setup();
      render(<ProviderTestButton providerId={null} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(screen.getByText(/no saved provider config/i)).toBeInTheDocument();
      });
    });
  });

  // ── Button state ───────────────────────────────────────────────────────────

  describe('button state', () => {
    it('button is enabled by default', () => {
      render(<ProviderTestButton providerId="prov-1" />);

      expect(screen.getByRole('button', { name: /test connection/i })).not.toBeDisabled();
    });

    it('button is disabled while testing', async () => {
      const { apiClient } = await import('@/lib/api/client');
      // Never resolves during test
      vi.mocked(apiClient.post).mockReturnValue(new Promise(() => {}));

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      expect(screen.getByRole('button', { name: /test connection/i })).toBeDisabled();
    });
  });
});
