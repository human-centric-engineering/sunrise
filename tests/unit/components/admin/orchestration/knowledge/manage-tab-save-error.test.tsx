// @vitest-environment happy-dom

/**
 * ManageTab — failed actions (§124)
 *
 * A row's Rechunk or Delete failing shows in the one save error directly
 * above the documents table, which takes focus. Load Patterns failing shows
 * directly above the row holding its button.
 *
 * @see components/admin/orchestration/knowledge/manage-tab.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ManageTab } from '@/components/admin/orchestration/knowledge/manage-tab';
import { DEFAULT_KNOWLEDGE_BASE_ID } from '@/lib/orchestration/knowledge/document-manager';

// The real APIClientError and apiErrorFromResponse; `apiClient` itself only
// serves the upload zone's tag list here.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn().mockResolvedValue([]), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

const mockFetch = vi.fn();

const DOC = {
  orgId: null,
  id: 'doc-user',
  slug: 'doc-user-abc123ab',
  knowledgeBaseId: DEFAULT_KNOWLEDGE_BASE_ID,
  name: 'My Custom Doc',
  fileName: 'custom.pdf',
  fileHash: 'abc123',
  chunkCount: 5,
  status: 'ready',
  scope: 'app',
  category: null,
  sourceUrl: null,
  errorMessage: null,
  metadata: null,
  uploadedBy: 'user-1',
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  tags: [],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The list reloads with the one document, every other load succeeds empty,
 * and `action` answers the POST / DELETE.
 */
function serve(action: () => Response) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'DELETE') return Promise.resolve(action());
    if (url.includes('/knowledge/documents?')) {
      return Promise.resolve(json(200, { success: true, data: [DOC] }));
    }
    return Promise.resolve(json(200, { success: true, data: {} }));
  });
}

describe('ManageTab — failed actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch;
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a failed Rechunk directly above the table and focuses it', async () => {
    serve(() =>
      json(409, { success: false, error: { code: 'CONFLICT', message: 'Document is processing' } })
    );
    const user = userEvent.setup();
    render(<ManageTab documents={[DOC]} onRefresh={vi.fn()} />);

    const rechunk = screen
      .getAllByRole('button', { name: /rechunk/i })
      .find((b) => !b.hasAttribute('aria-haspopup'));
    await user.click(rechunk!);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn\'t rechunk "My Custom Doc": Document is processing');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('shows a failed Delete in the same box above the table', async () => {
    serve(() =>
      json(403, { success: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } })
    );
    const user = userEvent.setup();
    render(<ManageTab documents={[DOC]} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /document actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^delete$/i }));
    await user.click(await screen.findByRole('button', { name: /^yes$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn\'t delete "My Custom Doc": Not allowed');
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('table'));
    expect(alert).toHaveFocus();
  });

  it('shows a failed Load Patterns directly above the row holding its button', async () => {
    serve(() =>
      json(500, {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Seed data not found' },
      })
    );
    const user = userEvent.setup();
    render(<ManageTab documents={[]} onRefresh={vi.fn()} />);

    const load = screen.getByRole('button', { name: /load agentic design patterns/i });
    await user.click(load);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Seed data not found');
    expect(alert.nextElementSibling).toContainElement(load);
    expect(alert).toHaveFocus();
  });

  it('keeps the upload dialog open when a bulk upload refused some files, showing which', async () => {
    const onRefresh = vi.fn();
    serve(() =>
      json(200, {
        success: true,
        data: {
          results: [
            { fileName: 'a.md', status: 'ok' },
            { fileName: 'b.md', status: 'error', error: 'Duplicate document' },
          ],
        },
      })
    );
    const user = userEvent.setup();
    render(<ManageTab documents={[DOC]} onRefresh={onRefresh} />);

    await user.click(screen.getByRole('button', { name: /upload document/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/upload documents/i), {
      target: {
        files: [
          new File(['# A'], 'a.md', { type: 'text/markdown' }),
          new File(['# B'], 'b.md', { type: 'text/markdown' }),
        ],
      },
    });
    await user.click(await screen.findByRole('button', { name: /upload 2 files/i }));

    // The list refreshed for the file that landed...
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    // ...and the dialog stayed open with the refusal in it.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('b.md: Duplicate document');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toContainElement(alert);
  });

  it('holds the upload dialog open on Escape while the upload is in flight', async () => {
    let answer: (r: Response) => void = () => {};
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>((r) => (answer = r));
      if (url.includes('/knowledge/documents?')) {
        return Promise.resolve(json(200, { success: true, data: [DOC] }));
      }
      return Promise.resolve(json(200, { success: true, data: {} }));
    });
    const user = userEvent.setup();
    render(<ManageTab documents={[DOC]} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /upload document/i }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/upload documents/i), {
      target: { files: [new File(['# A'], 'a.md', { type: 'text/markdown' })] },
    });
    await user.click(await screen.findByRole('button', { name: /^upload\s*$/i }));
    await screen.findByRole('button', { name: /uploading/i });

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // The late failure lands in the dialog that is still open.
    answer(json(422, { success: false, error: { code: 'VALIDATION_ERROR', message: 'Bad file' } }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Bad file');
    expect(screen.getByRole('dialog')).toContainElement(alert);
  });
});
