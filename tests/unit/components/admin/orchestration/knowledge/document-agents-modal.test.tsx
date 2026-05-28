/**
 * DocumentAgentsModal Component Tests
 *
 * @see components/admin/orchestration/knowledge/document-agents-modal.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentAgentsModal } from '@/components/admin/orchestration/knowledge/document-agents-modal';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function successBody(
  agents: Array<{
    id: string;
    name: string;
    slug: string;
    kind: string;
    knowledgeAccessMode: string;
    paths: Array<
      | { kind: 'full' }
      | { kind: 'direct' }
      | { kind: 'tag'; tagId: string; tagName: string; tagSlug: string }
      | { kind: 'system' }
    >;
  }>,
  documentScope: string = 'app'
) {
  return {
    ok: true,
    json: () => Promise.resolve({ success: true, data: { agents, documentScope } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DocumentAgentsModal — closed state', () => {
  it('does not fetch when open=false', () => {
    render(
      <DocumentAgentsModal
        documentId="doc-1"
        documentName="Sales Playbook"
        open={false}
        onOpenChange={vi.fn()}
      />
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('DocumentAgentsModal — open + happy path', () => {
  it('fetches the document agents endpoint when opened', async () => {
    mockFetch.mockResolvedValue(successBody([]));

    render(
      <DocumentAgentsModal
        documentId="doc-1"
        documentName="Sales Playbook"
        open
        onOpenChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents/doc-1/agents')
      );
    });
  });

  it('renders the empty state when no agents have access', async () => {
    mockFetch.mockResolvedValue(successBody([]));

    render(
      <DocumentAgentsModal
        documentId="doc-1"
        documentName="Sales Playbook"
        open
        onOpenChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/no active agents can access/i)).toBeInTheDocument();
    });
  });

  it('renders one row per agent with name + slug + per-path badges', async () => {
    mockFetch.mockResolvedValue(
      successBody([
        {
          id: 'a-1',
          name: 'Sales Bot',
          slug: 'sales-bot',
          kind: 'chat',
          knowledgeAccessMode: 'full',
          paths: [{ kind: 'full' }],
        },
        {
          id: 'a-2',
          name: 'Refund Bot',
          slug: 'refund-bot',
          kind: 'chat',
          knowledgeAccessMode: 'restricted',
          paths: [
            { kind: 'direct' },
            { kind: 'tag', tagId: 't-1', tagName: 'Refunds', tagSlug: 'refunds' },
          ],
        },
      ])
    );

    render(
      <DocumentAgentsModal
        documentId="doc-1"
        documentName="Sales Playbook"
        open
        onOpenChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Sales Bot')).toBeInTheDocument();
    });
    expect(screen.getByText('sales-bot')).toBeInTheDocument();
    expect(screen.getByText('Refund Bot')).toBeInTheDocument();
    expect(screen.getByText('Full access')).toBeInTheDocument();
    expect(screen.getByText('Direct grant')).toBeInTheDocument();
    expect(screen.getByText('Tag: Refunds')).toBeInTheDocument();
  });

  it('shows the System scope chip when documentScope is "system"', async () => {
    mockFetch.mockResolvedValue(
      successBody(
        [
          {
            id: 'a-1',
            name: 'Bot',
            slug: 'bot',
            kind: 'chat',
            knowledgeAccessMode: 'restricted',
            paths: [{ kind: 'system' }],
          },
        ],
        'system'
      )
    );

    render(
      <DocumentAgentsModal
        documentId="doc-1"
        documentName="Built-in Doc"
        open
        onOpenChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('System scope')).toBeInTheDocument();
    });
    expect(screen.getByText('System document')).toBeInTheDocument();
  });

  it('renders the non-chat kind badge when an agent is not a chat agent', async () => {
    mockFetch.mockResolvedValue(
      successBody([
        {
          id: 'a-1',
          name: 'Quality Judge',
          slug: 'judge-bot',
          kind: 'judge',
          knowledgeAccessMode: 'full',
          paths: [{ kind: 'full' }],
        },
      ])
    );

    render(
      <DocumentAgentsModal documentId="doc-1" documentName="Doc" open onOpenChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText('Quality Judge')).toBeInTheDocument();
    });
    // The "judge" kind chip renders next to the agent name. Using
    // `judge-bot` for the slug above keeps this assertion specific to
    // the kind badge.
    expect(screen.getByText('judge')).toBeInTheDocument();
  });
});

describe('DocumentAgentsModal — error paths', () => {
  it('surfaces an error message when the API returns a non-2xx response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ success: false, error: { message: 'boom' } }),
    });

    render(
      <DocumentAgentsModal documentId="doc-1" documentName="Doc" open onOpenChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText(/Failed to load agents \(500\)/i)).toBeInTheDocument();
    });
  });

  it('surfaces an error message when the network throws', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));

    render(
      <DocumentAgentsModal documentId="doc-1" documentName="Doc" open onOpenChange={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText('offline')).toBeInTheDocument();
    });
  });
});

describe('DocumentAgentsModal — close button', () => {
  it('invokes onOpenChange(false) when Close is clicked', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    mockFetch.mockResolvedValue(successBody([]));

    render(
      <DocumentAgentsModal documentId="doc-1" documentName="Doc" open onOpenChange={handleClose} />
    );

    // shadcn Dialog renders both a visible "Close" footer button and a
    // top-right X icon button (sr-only label "Close"). Pick the footer
    // button by its visible text-only match.
    const closeButtons = await screen.findAllByRole('button', { name: /close/i });
    const footerClose = closeButtons.find((b) => b.textContent?.trim() === 'Close');
    expect(footerClose).toBeDefined();
    await user.click(footerClose!);
    expect(handleClose).toHaveBeenCalledWith(false);
  });
});
