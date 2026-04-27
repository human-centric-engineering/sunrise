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
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImportAgentsDialog } from '@/components/admin/orchestration/import-agents-dialog';

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
      public statusCode = 500,
      public code = 'INTERNAL_ERROR'
    ) {
      super(message);
      this.name = 'APIClientError';
    }
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
});
