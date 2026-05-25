/**
 * TriggersTable smoke tests.
 *
 * Focused on the load-bearing client behaviours:
 *   - Empty state renders the educational concept page (headings + channel list)
 *     rather than the table.
 *   - Populated state renders one row per trigger with the channel chip +
 *     webhook URL + workflow link + enabled state.
 *   - `adapter not registered` badge appears when a row's channel is missing
 *     from `enabledChannels` — the load-bearing signal that an operator's
 *     trigger will 404 until env vars are wired.
 *   - Delete button calls apiClient.delete with the correct URL and refreshes
 *     the router on success.
 *
 * @see components/admin/orchestration/triggers-table.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockPush = vi.fn();
const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),

  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { delete: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  TriggersTable,
  type TriggerListItem,
} from '@/components/admin/orchestration/triggers-table';
import { apiClient } from '@/lib/api/client';

function makeTrigger(overrides: Partial<TriggerListItem> = {}): TriggerListItem {
  return {
    id: 'trig_1',
    channel: 'twilio',
    name: 'SMS intake',
    workflowId: 'wf_1',
    metadata: { conversationAgentId: 'agent-1' },
    isEnabled: true,
    hasSigningSecret: false,
    lastFiredAt: null,
    createdAt: '2026-05-24T10:00:00Z',
    workflow: { id: 'wf_1', name: 'Inbound conversation', slug: 'inbound-conv', isActive: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default confirm() → true so handleDelete proceeds; tests that want
  // to assert refusal override locally.
  vi.stubGlobal(
    'confirm',
    vi.fn(() => true)
  );
  vi.stubGlobal('alert', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TriggersTable — empty state', () => {
  it('renders the educational empty state (headline + channel list) when triggers is empty', () => {
    render(<TriggersTable triggers={[]} enabledChannels={['twilio', 'hmac']} />);

    expect(screen.getByText('No inbound triggers yet')).toBeInTheDocument();
    // Channel list contains all 5 channels.
    expect(screen.getByText(/SMS \+ Twilio-routed WhatsApp/)).toBeInTheDocument();
    expect(screen.getByText(/Meta WhatsApp direct/)).toBeInTheDocument();
    // "Create your first trigger" CTA.
    expect(screen.getByText('Create your first trigger')).toBeInTheDocument();
  });
});

describe('TriggersTable — populated', () => {
  it('renders one row per trigger with channel + name + workflow link + webhook URL', () => {
    render(<TriggersTable triggers={[makeTrigger()]} enabledChannels={['twilio']} />);

    expect(screen.getByText('twilio')).toBeInTheDocument();
    expect(screen.getByText('SMS intake')).toBeInTheDocument();
    expect(screen.getByText('Inbound conversation')).toBeInTheDocument();
    expect(screen.getByText('/api/v1/inbound/twilio/inbound-conv')).toBeInTheDocument();
    expect(screen.getByText('enabled')).toBeInTheDocument();
  });

  it('shows the "adapter not registered" warning when the trigger channel is not in enabledChannels', () => {
    render(<TriggersTable triggers={[makeTrigger()]} enabledChannels={[]} />);
    expect(screen.getByText('adapter not registered')).toBeInTheDocument();
  });

  it('hides the "adapter not registered" warning when the channel IS registered', () => {
    render(<TriggersTable triggers={[makeTrigger()]} enabledChannels={['twilio']} />);
    expect(screen.queryByText('adapter not registered')).not.toBeInTheDocument();
  });

  it('shows the "per-trigger secret" badge for HMAC triggers with a signing secret', () => {
    render(
      <TriggersTable
        triggers={[makeTrigger({ channel: 'hmac', hasSigningSecret: true })]}
        enabledChannels={['hmac']}
      />
    );
    expect(screen.getByText('per-trigger secret')).toBeInTheDocument();
  });

  it('shows "disabled" badge when isEnabled is false', () => {
    render(
      <TriggersTable triggers={[makeTrigger({ isEnabled: false })]} enabledChannels={['twilio']} />
    );
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });
});

describe('TriggersTable — delete handler', () => {
  it('calls apiClient.delete with the correct URL and refreshes on success', async () => {
    vi.mocked(apiClient.delete).mockResolvedValue(undefined as never);

    render(
      <TriggersTable triggers={[makeTrigger({ id: 'trig_abc' })]} enabledChannels={['twilio']} />
    );

    fireEvent.click(screen.getByText('Delete'));

    // Microtask flush so the async handler completes.
    await new Promise((r) => setTimeout(r, 0));

    expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/admin/orchestration/triggers/trig_abc');
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('skips the delete call when the operator cancels the confirm dialog', () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false)
    );

    render(<TriggersTable triggers={[makeTrigger()]} enabledChannels={['twilio']} />);

    fireEvent.click(screen.getByText('Delete'));

    expect(apiClient.delete).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
