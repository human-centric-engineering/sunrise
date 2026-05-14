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
    await waitFor(() => expect(screen.getByText(/^Saved\b/)).toBeInTheDocument());
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

  it('shows an error when the initial GET fails', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    mockGet.mockRejectedValue(new APIClientError('Boom from server'));
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Boom from server/i));
  });

  it('shows a generic error when the initial GET rejects with a non-APIClientError', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load appearance/i)
    );
  });

  it('surfaces the APIClientError message when save fails', async () => {
    const { APIClientError } = await import('@/lib/api/client');
    mockGet.mockResolvedValue({ config: DEFAULTS });
    mockPatch.mockRejectedValue(new APIClientError('Server rejected'));
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('Chat'));
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Server rejected/i));
  });

  it('falls back to a generic error when save rejects with a non-APIClientError', async () => {
    mockGet.mockResolvedValue({ config: DEFAULTS });
    mockPatch.mockRejectedValue(new Error('network blip'));
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('Chat'));
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to save appearance/i)
    );
  });

  it('hides the Add starter button once 4 starters exist', async () => {
    mockGet.mockResolvedValue({
      config: { ...DEFAULTS, conversationStarters: ['a', 'b', 'c', 'd'] },
    });
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('a'));
    expect(screen.queryByRole('button', { name: /Add starter/i })).not.toBeInTheDocument();
  });

  it('updates a starter value when the input changes (covers updateStarter)', async () => {
    mockGet.mockResolvedValue({
      config: { ...DEFAULTS, conversationStarters: ['original'] },
    });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    const input = await screen.findByDisplayValue('original');
    await user.clear(input);
    await user.type(input, 'edited');
    expect(screen.getByDisplayValue('edited')).toBeInTheDocument();
  });

  it('renders "(empty)" placeholder in preview for blank starters', async () => {
    mockGet.mockResolvedValue({
      config: { ...DEFAULTS, conversationStarters: [''] },
    });
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('Chat'));
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });

  it('blocks save when the surface colour is invalid', async () => {
    mockGet.mockResolvedValue({ config: { ...DEFAULTS, surfaceColor: 'not-a-hex' } });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('not-a-hex'));
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));
    expect(mockPatch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Surface colour must be a 6-digit hex/i);
  });

  it('blocks save when the text colour is invalid', async () => {
    mockGet.mockResolvedValue({ config: { ...DEFAULTS, textColor: 'rgb(0,0,0)' } });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('rgb(0,0,0)'));
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Text colour must be a 6-digit hex/i);
  });

  it('blocks save when the font family contains disallowed characters', async () => {
    mockGet.mockResolvedValue({ config: { ...DEFAULTS, fontFamily: 'Inter; color: red' } });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    await waitFor(() => screen.getByDisplayValue('Inter; color: red'));
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Font family contains a disallowed/i);
  });

  it('blocks save when the header title is empty', async () => {
    mockGet.mockResolvedValue({ config: { ...DEFAULTS, headerTitle: 'X' } });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    const title = await screen.findByDisplayValue('X');
    await user.clear(title);
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Header title cannot be empty/i);
  });

  it('blocks save when the input placeholder is empty', async () => {
    mockGet.mockResolvedValue({ config: { ...DEFAULTS, inputPlaceholder: 'X' } });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    const placeholder = await screen.findByDisplayValue('X');
    await user.clear(placeholder);
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Input placeholder cannot be empty/i);
  });

  it('blocks save when the send-button label is empty', async () => {
    mockGet.mockResolvedValue({ config: { ...DEFAULTS, sendLabel: 'X' } });
    const user = userEvent.setup();
    render(<WidgetAppearanceSection agentId={AGENT_ID} />);
    const sendLabel = await screen.findByDisplayValue('X');
    await user.clear(sendLabel);
    await user.click(screen.getByRole('button', { name: /Save appearance/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Send button label cannot be empty/i);
  });
});
