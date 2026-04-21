/**
 * ModelTestButton Component Tests
 *
 * Test Coverage:
 * - Renders "Test model" button
 * - Button is disabled when providerId is null
 * - Button is disabled when model is null
 * - On click: POSTs to the correct endpoint with { model } body
 * - Success response (ok: true, latencyMs: number): shows latency in green
 * - Server-side failure (ok: false, latencyMs: null): shows friendly error in red
 * - Fetch error (apiClient.post throws): shows generic error in red
 * - onResult callback invoked with correct args on success
 * - onResult callback invoked with false on failure
 *
 * @see components/admin/orchestration/model-test-button.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModelTestButton } from '@/components/admin/orchestration/model-test-button';

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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';
const MODEL = 'claude-opus-4-6';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ModelTestButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering ────────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders a "Test model" button', () => {
      // Act
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Assert
      expect(screen.getByRole('button', { name: /test model/i })).toBeInTheDocument();
    });

    it('renders no result text in initial state', () => {
      // Act
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Assert: no success or failure indicators present initially
      expect(document.querySelector('.text-green-600')).toBeNull();
      expect(document.querySelector('.text-red-600')).toBeNull();
    });
  });

  // ── Disabled states ───────────────────────────────────────────────────────────

  describe('disabled states', () => {
    it('is disabled when providerId is null', () => {
      // Act
      render(<ModelTestButton providerId={null} model={MODEL} />);

      // Assert
      expect(screen.getByRole('button', { name: /test model/i })).toBeDisabled();
    });

    it('is disabled when model is null', () => {
      // Act
      render(<ModelTestButton providerId={PROVIDER_ID} model={null} />);

      // Assert
      expect(screen.getByRole('button', { name: /test model/i })).toBeDisabled();
    });

    it('is disabled when both providerId and model are null', () => {
      // Act
      render(<ModelTestButton providerId={null} model={null} />);

      // Assert
      expect(screen.getByRole('button', { name: /test model/i })).toBeDisabled();
    });

    it('is enabled when both providerId and model are provided', () => {
      // Act
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Assert
      expect(screen.getByRole('button', { name: /test model/i })).not.toBeDisabled();
    });

    it('is disabled while a test is in progress', async () => {
      // Arrange: never resolves during the test
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockReturnValue(new Promise(() => {}));

      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Act: click and check state immediately
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert: disabled while in-flight
      expect(screen.getByRole('button', { name: /test model/i })).toBeDisabled();
    });
  });

  // ── Click → API call ──────────────────────────────────────────────────────────

  describe('click sends POST to correct endpoint', () => {
    it('POSTs to the provider test-model endpoint with { model } in the body', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: true, latencyMs: 246 });

      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert: called once with the provider id in the URL and the model in the body
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledOnce();
        expect(apiClient.post).toHaveBeenCalledWith(
          expect.stringContaining(PROVIDER_ID),
          expect.objectContaining({ body: { model: MODEL } })
        );
      });
    });

    it('does not POST when the button is disabled (null providerId)', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');

      const user = userEvent.setup();
      render(<ModelTestButton providerId={null} model={MODEL} />);

      // Act: try to click the disabled button
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert
      expect(apiClient.post).not.toHaveBeenCalled();
    });
  });

  // ── Success response ─────────────────────────────────────────────────────────

  describe('success response', () => {
    it('shows latency in milliseconds in a green element', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: true, latencyMs: 246 });

      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert: latency text appears in a green element
      await waitFor(() => {
        const greenEl = document.querySelector('.text-green-600');
        expect(greenEl).toBeTruthy();
        expect(greenEl?.textContent).toContain('246');
        expect(greenEl?.textContent).toContain('ms');
      });
    });

    it('calls onResult(true, latencyMs) on success', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: true, latencyMs: 150 });

      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} onResult={onResult} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert
      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(true, 150);
      });
    });
  });

  // ── Server-side model failure (ok: false) ─────────────────────────────────────

  describe('server-side model failure', () => {
    it('shows error message in red when response has ok: false', async () => {
      // Arrange: server returns ok=false (model did not respond)
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: false, latencyMs: null });

      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert: red error text appears
      await waitFor(() => {
        const redEl = document.querySelector('.text-red-600');
        expect(redEl).toBeTruthy();
      });
    });

    it('shows a user-friendly error message (not a raw SDK error) when ok: false', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: false, latencyMs: null });

      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert: a friendly message shown (not a blank screen)
      await waitFor(() => {
        expect(screen.getByText(/model did not respond/i)).toBeInTheDocument();
      });
    });

    it('calls onResult(false) when response has ok: false', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue({ ok: false, latencyMs: null });

      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} onResult={onResult} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert
      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(false);
        expect(onResult).not.toHaveBeenCalledWith(true);
      });
    });
  });

  // ── Fetch error (apiClient.post throws) ───────────────────────────────────────

  describe('fetch error', () => {
    it('shows a generic error message in red when apiClient.post throws', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network error'));

      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert: red error element appears
      await waitFor(() => {
        const redEl = document.querySelector('.text-red-600');
        expect(redEl).toBeTruthy();
      });
    });

    it('shows a user-friendly fallback message when apiClient.post throws', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('ETIMEDOUT'));

      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert: the raw error message is not surfaced
      await waitFor(() => {
        expect(screen.getByText(/model test failed/i)).toBeInTheDocument();
      });
      expect(document.body.textContent ?? '').not.toContain('ETIMEDOUT');
    });

    it('calls onResult(false) when apiClient.post throws', async () => {
      // Arrange
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network error'));

      const onResult = vi.fn();
      const user = userEvent.setup();
      render(<ModelTestButton providerId={PROVIDER_ID} model={MODEL} onResult={onResult} />);

      // Act
      await user.click(screen.getByRole('button', { name: /test model/i }));

      // Assert
      await waitFor(() => {
        expect(onResult).toHaveBeenCalledWith(false);
      });
    });
  });
});
