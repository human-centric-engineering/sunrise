// @vitest-environment happy-dom

/**
 * The two waitlist emails (§125 t-977): what each must carry, and what the
 * note must not.
 *
 * @see emails/waitlist-confirm.tsx · emails/waitlist-already-on-list.tsx
 */

import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import WaitlistConfirmEmail from '@/emails/waitlist-confirm';
import WaitlistAlreadyOnListEmail from '@/emails/waitlist-already-on-list';

const CONFIRM = 'https://app.example.com/waitlist/confirm?entry=e1&amp;token=abc';
const LEAVE = 'https://app.example.com/waitlist/leave?token=signed';

describe('WaitlistConfirmEmail', () => {
  const props = {
    firstName: 'Ada',
    confirmUrl: 'https://app.example.com/waitlist/confirm?entry=e1&token=abc',
    leaveUrl: LEAVE,
    expiresAt: new Date('2026-11-11T12:00:00Z'),
  };

  it('carries the confirm link, the leave link and the expiry date', async () => {
    const html = await render(<WaitlistConfirmEmail {...props} />);

    expect(html).toContain(`href="${CONFIRM}"`);
    expect(html).toContain(`href="${LEAVE}"`);
    expect(html).toContain('11 November 2026');
    expect(html).toContain('Hi Ada,');
  });

  it('greets nobody by name when there is no first name', async () => {
    const html = await render(<WaitlistConfirmEmail {...props} firstName={null} />);

    expect(html).toContain('Hello,');
    expect(html).not.toContain('Hi ');
  });
});

describe('WaitlistAlreadyOnListEmail', () => {
  it('carries the leave link and no confirm link', async () => {
    const html = await render(<WaitlistAlreadyOnListEmail firstName="Ada" leaveUrl={LEAVE} />);

    expect(html).toContain(`href="${LEAVE}"`);
    expect(html).not.toContain('/waitlist/confirm');
    expect(html).toContain('already on the list');
  });
});
