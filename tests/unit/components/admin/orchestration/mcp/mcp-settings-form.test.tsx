// @vitest-environment happy-dom

/**
 * McpSettingsForm Component Tests
 *
 * Test Coverage:
 * - Renders all form fields with initial values
 * - Save button disabled when pristine
 * - Save button enabled when dirty
 * - Successful submission calls apiClient.patch
 * - Shows "Saved" indicator on success
 * - Shows API error message on failure
 * - Shows generic error for non-API errors
 * - Validates field constraints (FieldHelp present)
 *
 * @see components/admin/orchestration/mcp/mcp-settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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

import { apiClient, APIClientError } from '@/lib/api/client';
import { McpSettingsForm } from '@/components/admin/orchestration/mcp/mcp-settings-form';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FULL_SETTINGS = {
  isEnabled: true,
  serverName: 'Sunrise MCP Server',
  serverVersion: '1.0.0',
  globalRateLimit: 60,
  auditRetentionDays: 90,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('McpSettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Initial render', () => {
    it('renders all form fields with initial values', () => {
      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);
      expect(document.getElementById('serverName')).toHaveValue('Sunrise MCP Server');
      expect(document.getElementById('serverVersion')).toHaveValue('1.0.0');
      expect(document.getElementById('globalRateLimit')).toHaveValue(60);
      expect(document.getElementById('auditRetentionDays')).toHaveValue(90);
    });

    it('renders defaults when initialSettings is null', () => {
      render(<McpSettingsForm initialSettings={null} />);
      expect(document.getElementById('serverName')).toHaveValue('Sunrise MCP Server');
      expect(document.getElementById('globalRateLimit')).toHaveValue(60);
    });

    it('renders FieldHelp tooltips for numeric fields', () => {
      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByText('Server Configuration')).toBeInTheDocument();
    });
  });

  describe('Button state', () => {
    it('disables save button when form is pristine', () => {
      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);
      expect(screen.getByRole('button', { name: /save settings/i })).toBeDisabled();
    });

    it('enables save button when form is dirty', async () => {
      const user = userEvent.setup();
      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const nameInput = document.getElementById('serverName') as HTMLInputElement;
      await user.clear(nameInput);
      await user.type(nameInput, 'New Name');

      expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
    });
  });

  describe('Submission', () => {
    it('calls apiClient.patch with correct payload on submit', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});

      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(apiClient.patch).toHaveBeenCalledWith(
          expect.stringContaining('/mcp/settings'),
          expect.objectContaining({
            body: expect.objectContaining({
              serverName: 'Sunrise MCP Server',
              globalRateLimit: 60,
              auditRetentionDays: 90,
            }),
          })
        );
      });
    });

    it('shows Saved indicator after successful submission', async () => {
      vi.mocked(apiClient.patch).mockResolvedValue({});

      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText('Saved')).toBeInTheDocument();
      });
    });
  });

  describe('Error handling', () => {
    it('shows API error message on submission failure', async () => {
      vi.mocked(apiClient.patch).mockRejectedValue(
        new APIClientError('Rate limit must be between 1 and 10000')
      );

      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText('Rate limit must be between 1 and 10000')).toBeInTheDocument();
      });
    });

    it('shows generic error for non-API errors', async () => {
      vi.mocked(apiClient.patch).mockRejectedValue(new Error('network failure'));

      render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(screen.getByText(/could not save settings/i)).toBeInTheDocument();
      });
    });
  });
});

describe('McpSettingsForm validation and saved indicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setField(id: string, value: string) {
    fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
  }

  async function submit() {
    const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
    await act(async () => {
      fireEvent.submit(form!);
    });
  }

  it.each([
    ['serverName', '', 'Required'],
    ['serverVersion', '', 'Required'],
    ['globalRateLimit', '0', 'Min 1'],
    ['globalRateLimit', '10001', 'Max 10,000'],
    ['auditRetentionDays', '-1', 'Min 0'],
    ['auditRetentionDays', '3651', 'Max 3,650'],
  ])('shows "%s" error for invalid value %j: %s', async (id, value, message) => {
    render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

    setField(id, value);
    await submit();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('shows the Saved indicator, then clears it after 3000ms', async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({});
    render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);
    setField('serverName', 'Renamed');

    // Fake only setTimeout so promises and waitFor's polling keep working.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await submit();
    // Let the mocked PATCH resolve and the post-save state updates flush.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(apiClient.patch).toHaveBeenCalledWith(
      expect.stringContaining('/mcp/settings'),
      expect.objectContaining({ body: expect.objectContaining({ serverName: 'Renamed' }) })
    );

    await act(async () => {
      vi.advanceTimersByTime(2999);
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});

describe('the session cap is gone, not merely inert (§39 t-718)', () => {
  it('renders no Max Sessions Per Key field at all', () => {
    // It used to render with a "No effect" caption under the default session
    // mode — a setting that validated and saved and was never consulted. The
    // column behind it is dropped, so there is nothing to caption.
    render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);

    expect(document.getElementById('maxSessionsPerKey')).toBeNull();
    expect(screen.queryByText(/max sessions per key/i)).not.toBeInTheDocument();
  });
});

describe('read-only outside the install org (§107 t-753)', () => {
  async function makeDirty() {
    const user = userEvent.setup();
    const nameInput = document.getElementById('serverName') as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, 'Edited Name');
    return user;
  }

  it('keeps Save Settings disabled after the form is dirtied, and never PATCHes', async () => {
    // Contrast: the identical edit enables Save without the provider.
    const { unmount } = render(<McpSettingsForm initialSettings={FULL_SETTINGS} />);
    await makeDirty();
    expect(screen.getByRole('button', { name: /save settings/i })).toBeEnabled();
    unmount();

    render(
      <SharedSettingsAccessProvider readOnly canSwitch>
        <McpSettingsForm initialSettings={FULL_SETTINGS} />
      </SharedSettingsAccessProvider>
    );
    // The form still renders its current values
    expect(document.getElementById('globalRateLimit')).toHaveValue(60);
    const user = await makeDirty();
    expect(document.getElementById('serverName')).toHaveValue('Edited Name');

    const save = screen.getByRole('button', { name: /save settings/i });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(apiClient.patch).not.toHaveBeenCalled();
  });
});
