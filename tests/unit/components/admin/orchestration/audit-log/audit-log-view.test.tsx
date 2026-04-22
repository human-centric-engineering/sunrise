/**
 * Tests for `components/admin/orchestration/audit-log/audit-log-view.tsx`
 *
 * Key behaviours:
 * - Loading state on initial mount
 * - Renders audit entries (timestamp, action badge, entity, user, IP)
 * - Empty state: "No audit entries found."
 * - Search filter: shows only matching entries (by action, entityName, user)
 * - Expand row to reveal change diff JSON
 * - Pagination: next/prev buttons, shows page N / totalPages
 * - Refresh button re-fetches
 * - actionBadgeVariant: .create → default, .update → secondary, .delete → destructive, other → outline
 *
 * @see components/admin/orchestration/audit-log/audit-log-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLogView } from '@/components/admin/orchestration/audit-log/audit-log-view';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    ADMIN: {
      ORCHESTRATION: {
        AUDIT_LOG: '/api/v1/admin/orchestration/audit-log',
      },
    },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    userId: 'user-1',
    action: 'agent.create',
    entityType: 'agent',
    entityId: 'agent-1',
    entityName: 'Support Bot',
    changes: null,
    metadata: null,
    clientIp: '127.0.0.1',
    createdAt: '2026-01-15T10:00:00.000Z',
    user: { id: 'user-1', name: 'Alice Admin', email: 'alice@example.com' },
    ...overrides,
  };
}

function mockFetchSuccess(entries: unknown[], total = entries.length) {
  const body = JSON.stringify({ success: true, data: entries, meta: { total } });
  // Use mockImplementation to create a fresh Response per call (body can only be consumed once)
  globalThis.fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuditLogView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetchSuccess([]);
  });

  // ── Loading ───────────────────────────────────────────────────────────────

  it('shows loading message on initial mount', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    render(<AuditLogView />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it('shows "No audit entries found." when list is empty', async () => {
    mockFetchSuccess([]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('No audit entries found.')).toBeInTheDocument();
    });
  });

  // ── Entry rows ────────────────────────────────────────────────────────────

  it('renders action badge, entity name, user, and IP', async () => {
    mockFetchSuccess([makeEntry()]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('agent.create')).toBeInTheDocument();
      expect(screen.getByText('Support Bot')).toBeInTheDocument();
      expect(screen.getByText('Alice Admin')).toBeInTheDocument();
      expect(screen.getByText('127.0.0.1')).toBeInTheDocument();
    });
  });

  it('shows "—" for null entityName (falls back to entityId)', async () => {
    mockFetchSuccess([makeEntry({ entityName: null, entityId: null })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('—')).toBeInTheDocument();
    });
  });

  it('shows "—" for null clientIp', async () => {
    mockFetchSuccess([makeEntry({ clientIp: null })]);
    render(<AuditLogView />);
    await waitFor(() => {
      // Both entityName null fallback and IP null fallback → two "—" cells
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Action badge variants ──────────────────────────────────────────────────

  it('renders .update action without throwing', async () => {
    mockFetchSuccess([makeEntry({ action: 'agent.update' })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('agent.update')).toBeInTheDocument();
    });
  });

  it('renders .delete action without throwing', async () => {
    mockFetchSuccess([makeEntry({ action: 'agent.delete' })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('agent.delete')).toBeInTheDocument();
    });
  });

  it('renders unknown action (outline variant) without throwing', async () => {
    mockFetchSuccess([makeEntry({ action: 'system.tick' })]);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('system.tick')).toBeInTheDocument();
    });
  });

  // ── Expand row ────────────────────────────────────────────────────────────

  it('expands row to show changes JSON on click', async () => {
    const user = userEvent.setup();
    const changes = { name: { from: 'Old', to: 'New' } };
    mockFetchSuccess([makeEntry({ changes })]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('agent.create'));

    await user.click(screen.getByText('Support Bot'));

    await waitFor(() => {
      expect(screen.getByText(/"from": "Old"/)).toBeInTheDocument();
    });
  });

  it('collapses row on second click', async () => {
    const user = userEvent.setup();
    const changes = { name: { from: 'Old', to: 'New' } };
    mockFetchSuccess([makeEntry({ changes })]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    await user.click(screen.getByText('Support Bot'));
    await waitFor(() => screen.getByText(/"from": "Old"/));

    await user.click(screen.getByText('Support Bot'));
    await waitFor(() => {
      expect(screen.queryByText(/"from": "Old"/)).not.toBeInTheDocument();
    });
  });

  it('does not render change diff if changes is null', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry({ changes: null })]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));
    await user.click(screen.getByText('Support Bot'));

    expect(screen.queryByRole('code')).not.toBeInTheDocument();
  });

  // ── Search filter ─────────────────────────────────────────────────────────

  it('filters entries by action text', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([
      makeEntry({ id: 'e1', action: 'agent.create', entityName: 'Bot A' }),
      makeEntry({ id: 'e2', action: 'workflow.delete', entityName: 'Flow X' }),
    ]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Bot A'));

    await user.type(screen.getByPlaceholderText(/filter by action/i), 'workflow');

    expect(screen.queryByText('Bot A')).not.toBeInTheDocument();
    expect(screen.getByText('Flow X')).toBeInTheDocument();
  });

  it('filters entries by user name', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([
      makeEntry({ id: 'e1', user: { id: 'u1', name: 'Alice', email: 'a@x.com' }, entityName: 'X' }),
      makeEntry({ id: 'e2', user: { id: 'u2', name: 'Bob', email: 'b@x.com' }, entityName: 'Y' }),
    ]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Alice'));

    await user.type(screen.getByPlaceholderText(/filter by action/i), 'Bob');

    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  // ── Refresh ───────────────────────────────────────────────────────────────

  it('re-fetches when Refresh button is clicked', async () => {
    const user = userEvent.setup();
    mockFetchSuccess([makeEntry()]);

    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    const callsBefore = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => {
      const callsAfter = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it('shows total entry count', async () => {
    mockFetchSuccess([makeEntry()], 42);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('42 entries')).toBeInTheDocument();
    });
  });

  it('shows "1 entry" for single entry', async () => {
    mockFetchSuccess([makeEntry()], 1);
    render(<AuditLogView />);
    await waitFor(() => {
      expect(screen.getByText('1 entry')).toBeInTheDocument();
    });
  });

  it('next page button is disabled when total fits on one page', async () => {
    mockFetchSuccess([makeEntry()], 5); // 5 total, 25 per page → 1 page → totalPages = 1
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    // Page indicator: "1 / 1"
    expect(screen.getByText(/1 \/ 1/)).toBeInTheDocument();

    // The last button in the toolbar is Next — it should be disabled (page >= totalPages)
    const buttons = screen.getAllByRole('button');
    const nextButton = buttons[buttons.length - 1];
    expect(nextButton).toBeDisabled();
  });

  it('prev page button is disabled on first page', async () => {
    mockFetchSuccess([makeEntry()], 5);
    render(<AuditLogView />);
    await waitFor(() => screen.getByText('Support Bot'));

    // Prev is second-to-last button (Refresh, Prev, Next order)
    const buttons = screen.getAllByRole('button');
    const prevButton = buttons[buttons.length - 2];
    expect(prevButton).toBeDisabled();
  });

  it('non-ok fetch response does not crash the component', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 500 })));
    render(<AuditLogView />);
    // Should not throw — component stays in loading state or shows empty
    await waitFor(() => {
      expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    });
  });
});
