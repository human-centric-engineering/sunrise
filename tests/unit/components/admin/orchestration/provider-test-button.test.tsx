/**
 * ProviderTestButton Component Tests
 *
 * Test Coverage:
 * - Success response with { modelCount: 12 } → "12 models available" green text
 * - Failure → "Couldn't reach this provider" red text; raw SDK error absent
 * - providerId===null + click → renders the disabledMessage
 * - onResult callback invoked with true on success, false on failure
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
    it('renders "12 models available" green text on success with modelCount: 12', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ modelCount: 12 });

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(screen.getByText(/12 models available/i)).toBeInTheDocument();
      });
    });

    it('success renders green text (text-green-600 class present)', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ modelCount: 5 });

      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        const greenEl = document.querySelector('.text-green-600');
        expect(greenEl).toBeTruthy();
        expect(greenEl?.textContent).toContain('5 models available');
      });
    });

    it('calls onResult(true) on success', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ modelCount: 3 });

      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" onResult={onResult} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(true);
      });
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

    it('calls onResult(false) on failure', async () => {
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network error'));

      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ProviderTestButton providerId="prov-1" onResult={onResult} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(false);
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

    it('calls onResult(false) when providerId is null', async () => {
      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ProviderTestButton providerId={null} onResult={onResult} />);

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(false);
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
