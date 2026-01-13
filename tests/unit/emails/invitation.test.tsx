import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import InvitationEmail from '@/emails/invitation';

describe('InvitationEmail', () => {
  const defaultProps = {
    inviterName: 'Alice Smith',
    inviteeName: 'Bob Jones',
    inviteeEmail: 'bob@example.com',
    invitationUrl: 'https://example.com/accept?token=abc123',
    expiresAt: new Date('2026-12-31T23:59:59Z'),
  };

  it('should render with all required props', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('You&#x27;ve Been Invited!');
    expect(html).toContain('Bob Jones');
    expect(html).toContain('Alice Smith');
    expect(html).toContain('bob@example.com');
    expect(html).toContain('https://example.com/accept?token=abc123');
  });

  it('should include preview text', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('You&#x27;ve been invited to join Sunrise');
  });

  it('should have proper HTML structure', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('lang="en"');
  });

  it('should include CTA button with invitation href', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('href=');
    expect(html).toContain('Accept Invitation');
    expect(html).toContain('https://example.com/accept?token=abc123');
  });

  it('should render without errors', () => {
    expect(() => render(<InvitationEmail {...defaultProps} />)).not.toThrow();
  });

  it('should display inviter and invitee names', async () => {
    const html = await render(
      <InvitationEmail
        inviterName="Sarah Wilson"
        inviteeName="Mike Chen"
        inviteeEmail="mike@example.com"
        invitationUrl="https://example.com/invite"
        expiresAt={new Date()}
      />
    );

    expect(html).toContain('Sarah Wilson');
    expect(html).toContain('Mike Chen');
  });

  it('should display invitee email in info box', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('Your Account:');
    expect(html).toContain('bob@example.com');
  });

  it('should include formatted expiration date', async () => {
    const expirationDate = new Date('2026-08-10T16:45:00Z');
    const html = await render(
      <InvitationEmail
        inviterName="John"
        inviteeName="Jane"
        inviteeEmail="jane@example.com"
        invitationUrl="https://example.com/invite"
        expiresAt={expirationDate}
      />
    );

    expect(html).toContain('This invitation will expire on');
    // Check that some date formatting occurred
    expect(html).toMatch(/August|2026/);
  });

  it('should list benefits after accepting', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('Set your own secure password');
    expect(html).toContain('Access your personalized dashboard');
    expect(html).toContain('Start collaborating with your team');
  });

  it('should include warning for unwanted invitation', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('If you weren&#x27;t expecting this invitation');
    expect(html).toContain('safely ignore this email');
  });

  it('should display invitation URL as text link', async () => {
    const customUrl = 'https://myapp.com/join?code=xyz789';
    const html = await render(
      <InvitationEmail
        inviterName="Admin"
        inviteeName="User"
        inviteeEmail="user@example.com"
        invitationUrl={customUrl}
        expiresAt={new Date()}
      />
    );

    expect(html).toContain('copy and paste this link');
    expect(html).toContain(customUrl);
  });

  it('should mention app name', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('Sunrise');
  });

  it('should include contact information in footer', async () => {
    const html = await render(<InvitationEmail {...defaultProps} />);

    expect(html).toContain('Questions?');
    expect(html).toContain('Alice Smith');
    expect(html).toContain('support team');
  });

  it('should render with unicode characters in names', async () => {
    const html = await render(
      <InvitationEmail
        inviterName="François Dubois"
        inviteeName="José García"
        inviteeEmail="jose@example.com"
        invitationUrl="https://example.com/invite"
        expiresAt={new Date()}
      />
    );

    expect(html).toContain('François Dubois');
    expect(html).toContain('José García');
  });
});
