// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import ChangeEmailApproval from '@/emails/change-email-approval';

describe('ChangeEmailApproval', () => {
  const defaultProps = {
    userName: 'John Doe',
    currentEmail: 'old@example.com',
    newEmail: 'new@example.com',
    approvalUrl: 'https://example.com/verify-email?token=abc123',
    expiresAt: new Date('2026-12-31T23:59:59Z'),
  };

  it('should render with all required props', async () => {
    const html = await render(<ChangeEmailApproval {...defaultProps} />);

    expect(html).toContain('Approve Your Email Change');
    expect(html).toContain('John Doe');
    expect(html).toContain('https://example.com/verify-email?token=abc123');
  });

  it('should name both the current and the new address', async () => {
    // The whole point of the email: the recipient must be able to tell what's
    // moving where. This is the control #489 depends on — mailing the wrong
    // address entirely is covered by lib/auth/config.test.ts, but the copy
    // itself must be unambiguous about which address is which.
    const html = await render(<ChangeEmailApproval {...defaultProps} />);

    expect(html).toContain('old@example.com');
    expect(html).toContain('new@example.com');
  });

  it('should include the "didn\'t request this" compromise warning', async () => {
    // For a recipient who did NOT initiate this, this section is the actual
    // signal that something is wrong — it must be present and must not be
    // buried below the fold or styled identically to routine copy.
    const html = await render(<ChangeEmailApproval {...defaultProps} />);

    expect(html).toContain('If you didn&#x27;t request this');
    expect(html).toContain('change your password now');
    expect(html).toContain('signs out every other device');
  });

  it('should include CTA button with the approval href', async () => {
    const html = await render(<ChangeEmailApproval {...defaultProps} />);

    expect(html).toContain('href=');
    expect(html).toContain('Approve Email Change');
    expect(html).toContain(defaultProps.approvalUrl);
  });

  it('should display the approval URL as a plain-text fallback link', async () => {
    const customUrl = 'https://myapp.com/verify-email?token=xyz789';
    const html = await render(<ChangeEmailApproval {...defaultProps} approvalUrl={customUrl} />);

    expect(html).toContain('copy and paste this link');
    expect(html).toContain(customUrl);
  });

  it('should display formatted expiration date', async () => {
    const expirationDate = new Date('2026-06-15T14:30:00Z');
    const html = await render(<ChangeEmailApproval {...defaultProps} expiresAt={expirationDate} />);

    expect(html).toContain('This approval link will expire on');
    expect(html).toMatch(/June|2026/);
  });

  it('should have proper HTML structure', async () => {
    const html = await render(<ChangeEmailApproval {...defaultProps} />);

    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('lang="en"');
  });

  it('should render without errors', () => {
    expect(() => render(<ChangeEmailApproval {...defaultProps} />)).not.toThrow();
  });

  it('should render with different user names', async () => {
    const html = await render(<ChangeEmailApproval {...defaultProps} userName="María García" />);

    expect(html).toContain('María García');
  });
});
