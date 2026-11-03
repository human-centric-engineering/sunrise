// @vitest-environment happy-dom

/**
 * WaitlistForm component tests (§125 t-974)
 *
 * What the form sends (fork fields, the list, the honeypot, attribution), what
 * it refuses before sending, and what it shows: one success state whatever
 * the server did, the closed message, and a server refusal beside the button.
 *
 * @see components/waitlist/waitlist-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockPost, MockAPIClientError } = vi.hoisted(() => {
  class MockAPIClientError extends Error {
    code: string;
    details?: Record<string, unknown>;
    constructor(message: string, code: string, details?: Record<string, unknown>) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.details = details;
    }
  }
  return { mockPost: vi.fn(), MockAPIClientError };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: mockPost },
  APIClientError: MockAPIClientError,
}));

import { WaitlistForm } from '@/components/waitlist/waitlist-form';
import type { WaitlistFieldShape } from '@/lib/validations/waitlist';

const FIELDS: WaitlistFieldShape[] = [
  {
    key: 'useCase',
    label: 'What would you use it for?',
    kind: 'textarea',
    help: 'A sentence is plenty.',
  },
  { key: 'studio', label: 'Studio name', kind: 'text', required: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue({ message: 'Thanks for joining the waitlist.' });
  window.history.replaceState({}, '', '/early?utm_source=instagram&utm_campaign=launch&other=x');
});

describe('WaitlistForm', () => {
  it('sends the address, the fork’s answers, the list, an empty honeypot and the URL’s UTM tags', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<WaitlistForm fields={FIELDS} list="beta" />);

    // Act
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText(/Studio name/), 'Analytical Sounds');
    await user.type(screen.getByRole('textbox', { name: /What would you use it for/ }), 'Sampling');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    // Assert
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, { body }] = mockPost.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(url).toBe('/api/v1/waitlist');
    expect(body).toMatchObject({
      email: 'ada@example.com',
      name: null,
      list: 'beta',
      details: { useCase: 'Sampling', studio: 'Analytical Sounds' },
      website: '',
      utm_source: 'instagram',
      utm_campaign: 'launch',
    });
    expect(body).not.toHaveProperty('other');
    expect(body).not.toHaveProperty('utm_medium');
  });

  it('sends a chosen select answer and the referring page', async () => {
    // Arrange — the visitor arrived from another site
    Object.defineProperty(document, 'referrer', {
      value: 'https://news.example.org/story',
      configurable: true,
    });
    const user = userEvent.setup();
    render(
      <WaitlistForm
        fields={[
          {
            key: 'role',
            label: 'Role',
            kind: 'select',
            required: true,
            options: [
              { value: 'dj', label: 'DJ' },
              { value: 'producer', label: 'Producer' },
            ],
          },
        ]}
        list="default"
      />
    );

    // Act
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Producer' }));
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    // Assert
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [, { body }] = mockPost.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(body).toMatchObject({
      details: { role: 'producer' },
      referrer: 'https://news.example.org/story',
    });
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
  });

  it('an optional select left unchosen does not block the submit', async () => {
    const user = userEvent.setup();
    render(
      <WaitlistForm
        fields={[
          { key: 'role', label: 'Role', kind: 'select', options: [{ value: 'dj', label: 'DJ' }] },
        ]}
        list="default"
      />
    );

    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
  });

  it('a required select left unchosen blocks the submit', async () => {
    const user = userEvent.setup();
    render(
      <WaitlistForm
        fields={[
          {
            key: 'role',
            label: 'Role',
            kind: 'select',
            required: true,
            options: [{ value: 'dj', label: 'DJ' }],
          },
        ]}
        list="default"
      />
    );

    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    expect(await screen.findByText('Choose one of the options for Role')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('shows the submitting label and disables the button while the join is in flight', async () => {
    // Arrange — a request that has not answered yet
    let answer: (v: unknown) => void = () => undefined;
    mockPost.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const user = userEvent.setup();
    render(
      <WaitlistForm fields={[]} list="default" copy={{ submittingLabel: 'Saving your place…' }} />
    );

    // Act
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    // Assert
    const button = await screen.findByRole('button', { name: /Saving your place/ });
    expect(button).toBeDisabled();
    answer({ message: 'ok' });
    expect(await screen.findByText('Thanks for joining')).toBeInTheDocument();
  });

  it('refuses a missing required answer before sending anything', async () => {
    const user = userEvent.setup();
    render(<WaitlistForm fields={FIELDS} list="default" />);

    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    expect(await screen.findByText('Studio name is required')).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('shows the success state with the fork’s copy', async () => {
    const user = userEvent.setup();
    render(
      <WaitlistForm
        fields={[]}
        list="default"
        copy={{ successTitle: 'You’re in', successMessage: 'See you at launch.' }}
      />
    );

    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    expect(await screen.findByText('You’re in')).toBeInTheDocument();
    expect(screen.getByText('See you at launch.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('a closed list shows the closed message and no form', () => {
    render(
      <WaitlistForm
        fields={FIELDS}
        list="default"
        closed
        copy={{ closedMessage: 'Wave 1 is full.' }}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Wave 1 is full.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a list closed since the page rendered shows the fork’s closed message, not a save error', async () => {
    // Arrange — the route answers 409 WAITLIST_CLOSED
    mockPost.mockRejectedValue(
      new MockAPIClientError(
        'This waitlist is not taking new sign-ups right now.',
        'WAITLIST_CLOSED'
      )
    );
    const user = userEvent.setup();
    render(<WaitlistForm fields={[]} list="default" copy={{ closedMessage: 'Wave 1 is full.' }} />);

    // Act
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    // Assert
    expect(await screen.findByRole('status')).toHaveTextContent('Wave 1 is full.');
    expect(screen.queryByText(/not taking new sign-ups/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the fork’s labels and placeholders', () => {
    render(
      <WaitlistForm
        fields={[
          { key: 'role', label: 'Rôle', kind: 'select', options: [{ value: 'dj', label: 'DJ' }] },
        ]}
        list="default"
        copy={{
          emailLabel: 'E-mail',
          emailPlaceholder: 'vous@exemple.fr',
          nameLabel: 'Prénom (facultatif)',
          optionalMarker: '(facultatif)',
          selectPlaceholder: 'Choisir',
          submitLabel: 'Rejoindre',
        }}
      />
    );

    expect(screen.getByLabelText('E-mail')).toHaveAttribute('placeholder', 'vous@exemple.fr');
    expect(screen.getByLabelText('Prénom (facultatif)')).toBeInTheDocument();
    expect(screen.getByText('(facultatif)')).toBeInTheDocument();
    expect(screen.getByText('Choisir')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rejoindre' })).toBeInTheDocument();
  });

  it('shows a server refusal beside the button and keeps the form', async () => {
    // Arrange — a refusal the form has no state of its own for
    mockPost.mockRejectedValue(new MockAPIClientError('This waitlist is full.', 'WAITLIST_FULL'));
    const user = userEvent.setup();
    render(<WaitlistForm fields={[]} list="default" />);

    // Act
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.click(screen.getByRole('button', { name: 'Join the waitlist' }));

    // Assert
    expect(await screen.findByText('This waitlist is full.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('renders the consent notice and field help the fork supplies', () => {
    render(
      <WaitlistForm
        fields={FIELDS}
        list="default"
        copy={{ consentNotice: <span>We’ll email you about the launch.</span> }}
      />
    );

    expect(screen.getByText('We’ll email you about the launch.')).toBeInTheDocument();
    // FieldHelp renders a trigger named for the field
    expect(screen.getAllByRole('button').length).toBeGreaterThan(1);
  });
});
