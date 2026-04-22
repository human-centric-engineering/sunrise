/**
 * WorkflowSchedulesTab Tests
 *
 * Test Coverage:
 * - Renders empty state when no schedules
 * - Create button opens dialog
 * - Renders schedule list when schedules exist
 * - Loading state shows spinner
 * - Error state shows error banner
 * - Create schedule happy path
 * - Input template JSON validation (invalid JSON)
 * - Input template JSON validation (non-object JSON)
 * - Toggle enabled calls patch API
 * - Delete schedule calls delete API
 * - Create failure shows inline error and keeps dialog open
 * - Create button disabled until name and cron are filled
 *
 * @see components/admin/orchestration/workflow-schedules-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkflowSchedulesTab } from '@/components/admin/orchestration/workflow-schedules-tab';
import { API } from '@/lib/api/endpoints';

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

  // ── Kept tests (do not modify) ─────────────────────────────────────────────

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

  // ── Added tests ────────────────────────────────────────────────────────────

  it('shows a loading spinner before the fetch resolves', async () => {
    // Arrange: hold the promise unresolved so we can inspect the loading state
    let resolve: (value: unknown) => void;
    const pending = new Promise((res) => {
      resolve = res;
    });
    vi.mocked(apiClient.get).mockReturnValue(pending as never);

    // Act
    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    // Assert: loading spinner is visible before resolution
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();

    // Cleanup: resolve so no open promise leaks
    resolve!(EMPTY_DATA);
    await waitFor(() => {
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();
    });
  });

  it('shows an error banner when the fetch rejects', async () => {
    // Arrange
    vi.mocked(apiClient.get).mockRejectedValue(new Error('Network error'));

    // Act
    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    // Assert: red-background error banner with the expected message
    await waitFor(() => {
      expect(screen.getByText(/failed to load schedules/i)).toBeInTheDocument();
    });
    const banner = screen.getByText(/failed to load schedules/i).closest('div');
    expect(banner?.className).toMatch(/bg-red/);
  });

  it('create schedule happy path — calls post with correct URL and body, then refetches', async () => {
    // Arrange
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue(EMPTY_DATA);
    vi.mocked(apiClient.post).mockResolvedValue({});

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
    });

    // Open dialog
    await user.click(screen.getByRole('button', { name: /new schedule/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Fill in name and cron
    await user.type(document.getElementById('schedule-name')!, 'My Schedule');
    await user.type(document.getElementById('schedule-cron')!, '0 9 * * *');

    // Act: click Create
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // Assert: post called with correct URL and body
    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.workflowSchedules('wf-1'),
        {
          body: {
            name: 'My Schedule',
            cronExpression: '0 9 * * *',
            inputTemplate: {},
            isEnabled: true,
          },
        }
      );
    });

    // Assert: dialog closed and schedules refetched (get called a second time)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('shows inline error for invalid JSON in input template, post not called', async () => {
    // Arrange
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue(EMPTY_DATA);
    vi.mocked(apiClient.post).mockResolvedValue({});

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /new schedule/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // Fill required fields + invalid JSON
    await user.type(document.getElementById('schedule-name')!, 'My Schedule');
    await user.type(document.getElementById('schedule-cron')!, '0 9 * * *');
    await user.type(document.getElementById('schedule-input')!, 'not valid json');

    // Act
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // Assert: inline error shown, post NOT called
    await waitFor(() => {
      expect(screen.getByText(/input template must be valid json/i)).toBeInTheDocument();
    });
    expect(apiClient.post).toHaveBeenCalledTimes(0);
  });

  it('shows inline error for non-object JSON (array) in input template, post not called', async () => {
    // Arrange
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue(EMPTY_DATA);
    vi.mocked(apiClient.post).mockResolvedValue({});

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /new schedule/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    // Fill required fields + array JSON (valid JSON but not an object)
    // Use paste to avoid userEvent special-character parsing of '[' and ']'
    await user.type(document.getElementById('schedule-name')!, 'My Schedule');
    await user.type(document.getElementById('schedule-cron')!, '0 9 * * *');
    await user.click(document.getElementById('schedule-input')!);
    await user.paste('[]');

    // Act
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // Assert: non-object error shown, post NOT called
    await waitFor(() => {
      expect(screen.getByText(/input template must be a json object/i)).toBeInTheDocument();
    });
    expect(apiClient.post).toHaveBeenCalledTimes(0);
  });

  it('toggle enabled — calls patch with correct URL and body, then refetches', async () => {
    // Arrange
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue(POPULATED_DATA);
    vi.mocked(apiClient.patch).mockResolvedValue({});

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText('Daily Morning Run')).toBeInTheDocument();
    });

    // Act: click the Switch (schedule is initially enabled → toggling to disabled)
    const toggle = screen.getByRole('switch', { name: /toggle daily morning run/i });
    await user.click(toggle);

    // Assert: patch called with workflowScheduleById URL and isEnabled: false
    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.workflowScheduleById('wf-1', 'sched-1'),
        { body: { isEnabled: false } }
      );
    });

    // Assert: refetch triggered (get called a second time)
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('delete schedule — opens confirmation, calls delete with correct URL, refetches, and closes dialog', async () => {
    // Arrange
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue(POPULATED_DATA);
    vi.mocked(apiClient.delete).mockResolvedValue({});

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText('Daily Morning Run')).toBeInTheDocument();
    });

    // Act: click trash icon to open confirmation dialog
    const trashButton = screen.getByTitle(/delete schedule/i);
    await user.click(trashButton);

    // Assert: AlertDialog opens (rendered in Radix portal — query via document.body)
    await waitFor(() => {
      expect(within(document.body).getByText(/delete schedule\?/i)).toBeInTheDocument();
    });

    // Act: click the "Delete" action button
    const deleteButton = within(document.body).getByRole('button', { name: /^delete$/i });
    await user.click(deleteButton);

    // Assert: delete called with correct URL
    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith(
        API.ADMIN.ORCHESTRATION.workflowScheduleById('wf-1', 'sched-1')
      );
    });

    // Assert: refetch triggered (get called a second time)
    expect(apiClient.get).toHaveBeenCalledTimes(2);

    // Assert: confirmation dialog closed
    await waitFor(() => {
      expect(within(document.body).queryByText(/delete schedule\?/i)).not.toBeInTheDocument();
    });
  });

  it('create failure — shows error message inside dialog and keeps dialog open', async () => {
    // Arrange
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue(EMPTY_DATA);
    vi.mocked(apiClient.post).mockRejectedValue(new Error('Cron invalid'));

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /new schedule/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    await user.type(document.getElementById('schedule-name')!, 'My Schedule');
    await user.type(document.getElementById('schedule-cron')!, '* * * * *');

    // Act
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    // Assert: error message rendered inside dialog, dialog remains open
    await waitFor(() => {
      expect(screen.getByText(/cron invalid/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Create button is disabled when name or cron is empty, enabled when both are filled', async () => {
    // Arrange
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue(EMPTY_DATA);

    render(<WorkflowSchedulesTab workflowId="wf-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no schedules yet/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /new schedule/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    const createButton = screen.getByRole('button', { name: /^create$/i });

    // Assert: disabled with both fields empty
    expect(createButton).toBeDisabled();

    // Fill only name — still disabled
    await user.type(document.getElementById('schedule-name')!, 'My Schedule');
    expect(createButton).toBeDisabled();

    // Fill cron — now enabled
    await user.type(document.getElementById('schedule-cron')!, '0 9 * * *');
    expect(createButton).not.toBeDisabled();
  });
});
