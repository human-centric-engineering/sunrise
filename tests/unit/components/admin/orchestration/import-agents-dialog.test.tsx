// @vitest-environment happy-dom

/**
 * ImportAgentsDialog Component Tests
 *
 * Test Coverage:
 * - Import button is disabled until file is picked
 * - Conflict-mode radio value is forwarded in the POST body
 * - Success renders imported/skipped summary
 * - Invalid JSON shows error message before hitting server
 *
 * @see components/admin/orchestration/import-agents-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImportAgentsDialog } from '@/components/admin/orchestration/import-agents-dialog';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// The real APIClientError, so a failed import reads as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJsonFile(content: unknown, filename = 'agents.json'): File {
  const blob = new Blob([JSON.stringify(content)], { type: 'application/json' });
  return new File([blob], filename, { type: 'application/json' });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ImportAgentsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // happy-dom has no scrollIntoView; <SaveError> calls it when it appears.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Disabled until file picked ─────────────────────────────────────────────

  it('Import button is disabled when no file is selected', () => {
    // Arrange & Act
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={vi.fn()} />);

    // Assert
    const importBtn = screen.getByRole('button', { name: /^import$/i });
    expect(importBtn).toBeDisabled();
  });

  it('Import button becomes enabled after file is selected', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={vi.fn()} />);

    // Act: upload a JSON file
    const fileInput = document.getElementById('import-agents-file')!;
    const file = makeJsonFile([{ name: 'Test Agent', slug: 'test-agent' }]);
    await user.upload(fileInput, file);

    // Assert
    const importBtn = screen.getByRole('button', { name: /^import$/i });
    expect(importBtn).not.toBeDisabled();
  });

  // ── Conflict mode radio ────────────────────────────────────────────────────

  it('default conflict mode is "skip"', () => {
    // Arrange & Act
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={vi.fn()} />);

    // Assert: skip radio is checked
    const skipRadio = screen.getByRole('radio', {
      name: /skip.*keep the existing agent/i,
    });
    expect(skipRadio).toBeChecked();
  });

  it('shows a refused import inside the dialog, above its buttons, and stays open', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Bundle schema version 9 is not supported', 'VALIDATION_ERROR', 400)
    );
    const onOpenChange = vi.fn();
    const onImported = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={onOpenChange} onImported={onImported} />);

    await user.upload(
      document.getElementById('import-agents-file')!,
      makeJsonFile([{ name: 'Agent', slug: 'agent' }])
    );
    const importBtn = screen.getByRole('button', { name: /^import$/i });
    await user.click(importBtn);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Bundle schema version 9 is not supported');
    expect(screen.getByRole('dialog')).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(importBtn);
    expect(onImported).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('conflict mode "overwrite" is forwarded in POST body', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ imported: 1, skipped: 0, warnings: [] });

    const onImported = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={onImported} />);

    // Act: upload file and switch to overwrite
    const fileInput = document.getElementById('import-agents-file')!;
    const file = makeJsonFile([{ name: 'Agent', slug: 'agent' }]);
    await user.upload(fileInput, file);

    const overwriteRadio = screen.getByRole('radio', {
      name: /overwrite.*replace the existing agent/i,
    });
    await user.click(overwriteRadio);

    await user.click(screen.getByRole('button', { name: /^import$/i }));

    // Assert: POST called with conflictMode: 'overwrite'
    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        expect.stringContaining('/import'),
        expect.objectContaining({
          body: expect.objectContaining({ conflictMode: 'overwrite' }),
        })
      );
    });
  });

  it('"skip" conflict mode is forwarded in POST body', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ imported: 2, skipped: 1, warnings: [] });

    const onImported = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={onImported} />);

    // Act: upload file and submit with default (skip)
    const fileInput = document.getElementById('import-agents-file')!;
    await user.upload(fileInput, makeJsonFile([{ name: 'Agent', slug: 'agent' }]));
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    // Assert
    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        expect.stringContaining('/import'),
        expect.objectContaining({
          body: expect.objectContaining({ conflictMode: 'skip' }),
        })
      );
    });
  });

  // ── Success summary ────────────────────────────────────────────────────────

  it('renders imported/skipped summary on success', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({
      imported: 3,
      skipped: 1,
      warnings: ['Agent "old-agent" had unknown fields that were ignored.'],
    });

    const onImported = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={onImported} />);

    // Act
    await user.upload(
      document.getElementById('import-agents-file')!,
      makeJsonFile([{ name: 'Agent', slug: 'agent' }])
    );
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    // Assert: the result panel contains "Imported: 3" and "Skipped: 1"
    // The component renders them in a <p> with <strong> labels
    await waitFor(() => {
      // Check for the number "3" and "1" in context — the result div renders both
      const bodyText = document.body.textContent ?? '';
      expect(bodyText).toContain('Imported:');
      expect(bodyText).toContain('3');
      expect(bodyText).toContain('Skipped:');
      expect(bodyText).toContain('1');
    });

    // Warnings rendered
    expect(screen.getByText(/unknown fields/i)).toBeInTheDocument();

    // onImported callback called
    expect(onImported).toHaveBeenCalledOnce();
  });

  // ── Invalid JSON ──────────────────────────────────────────────────────────

  it('shows parse error without hitting server when file is invalid JSON', async () => {
    // Arrange
    const { apiClient } = await import('@/lib/api/client');
    const onImported = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={onImported} />);

    // Act: upload a file with invalid JSON content
    const invalidFile = new File(['not valid json {{{{'], 'bad.json', {
      type: 'application/json',
    });
    await user.upload(document.getElementById('import-agents-file')!, invalidFile);
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    // Assert: client-side error shown
    await waitFor(() => {
      expect(screen.getByText(/not valid json/i)).toBeInTheDocument();
    });

    // Server was never called
    expect(apiClient.post).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  // ── Oversized file ────────────────────────────────────────────────────────

  it('refuses a file over 10 MB with a message, without reading it or calling the server', async () => {
    const { apiClient } = await import('@/lib/api/client');
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={vi.fn()} />);

    const big = makeJsonFile([{ slug: 'agent' }], 'big.json');
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    const textSpy = vi.spyOn(big, 'text');
    await user.upload(document.getElementById('import-agents-file')!, big);
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too large \(max 10 MB\)/i);
    expect(textSpy).not.toHaveBeenCalled();
    expect(apiClient.post).not.toHaveBeenCalled();
    // Nothing was submitted, so the button is still usable for another file.
    expect(screen.getByRole('button', { name: /^import$/i })).toBeEnabled();
  });

  it('accepts a file of exactly 10 MB', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ imported: 1, overwritten: 0, skipped: 0 });
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={vi.fn()} />);

    const edge = makeJsonFile([{ slug: 'agent' }]);
    Object.defineProperty(edge, 'size', { value: 10 * 1024 * 1024 });
    await user.upload(document.getElementById('import-agents-file')!, edge);
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledOnce());
  });

  // ── Changing the selection ────────────────────────────────────────────────

  it('disables Import again when the chosen file is cleared', async () => {
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={vi.fn()} />);

    const input = document.getElementById('import-agents-file')!;
    await user.upload(input, makeJsonFile([{ slug: 'agent' }]));
    expect(screen.getByRole('button', { name: /^import$/i })).toBeEnabled();

    fireEvent.change(input, { target: { files: [] } });

    expect(screen.getByRole('button', { name: /^import$/i })).toBeDisabled();
  });

  it('switching back from overwrite to skip sends conflictMode "skip"', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ imported: 1, overwritten: 0, skipped: 0 });
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={vi.fn()} onImported={vi.fn()} />);

    await user.upload(
      document.getElementById('import-agents-file')!,
      makeJsonFile([{ slug: 'agent' }])
    );
    await user.click(screen.getByRole('radio', { name: /overwrite.*replace/i }));
    const skip = screen.getByRole('radio', { name: /skip.*keep the existing agent/i });
    expect(skip).not.toBeChecked();
    await user.click(skip);
    expect(skip).toBeChecked();
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        expect.stringContaining('/import'),
        expect.objectContaining({ body: expect.objectContaining({ conflictMode: 'skip' }) })
      );
    });
  });

  // ── Cancel / Close ────────────────────────────────────────────────────────

  it('Cancel asks the parent to close the dialog', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={onOpenChange} onImported={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('after a successful import the footer offers Close instead of Cancel/Import', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockResolvedValue({ imported: 1, overwritten: 0, skipped: 0 });
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<ImportAgentsDialog open={true} onOpenChange={onOpenChange} onImported={vi.fn()} />);

    await user.upload(
      document.getElementById('import-agents-file')!,
      makeJsonFile([{ slug: 'agent' }])
    );
    await user.click(screen.getByRole('button', { name: /^import$/i }));

    // The footer "Close" (the dialog's X also carries a "Close" name).
    const closeButtons = await screen.findAllByRole('button', { name: /^close$/i });
    expect(screen.queryByRole('button', { name: /^import$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    await user.click(closeButtons[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
