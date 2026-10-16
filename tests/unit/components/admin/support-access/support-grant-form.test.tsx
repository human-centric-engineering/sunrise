// @vitest-environment happy-dom

/**
 * SupportGrantForm (§121 t-823): posts the owner's grant to the org's
 * support-grants route, with ADMIN and 24 hours unless they choose otherwise,
 * and shows the API's refusal as worded.
 *
 * @see components/admin/support-access/support-grant-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SupportGrantForm } from '@/components/admin/support-access/support-grant-form';
import { apiClient, APIClientError } from '@/lib/api/client';

const mockRefresh = vi.fn();

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter({ refresh: mockRefresh }) };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {
    code?: string;
    status?: number;
    constructor(message: string, code?: string, status?: number) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.status = status;
    }
  },
}));

// Radix Select does not open in happy-dom; drive a native <select> instead.
// The form has two: level first, then duration.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value }: { value: string }) => <option value={value}>{value}</option>,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const URL = '/api/v1/orgs/org-1/support-grants';

describe('SupportGrantForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants at ADMIN for 24 hours by default, then refreshes the page', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({});
    render(<SupportGrantForm orgId="org-1" replacesOpenGrant={false} />);

    await user.type(screen.getByLabelText(/^Reason/, { selector: 'textarea' }), 'Ticket 42');
    await user.click(screen.getByRole('button', { name: /Grant access/ }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(URL, {
        body: { level: 'ADMIN', reason: 'Ticket 42', durationHours: 24 },
      })
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('sends the level and duration the owner chose', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({});
    render(<SupportGrantForm orgId="org-1" replacesOpenGrant={false} />);

    const [level, duration] = screen.getAllByRole('combobox');
    await user.selectOptions(level, 'READ_ONLY');
    await user.selectOptions(duration, '168');
    await user.type(screen.getByLabelText(/^Reason/, { selector: 'textarea' }), 'Look only');
    await user.click(screen.getByRole('button', { name: /Grant access/ }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith(URL, {
        body: { level: 'READ_ONLY', reason: 'Look only', durationHours: 168 },
      })
    );
  });

  it('does not send without a reason', async () => {
    const user = userEvent.setup();
    render(<SupportGrantForm orgId="org-1" replacesOpenGrant={false} />);

    await user.click(screen.getByRole('button', { name: /Grant access/ }));

    expect(await screen.findByText('Say why support needs access')).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('says a grant replaces the open one', () => {
    render(<SupportGrantForm orgId="org-1" replacesOpenGrant />);

    expect(screen.getByText(/ends the current grant/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Replace grant/ })).toBeInTheDocument();
  });

  it('shows the API’s refusal as worded, and does not refresh', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Only an owner of this organisation may grant support access', 'X', 403)
    );
    render(<SupportGrantForm orgId="org-1" replacesOpenGrant={false} />);

    await user.type(screen.getByLabelText(/^Reason/, { selector: 'textarea' }), 'Ticket 42');
    await user.click(screen.getByRole('button', { name: /Grant access/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an owner of this organisation may grant support access'
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
