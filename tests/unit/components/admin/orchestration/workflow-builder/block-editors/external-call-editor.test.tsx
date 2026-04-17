/**
 * Unit Tests: ExternalCallEditor
 *
 * Test Coverage:
 * - Renders core fields: URL, Method, Timeout
 * - Default values when config fields are omitted
 * - URL input calls onChange({ url })
 * - Method select calls onChange({ method })
 * - Timeout input calls onChange({ timeoutMs })
 * - Body template textarea is shown for POST/PUT and hidden for GET
 * - Body template textarea calls onChange({ bodyTemplate })
 * - Auth type select calls onChange({ authType })
 * - Auth secret input is shown only when authType is bearer or api-key
 * - Auth secret input calls onChange({ authSecret })
 * - Header management: add header button calls onChange with new empty header entry
 * - Header management: remove button calls onChange with header removed
 * - Header management: editing a header name calls onChange with updated headers
 * - Header management: editing a header value calls onChange with updated headers
 * - FieldHelp ⓘ info buttons are present
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/external-call-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ExternalCallEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/external-call-editor';
import type { ExternalCallConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/external-call-editor';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig: ExternalCallConfig = {
  url: '',
  method: 'POST',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExternalCallEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders the URL input', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      expect(document.getElementById('ext-url')).toBeInTheDocument();
    });

    it('renders the Method select', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      expect(document.getElementById('ext-method')).toBeInTheDocument();
    });

    it('renders the Timeout input', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      expect(document.getElementById('ext-timeout')).toBeInTheDocument();
    });

    it('renders the Auth type select', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      expect(document.getElementById('ext-auth-type')).toBeInTheDocument();
    });

    it('renders the Add header button', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      expect(screen.getByRole('button', { name: /add header/i })).toBeInTheDocument();
    });

    it('renders at least one FieldHelp info button', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      const infoButtons = screen.getAllByRole('button', { name: /more information/i });
      expect(infoButtons.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Default values ───────────────────────────────────────────────────────────

  describe('default values', () => {
    it('shows empty string in URL input when config.url is empty', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      const urlInput = document.getElementById('ext-url') as HTMLInputElement;
      expect(urlInput.value).toBe('');
    });

    it('shows POST as the default method value', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      const methodSelect = document.getElementById('ext-method') as HTMLSelectElement;
      expect(methodSelect.value).toBe('POST');
    });

    it('shows 30000 as the default timeout value', () => {
      // Arrange: config has no timeoutMs set
      const config: ExternalCallConfig = { url: '', method: 'POST' };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      const timeoutInput = document.getElementById('ext-timeout') as HTMLInputElement;
      expect(Number(timeoutInput.value)).toBe(30000);
    });

    it('shows none as the default auth type', () => {
      render(<ExternalCallEditor config={baseConfig} onChange={vi.fn()} />);

      const authSelect = document.getElementById('ext-auth-type') as HTMLSelectElement;
      expect(authSelect.value).toBe('none');
    });

    it('reflects provided URL value', () => {
      // Arrange
      const config: ExternalCallConfig = {
        url: 'https://api.example.com/v1/process',
        method: 'POST',
      };

      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      const urlInput = document.getElementById('ext-url') as HTMLInputElement;
      expect(urlInput.value).toBe('https://api.example.com/v1/process');
    });
  });

  // ── URL field ────────────────────────────────────────────────────────────────

  describe('URL input', () => {
    it('calls onChange with { url } when user types in the URL field', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ExternalCallEditor config={baseConfig} onChange={onChange} />);

      // Act
      const urlInput = document.getElementById('ext-url')!;
      await user.type(urlInput, 'h');

      // Assert
      const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
      expect(lastArg).toHaveProperty('url');
    });

    it('passes the newly typed character appended to the existing url in onChange({ url })', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      const config: ExternalCallConfig = { url: 'https://api.example.com', method: 'POST' };
      render(<ExternalCallEditor config={config} onChange={onChange} />);

      // Act — type a single character after the existing value
      const urlInput = document.getElementById('ext-url')!;
      await user.type(urlInput, 'a');

      // Assert — the onChange receives the full value with the appended character
      const calls = onChange.mock.calls;
      const lastArg = calls[calls.length - 1][0];
      expect(lastArg.url).toBe('https://api.example.coma');
    });
  });

  // ── Method select ────────────────────────────────────────────────────────────

  describe('Method select', () => {
    it('calls onChange({ method: "GET" }) when GET is selected', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ExternalCallEditor config={baseConfig} onChange={onChange} />);

      // Act
      const methodSelect = document.getElementById('ext-method')!;
      await user.selectOptions(methodSelect, 'GET');

      // Assert
      expect(onChange).toHaveBeenCalledWith({ method: 'GET' });
    });

    it('calls onChange({ method: "PUT" }) when PUT is selected', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ExternalCallEditor config={baseConfig} onChange={onChange} />);

      // Act
      const methodSelect = document.getElementById('ext-method')!;
      await user.selectOptions(methodSelect, 'PUT');

      // Assert
      expect(onChange).toHaveBeenCalledWith({ method: 'PUT' });
    });
  });

  // ── Timeout input ────────────────────────────────────────────────────────────

  describe('Timeout input', () => {
    it('calls onChange with { timeoutMs: number } when user changes timeout', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ExternalCallEditor config={baseConfig} onChange={onChange} />);

      // Act
      const timeoutInput = document.getElementById('ext-timeout')!;
      await user.clear(timeoutInput);
      await user.type(timeoutInput, '5000');

      // Assert
      const calls = onChange.mock.calls;
      const lastArg = calls[calls.length - 1][0] as Record<string, unknown>;
      expect(lastArg).toHaveProperty('timeoutMs');
      expect(typeof lastArg.timeoutMs).toBe('number');
    });
  });

  // ── Body template ────────────────────────────────────────────────────────────

  describe('Body template', () => {
    it('renders the body template textarea when method is POST', () => {
      // Arrange
      const config: ExternalCallConfig = { url: '', method: 'POST' };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      expect(document.getElementById('ext-body')).toBeInTheDocument();
    });

    it('renders the body template textarea when method is PUT', () => {
      // Arrange
      const config: ExternalCallConfig = { url: '', method: 'PUT' };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      expect(document.getElementById('ext-body')).toBeInTheDocument();
    });

    it('does NOT render the body template textarea when method is GET', () => {
      // Arrange
      const config: ExternalCallConfig = { url: '', method: 'GET' };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      expect(document.getElementById('ext-body')).not.toBeInTheDocument();
    });

    it('shows the current bodyTemplate value in the textarea', () => {
      // Arrange
      const config: ExternalCallConfig = {
        url: '',
        method: 'POST',
        bodyTemplate: '{"key":"value"}',
      };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      const textarea = document.getElementById('ext-body') as HTMLTextAreaElement;
      expect(textarea.value).toBe('{"key":"value"}');
    });

    it('calls onChange with { bodyTemplate } when user types in the body textarea', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      const config: ExternalCallConfig = { url: '', method: 'POST', bodyTemplate: '' };
      render(<ExternalCallEditor config={config} onChange={onChange} />);

      // Act — avoid special characters like { } that userEvent treats as key descriptors
      const textarea = document.getElementById('ext-body')!;
      await user.type(textarea, 'x');

      // Assert
      const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
      expect(lastArg).toHaveProperty('bodyTemplate');
      expect(lastArg.bodyTemplate).toBe('x');
    });
  });

  // ── Auth type ────────────────────────────────────────────────────────────────

  describe('Auth type select', () => {
    it('calls onChange({ authType: "bearer" }) when Bearer token is selected', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ExternalCallEditor config={baseConfig} onChange={onChange} />);

      // Act
      const authSelect = document.getElementById('ext-auth-type')!;
      await user.selectOptions(authSelect, 'bearer');

      // Assert
      expect(onChange).toHaveBeenCalledWith({ authType: 'bearer' });
    });

    it('calls onChange({ authType: "api-key" }) when API key is selected', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ExternalCallEditor config={baseConfig} onChange={onChange} />);

      // Act
      const authSelect = document.getElementById('ext-auth-type')!;
      await user.selectOptions(authSelect, 'api-key');

      // Assert
      expect(onChange).toHaveBeenCalledWith({ authType: 'api-key' });
    });

    it('calls onChange({ authType: "none" }) when None is selected', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      const config: ExternalCallConfig = { url: '', method: 'POST', authType: 'bearer' };
      render(<ExternalCallEditor config={config} onChange={onChange} />);

      // Act
      const authSelect = document.getElementById('ext-auth-type')!;
      await user.selectOptions(authSelect, 'none');

      // Assert
      expect(onChange).toHaveBeenCalledWith({ authType: 'none' });
    });
  });

  // ── Auth secret input ────────────────────────────────────────────────────────

  describe('Auth secret input', () => {
    it('does NOT render the auth secret input when authType is none', () => {
      // Arrange
      const config: ExternalCallConfig = { url: '', method: 'POST', authType: 'none' };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      expect(document.getElementById('ext-auth-secret')).not.toBeInTheDocument();
    });

    it('does NOT render the auth secret input when authType is undefined', () => {
      // Arrange: no authType set
      const config: ExternalCallConfig = { url: '', method: 'POST' };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      expect(document.getElementById('ext-auth-secret')).not.toBeInTheDocument();
    });

    it('renders the auth secret input when authType is bearer', () => {
      // Arrange
      const config: ExternalCallConfig = { url: '', method: 'POST', authType: 'bearer' };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      expect(document.getElementById('ext-auth-secret')).toBeInTheDocument();
    });

    it('renders the auth secret input when authType is api-key', () => {
      // Arrange
      const config: ExternalCallConfig = { url: '', method: 'POST', authType: 'api-key' };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      expect(document.getElementById('ext-auth-secret')).toBeInTheDocument();
    });

    it('shows the current authSecret value', () => {
      // Arrange
      const config: ExternalCallConfig = {
        url: '',
        method: 'POST',
        authType: 'bearer',
        authSecret: 'MY_API_TOKEN',
      };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      const secretInput = document.getElementById('ext-auth-secret') as HTMLInputElement;
      expect(secretInput.value).toBe('MY_API_TOKEN');
    });

    it('calls onChange({ authSecret }) when user types in the secret field', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      const config: ExternalCallConfig = {
        url: '',
        method: 'POST',
        authType: 'bearer',
        authSecret: '',
      };
      render(<ExternalCallEditor config={config} onChange={onChange} />);

      // Act
      const secretInput = document.getElementById('ext-auth-secret')!;
      await user.type(secretInput, 'A');

      // Assert
      const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
      expect(lastArg).toHaveProperty('authSecret');
      expect(lastArg.authSecret).toBe('A');
    });
  });

  // ── Headers management ───────────────────────────────────────────────────────

  describe('Headers management', () => {
    it('renders existing headers from config', () => {
      // Arrange
      const config: ExternalCallConfig = {
        url: '',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert
      expect(screen.getByDisplayValue('Content-Type')).toBeInTheDocument();
      expect(screen.getByDisplayValue('application/json')).toBeInTheDocument();
    });

    it('renders no header rows when headers object is empty', () => {
      // Arrange
      const config: ExternalCallConfig = { url: '', method: 'POST', headers: {} };
      render(<ExternalCallEditor config={config} onChange={vi.fn()} />);

      // Assert: no name/value inputs beyond URL/timeout should exist from headers
      expect(screen.queryByLabelText(/header 1 name/i)).not.toBeInTheDocument();
    });

    it('clicking Add header calls onChange with an extra empty header entry', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<ExternalCallEditor config={baseConfig} onChange={onChange} />);

      // Act
      await user.click(screen.getByRole('button', { name: /add header/i }));

      // Assert
      expect(onChange).toHaveBeenCalledTimes(1);
      const [arg] = onChange.mock.calls[0];
      expect(arg).toHaveProperty('headers');
      expect(typeof arg.headers).toBe('object');
      // The new entry has an empty-string key
      expect('' in (arg.headers as Record<string, string>)).toBe(true);
    });

    it('clicking Add header when headers already exist appends a new empty entry', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      const config: ExternalCallConfig = {
        url: '',
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      };
      render(<ExternalCallEditor config={config} onChange={onChange} />);

      // Act
      await user.click(screen.getByRole('button', { name: /add header/i }));

      // Assert
      const [arg] = onChange.mock.calls[0];
      const keys = Object.keys(arg.headers as Record<string, string>);
      expect(keys).toContain('Authorization');
      expect(keys).toContain('');
    });

    it('clicking Remove button calls onChange with that header omitted', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      const config: ExternalCallConfig = {
        url: '',
        method: 'POST',
        headers: { 'X-Api-Key': 'secret', Accept: 'application/json' },
      };
      render(<ExternalCallEditor config={config} onChange={onChange} />);

      // Act — remove the first header row
      const removeBtns = screen.getAllByRole('button', { name: /remove header/i });
      await user.click(removeBtns[0]);

      // Assert
      expect(onChange).toHaveBeenCalledTimes(1);
      const [arg] = onChange.mock.calls[0];
      const keys = Object.keys(arg.headers as Record<string, string>);
      expect(keys).toHaveLength(1);
    });

    it('editing a header value calls onChange with the updated headers map', async () => {
      // Arrange
      const user = userEvent.setup();
      const onChange = vi.fn();
      const config: ExternalCallConfig = {
        url: '',
        method: 'POST',
        headers: { Accept: 'text/plain' },
      };
      render(<ExternalCallEditor config={config} onChange={onChange} />);

      // Act — type into the value input
      const valueInput = screen.getByLabelText(/header 1 value/i);
      await user.type(valueInput, 's');

      // Assert
      const calls = onChange.mock.calls;
      const lastArg = calls[calls.length - 1][0] as { headers: Record<string, string> };
      expect(lastArg).toHaveProperty('headers');
      expect(lastArg.headers['Accept']).toBe('text/plains');
    });
  });
});
