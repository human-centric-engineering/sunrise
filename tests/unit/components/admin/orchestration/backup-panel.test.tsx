// @vitest-environment happy-dom

/**
 * Tests for `components/admin/orchestration/settings/backup-panel.tsx`
 *
 * Key behaviours:
 * - Export: calls POST /backup/export, triggers download via blob URL
 * - Export: shows error when response is non-ok
 * - Import via file input: reads file, posts JSON, shows result summary
 * - Import: invalid JSON → shows "File is not valid JSON" error
 * - Import: APIClientError → shows error message
 * - Import: generic error → shows error message
 * - Import result: shows created/updated counts and warnings
 * - Drag and drop: dragOver styling applied, file processed on drop
 * - Keyboard: Enter/Space on drop zone triggers file input click
 *
 * @see components/admin/orchestration/settings/backup-panel.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, createEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackupPanel } from '@/components/admin/orchestration/settings/backup-panel';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPost = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: (...args: unknown[]) => mockPost(...args),
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

function makeImportResult(overrides: Record<string, unknown> = {}) {
  return {
    agents: { created: 2, updated: 1 },
    capabilities: { created: 1, updated: 0 },
    workflows: { created: 3, updated: 0 },
    webhooks: { created: 0, skipped: 1 },
    settingsUpdated: true,
    warnings: [] as string[],
    ...overrides,
  };
}

function makeBackupJson() {
  return JSON.stringify({ version: 1, agents: [] });
}

function makeFile(content: string, name = 'backup.json') {
  return new File([content], name, { type: 'application/json' });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BackupPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Default: export succeeds
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Blob(['{}'], { type: 'application/json' }), {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="orchestration-backup-2026.json"' },
      })
    );

    // Mock URL.createObjectURL / revokeObjectURL
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  it('renders Export and Import sections', () => {
    render(<BackupPanel />);
    expect(screen.getByText('Export Configuration')).toBeInTheDocument();
    expect(screen.getByText('Import Configuration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download backup/i })).toBeInTheDocument();
  });

  // ── Export ─────────────────────────────────────────────────────────────────

  it('calls POST /backup/export and triggers download', async () => {
    const user = userEvent.setup();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/backup/export?shared=true',
        expect.objectContaining({ method: 'POST' })
      );
    });
    expect(clickSpy).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    clickSpy.mockRestore();
  });

  it('uses Content-Disposition filename for download', async () => {
    const user = userEvent.setup();
    let anchorDownload = '';
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      anchorDownload = this.download;
    });

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    // test-review:accept no_arg_called — UI callback-fired guard
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(anchorDownload).toBe('orchestration-backup-2026.json');
    clickSpy.mockRestore();
  });

  it('shows error when export fetch returns non-ok', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    await waitFor(() => {
      expect(screen.getByText(/export failed: 500/i)).toBeInTheDocument();
    });
  });

  it('shows the API’s own message when the export is refused', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'FORBIDDEN', message: 'The shared part moves only in the install org' },
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    );

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    await waitFor(() => {
      expect(screen.getByText('The shared part moves only in the install org')).toBeInTheDocument();
    });
    expect(screen.queryByText(/export failed/i)).not.toBeInTheDocument();
  });

  it('falls back to the status when a refused export has a non-JSON body', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('<html>Forbidden</html>', { status: 403 }));

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    await waitFor(() => {
      expect(screen.getByText('Export failed: 403')).toBeInTheDocument();
    });
  });

  it('falls back to the status when the JSON body is not an API error envelope', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 403 }));

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    await waitFor(() => {
      expect(screen.getByText('Export failed: 403')).toBeInTheDocument();
    });
  });

  it('falls back to the status when the failure envelope carries no message', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN' } }), {
        status: 403,
      })
    );

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    await waitFor(() => {
      expect(screen.getByText('Export failed: 403')).toBeInTheDocument();
    });
  });

  it('falls back to the status when a non-ok response carries a success envelope', async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { message: 'not an error' } }), {
        status: 502,
      })
    );

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    await waitFor(() => {
      expect(screen.getByText('Export failed: 502')).toBeInTheDocument();
    });
    expect(screen.queryByText('not an error')).not.toBeInTheDocument();
  });

  // ── Import via file input ──────────────────────────────────────────────────

  it('imports a valid JSON file and shows result summary', async () => {
    mockPost.mockResolvedValue(makeImportResult());

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => {
      expect(screen.getByText('Import successful')).toBeInTheDocument();
      expect(screen.getByText(/agents: 2 created, 1 updated/i)).toBeInTheDocument();
      expect(screen.getByText(/capabilities: 1 created/i)).toBeInTheDocument();
      expect(screen.getByText(/settings updated/i)).toBeInTheDocument();
    });
  });

  it('shows "File is not valid JSON" for malformed file', async () => {
    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, makeFile('not-json', 'bad.json'));

    await waitFor(() => {
      expect(screen.getByText('File is not valid JSON')).toBeInTheDocument();
    });
    expect(mockPost).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('shows APIClientError message on import failure', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    mockPost.mockRejectedValue(new APIClientError('Schema version mismatch'));

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => {
      expect(screen.getByText('Schema version mismatch')).toBeInTheDocument();
    });
  });

  it('shows generic error message when import throws a plain Error', async () => {
    mockPost.mockRejectedValue(new Error('Unexpected server error'));

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => {
      expect(screen.getByText('Unexpected server error')).toBeInTheDocument();
    });
  });

  // ── Import result details ──────────────────────────────────────────────────

  it('shows warnings in import result', async () => {
    mockPost.mockResolvedValue(
      makeImportResult({ warnings: ['Agent "foo" skipped — duplicate slug'] })
    );

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => {
      expect(screen.getByText('Agent "foo" skipped — duplicate slug')).toBeInTheDocument();
    });
  });

  it('does not show "Settings updated" when settingsUpdated is false', async () => {
    mockPost.mockResolvedValue(makeImportResult({ settingsUpdated: false }));

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => screen.getByText('Import successful'));
    expect(screen.queryByText(/settings updated/i)).not.toBeInTheDocument();
  });

  it('lists the shared settings as not restored when the import skipped them', async () => {
    mockPost.mockResolvedValue(
      makeImportResult({
        settingsUpdated: false,
        sharedSkipped: true,
        warnings: ['Shared settings not imported: 1 capabilities.'],
      })
    );

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => {
      expect(
        screen.getByText('Shared settings not restored (see the warning below)')
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Shared settings not imported: 1 capabilities.')).toBeInTheDocument();
  });

  it('does not mention shared settings when the import did not skip them', async () => {
    mockPost.mockResolvedValue(makeImportResult({ sharedSkipped: false }));

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => screen.getByText('Import successful'));
    expect(screen.queryByText(/shared settings not restored/i)).not.toBeInTheDocument();
  });

  // ── Drag and drop ──────────────────────────────────────────────────────────

  it('applies dragOver styling when file is dragged over the drop zone', () => {
    render(<BackupPanel />);
    const dropZone = screen.getByRole('button', { name: /drop a backup/i });

    fireEvent.dragOver(dropZone, { dataTransfer: { files: [] } });

    // dragOver class is applied — border-primary is added
    expect(dropZone.className).toContain('border-primary');
  });

  it('removes dragOver styling on drag leave', () => {
    render(<BackupPanel />);
    const dropZone = screen.getByRole('button', { name: /drop a backup/i });

    fireEvent.dragOver(dropZone, { dataTransfer: { files: [] } });
    fireEvent.dragLeave(dropZone);

    expect(dropZone.className).not.toContain('border-primary');
  });

  it('processes dropped file', async () => {
    mockPost.mockResolvedValue(makeImportResult());
    const file = makeFile(makeBackupJson());

    render(<BackupPanel />);
    const dropZone = screen.getByRole('button', { name: /drop a backup/i });

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Import successful')).toBeInTheDocument();
    });
  });

  it('ignores drop event when dataTransfer has no files', async () => {
    render(<BackupPanel />);
    const dropZone = screen.getByRole('button', { name: /drop a backup/i });

    fireEvent.drop(dropZone, { dataTransfer: { files: [] } });

    // No import attempt — mockPost should not be called
    expect(mockPost).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
    // No error shown
    expect(screen.queryByText('Import successful')).not.toBeInTheDocument();
  });

  // ── Keyboard accessibility ─────────────────────────────────────────────────

  it('Enter key on drop zone triggers file input click', () => {
    render(<BackupPanel />);
    const dropZone = screen.getByRole('button', { name: /drop a backup/i });
    const clickSpy = vi.fn();
    // The hidden input is inside the drop zone div
    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    input.click = clickSpy;

    fireEvent.keyDown(dropZone, { key: 'Enter' });

    // fileInputRef.current.click() is invoked — we verify via the keydown handler behavior
    // Since the ref points to a real DOM node, we spy differently
    // Re-render to get fresh ref access
    const { container: c2 } = render(<BackupPanel />);
    const dropZone2 = c2.querySelector('[role="button"]') as HTMLElement;
    const input2 = c2.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy2 = vi.fn();
    input2.click = clickSpy2;

    fireEvent.keyDown(dropZone2, { key: 'Enter' });
    expect(clickSpy2).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
  });

  it('Space key on drop zone triggers file input click', () => {
    const { container } = render(<BackupPanel />);
    const dropZone = container.querySelector('[role="button"]') as HTMLElement;
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.fn();
    input.click = clickSpy;

    fireEvent.keyDown(dropZone, { key: ' ' });
    expect(clickSpy).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
  });

  it('dragOver calls preventDefault to allow drop', () => {
    render(<BackupPanel />);
    const dropZone = screen.getByRole('button', { name: /drop a backup/i });

    const dragOverEvent = createEvent.dragOver(dropZone, { dataTransfer: { files: [] } });
    // Use fireEvent to dispatch and check the default was prevented
    fireEvent(dropZone, dragOverEvent);
    expect(dragOverEvent.defaultPrevented).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
  });

  // ── Export with no Content-Disposition header ─────────────────────────────

  it('uses fallback filename when Content-Disposition header is absent', async () => {
    const user = userEvent.setup();
    // Response with no Content-Disposition header
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(new Blob(['{}'], { type: 'application/json' }), {
        status: 200,
        // No Content-Disposition header
      })
    );

    let anchorDownload = '';
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      anchorDownload = this.download;
    });

    render(<BackupPanel />);
    await user.click(screen.getByRole('button', { name: /download backup/i }));

    // test-review:accept no_arg_called — UI callback-fired guard
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(anchorDownload).toBe('orchestration-backup.json');
    clickSpy.mockRestore();
  });

  // ── Import result — workflows and webhooks counts ─────────────────────────

  it('shows workflows count in import result', async () => {
    mockPost.mockResolvedValue(makeImportResult({ workflows: { created: 5, updated: 2 } }));

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => {
      expect(screen.getByText(/workflows: 5 created, 2 updated/i)).toBeInTheDocument();
    });
  });

  it('shows webhooks skipped count in import result', async () => {
    mockPost.mockResolvedValue(makeImportResult({ webhooks: { created: 1, skipped: 3 } }));

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => {
      expect(screen.getByText(/webhooks: 1 created, 3 skipped/i)).toBeInTheDocument();
    });
  });

  it('shows "Settings updated" when settingsUpdated is true', async () => {
    mockPost.mockResolvedValue(makeImportResult({ settingsUpdated: true }));

    const { container } = render(<BackupPanel />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, makeFile(makeBackupJson()));

    await waitFor(() => {
      expect(screen.getByText(/settings updated/i)).toBeInTheDocument();
    });
  });
  // ── Shared-settings choice (§109 t-738) ────────────────────────────────────

  describe('include shared settings', () => {
    it('shows the checkbox ticked by default', () => {
      render(<BackupPanel />);

      expect(screen.getByRole('checkbox', { name: /include shared settings/i })).toBeChecked();
    });

    it('exports with ?shared=false after the box is unticked', async () => {
      const user = userEvent.setup();
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

      render(<BackupPanel />);
      await user.click(screen.getByRole('checkbox', { name: /include shared settings/i }));
      await user.click(screen.getByRole('button', { name: /download backup/i }));

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/backup/export?shared=false',
          expect.objectContaining({ method: 'POST' })
        );
      });
      clickSpy.mockRestore();
    });

    it('imports with ?shared=true by default', async () => {
      mockPost.mockResolvedValue(makeImportResult());

      const { container } = render(<BackupPanel />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, makeFile(makeBackupJson()));

      await waitFor(() => expect(screen.getByText('Import successful')).toBeInTheDocument());
      expect(mockPost).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/backup/import?shared=true',
        { body: { version: 1, agents: [] } }
      );
    });

    it('imports with ?shared=false after the box is unticked', async () => {
      mockPost.mockResolvedValue(makeImportResult({ settingsUpdated: false, sharedSkipped: true }));
      const user = userEvent.setup();

      const { container } = render(<BackupPanel />);
      await user.click(screen.getByRole('checkbox', { name: /include shared settings/i }));
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, makeFile(makeBackupJson()));

      await waitFor(() => expect(screen.getByText('Import successful')).toBeInTheDocument());
      expect(mockPost).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/backup/import?shared=false',
        expect.anything()
      );
    });
  });

  // ── Customer org at multi (shared part cannot move) ────────────────────────

  describe('read-only outside the install org (§109 t-738)', () => {
    function renderReadOnly() {
      return render(
        <SharedSettingsAccessProvider readOnly canSwitch>
          <BackupPanel />
        </SharedSettingsAccessProvider>
      );
    }

    it('drops the checkbox, explains the scope, and keeps export and import available', () => {
      const { container } = renderReadOnly();

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(
        screen.getByText(/backups from this organisation cover its own agents, workflows/i)
      ).toBeInTheDocument();
      expect(screen.getByText('Import Configuration')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /drop a backup/i })).toBeInTheDocument();
      expect(container.querySelector('input[type="file"]')).not.toBeNull();
      expect(screen.getByRole('button', { name: /download backup/i })).toBeEnabled();
    });

    it('exports with no query string', async () => {
      const user = userEvent.setup();
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

      renderReadOnly();
      await user.click(screen.getByRole('button', { name: /download backup/i }));

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          '/api/v1/admin/orchestration/backup/export',
          expect.objectContaining({ method: 'POST' })
        );
      });
      clickSpy.mockRestore();
    });

    it('imports with no query string', async () => {
      mockPost.mockResolvedValue(makeImportResult({ settingsUpdated: false, sharedSkipped: true }));

      const { container } = renderReadOnly();
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await userEvent.upload(input, makeFile(makeBackupJson()));

      await waitFor(() => expect(screen.getByText('Import successful')).toBeInTheDocument());
      expect(mockPost).toHaveBeenCalledWith(
        '/api/v1/admin/orchestration/backup/import',
        expect.anything()
      );
    });
  });
});
