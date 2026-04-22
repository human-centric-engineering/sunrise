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
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BackupPanel } from '@/components/admin/orchestration/settings/backup-panel';

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
        '/api/v1/admin/orchestration/backup/export',
        expect.objectContaining({ method: 'POST' })
      );
    });
    expect(clickSpy).toHaveBeenCalled();
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
    expect(mockPost).not.toHaveBeenCalled();
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
});
