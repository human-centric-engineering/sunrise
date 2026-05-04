/**
 * Tests for `components/admin/orchestration/agents/widget-appearance-section.tsx`
 *
 * Behaviours:
 * - Loading state on mount
 * - Fetch populates form from server response
 * - Save calls PATCH with the current form values
 * - Reset restores DEFAULT_WIDGET_CONFIG without saving
 * - Adding / removing conversation starters
 * - Client-side validation blocks save and surfaces error
 *
 * @see components/admin/orchestration/agents/widget-appearance-section.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WidgetAppearanceSection } from '@/components/admin/orchestration/agents/widget-appearance-section';

const mockGet = vi.fn();
const mockPatch = vi.fn();

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
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

const AGENT_ID = 'agent-1';

const DEFAULTS = {
  primaryColor: '#2563eb',
  surfaceColor: '#ffffff',
  textColor: '#111827',
  fontFamily: '-apple-system, sans-serif',
  headerTitle: 'Chat',
  headerSubtitle: '',
  inputPlaceholder: 'Type a message…',
  sendLabel: 'Send',
  conversationStarters: [],
  footerText: '',
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe('WidgetAppearanceSection', () => {
  it('shows a loading state until the initial GET resolves', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    expect(screen.getByText(/Loading appearance/i)).toBeInTheDocument();
  });

  it('populates form fields from the server response', async () => {
    mockGet.mockResolvedValue({
      config: {
        ...DEFAULTS,
        primaryColor: '#16a34a',
        headerTitle: 'Council Planning',
        conversationStarters: ['How do I apply?'],
      },
    });
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Council Planning')).toBeInTheDocument();
    });
    // Two inputs share the colour value (native picker + hex text input);
    // assert at least one carries it.
    expect(screen.getAllByDisplayValue('#16a34a').length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('How do I apply?')).toBeInTheDocument();
  });

  it('saves the current form via PATCH and shows a saved confirmation', async () => {
    mockGet.mockResolvedValue({ config: DEFAULTS });
    mockPatch.mockResolvedValue({ config: { ...DEFAULTS, headerTitle: 'New' } });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);

    await waitFor(() => screen.getByDisplayValue('Chat'));

    const titleInput = screen.getByDisplayValue('Chat');
    await user.clear(titleInput);
    await user.type(titleInput, 'New');

    await user.click(screen.getByRole('button', { name: /Save appearance/i }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        `/api/v1/admin/orchestration/agents/${AGENT_ID}/widget-config`,
        expect.objectContaining({
          body: expect.objectContaining({ headerTitle: 'New' }),
        })
      );
    });
    await waitFor(() => expect(screen.getByText(/^Saved$/)).toBeInTheDocument());
  });

  it('blocks save when the primary colour is not a valid hex', async () => {
    mockGet.mockResolvedValue({ config: DEFAULTS });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);

    await waitFor(() => screen.getByRole('textbox', { name: /^Primary/ }));

    // Target the hex *text* input (role=textbox), not the native colour picker
    const primary = screen.getByRole('textbox', { name: /^Primary/ });
    await user.clear(primary);
    await user.type(primary, 'not-a-colour');

    await user.click(screen.getByRole('button', { name: /Save appearance/i }));

    expect(mockPatch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Primary colour must be a 6-digit hex/i);
  });

  it('blocks save when a conversation starter is empty', async () => {
    mockGet.mockResolvedValue({ config: DEFAULTS });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);

    await waitFor(() => screen.getByRole('button', { name: /Add starter/i }));
    await user.click(screen.getByRole('button', { name: /Add starter/i }));
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));

    expect(mockPatch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Conversation starter 1 is empty/i);
  });

  it('removes a conversation starter when the trash button is clicked', async () => {
    mockGet.mockResolvedValue({
      config: { ...DEFAULTS, conversationStarters: ['First', 'Second'] },
    });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);

    await waitFor(() => screen.getByDisplayValue('First'));
    expect(screen.getByDisplayValue('Second')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Remove starter 1/i }));

    expect(screen.queryByDisplayValue('First')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Second')).toBeInTheDocument();
  });

  it('shows a contrast warning when surface vs text contrast is below WCAG AA', async () => {
    mockGet.mockResolvedValue({
      config: { ...DEFAULTS, surfaceColor: '#ffffff', textColor: '#dddddd' },
    });
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('Chat'));
    expect(screen.getByRole('status')).toHaveTextContent(/below the WCAG AA threshold/i);
  });

  it('does not show a contrast warning when contrast is good (default colours)', async () => {
    mockGet.mockResolvedValue({ config: DEFAULTS });
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('Chat'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders a char counter for the font-family field', async () => {
    mockGet.mockResolvedValue({ config: { ...DEFAULTS, fontFamily: 'Inter, sans-serif' } });
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('Inter, sans-serif'));
    expect(screen.getByText(`${'Inter, sans-serif'.length}/200`)).toBeInTheDocument();
  });

  it('reset restores defaults locally without calling PATCH', async () => {
    mockGet.mockResolvedValue({
      config: { ...DEFAULTS, headerTitle: 'Custom', primaryColor: '#16a34a' },
    });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);

    await waitFor(() => screen.getByDisplayValue('Custom'));
    await user.click(screen.getByRole('button', { name: /Reset to defaults/i }));

    expect(screen.getByDisplayValue('Chat')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('#2563eb').length).toBeGreaterThan(0);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
