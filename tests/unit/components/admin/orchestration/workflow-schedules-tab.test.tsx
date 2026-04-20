/**
 * WorkflowSchedulesTab Tests
 *
 * Test Coverage:
 * - Renders empty state when no schedules
 * - Create button opens dialog
 * - Renders schedule list when schedules exist
 *
 * @see components/admin/orchestration/workflow-schedules-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowSchedulesTab } from '@/components/admin/orchestration/workflow-schedules-tab';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { apiClient } from '@/lib/api/client';

const EMPTY_DATA = { schedules: [] };

const POPULATED_DATA = {
  schedules: [
    {
      id: 'sched-1',
      name: 'Daily Morning Run',
      cronExpression: '0 9 * * *',
      isEnabled: true,
      nextRunAt: '2026-04-20T09:00:00Z',
      inputTemplate: null,
      createdAt: '2026-04-01T00:00:00Z',
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowSchedulesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders empty state', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(EMPTY_DATA);

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
    });
  });

  it('create button opens dialog', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(EMPTY_DATA);
    const user = userEvent.setup();

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /new schedule/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(document.getElementById('schedule-name')).toBeInTheDocument();
      expect(document.getElementById('schedule-cron')).toBeInTheDocument();
    });
  });

  it('renders schedule list', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(POPULATED_DATA);

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText('Daily Morning Run')).toBeInTheDocument();
      expect(screen.getByText('0 9 * * *')).toBeInTheDocument();
    });
  });
});
