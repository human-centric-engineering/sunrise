// @vitest-environment happy-dom

/**
 * WaitlistLoginNotice: on the login page while the waitlist is on, a
 * sentence from the catalogue with a link to the join page (§138 t-1073).
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WaitlistLoginNotice } from '@/components/waitlist/waitlist-login-notice';
import { getWaitlistConfig } from '@/lib/waitlist/config';

vi.mock('@/lib/waitlist/config', () => ({ getWaitlistConfig: vi.fn() }));

describe('WaitlistLoginNotice', () => {
  it('renders nothing when the waitlist is off', () => {
    vi.mocked(getWaitlistConfig).mockReturnValue(null);

    const { container } = render(<WaitlistLoginNotice />);

    expect(container).toBeEmptyDOMElement();
  });

  it('links the join page inside the translated sentence', () => {
    vi.mocked(getWaitlistConfig).mockReturnValue({ joinPath: '/early-access' } as ReturnType<
      typeof getWaitlistConfig
    >);

    render(<WaitlistLoginNotice />);

    const link = screen.getByRole('link', { name: 'Join the waitlist' });
    expect(link).toHaveAttribute('href', '/early-access');
    expect(link.closest('p')).toHaveTextContent(
      'Accounts are by invitation for now. Join the waitlist to hear when we open.'
    );
  });
});
