import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import ResetPasswordEmail from '@/emails/reset-password';

describe('ResetPasswordEmail', () => {
  const defaultProps = {
    userName: 'John Doe',
    resetUrl: 'https://example.com/reset?token=abc123',
    expiresAt: new Date('2026-12-31T23:59:59Z'),
  };

  it('should render with all required props', async () => {
    const html = await render(<ResetPasswordEmail {...defaultProps} />);

    expect(html).toContain('Reset Your Password');
    expect(html).toContain('John Doe');
    expect(html).toContain('https://example.com/reset?token=abc123');
  });

  it('should include preview text', async () => {
    const html = await render(<ResetPasswordEmail {...defaultProps} />);

    expect(html).toContain('Reset your password');
  });

  it('should have proper HTML structure', async () => {
    const html = await render(<ResetPasswordEmail {...defaultProps} />);

    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('lang="en"');
  });

  it('should include CTA button with reset href', async () => {
    const html = await render(<ResetPasswordEmail {...defaultProps} />);

    expect(html).toContain('href=');
    expect(html).toContain('Reset Password');
    expect(html).toContain('https://example.com/reset?token=abc123');
  });

  it('should render without errors', () => {
    expect(() => render(<ResetPasswordEmail {...defaultProps} />)).not.toThrow();
  });

  it('should display formatted expiration date', async () => {
    const expirationDate = new Date('2026-07-20T10:15:00Z');
    const html = await render(
      <ResetPasswordEmail
        userName="Jane"
        resetUrl="https://example.com/reset"
        expiresAt={expirationDate}
      />
    );

    expect(html).toContain('This link will expire on');
    // Check that some date formatting occurred
    expect(html).toMatch(/July|2026/);
  });

  it('should include security warning', async () => {
    const html = await render(<ResetPasswordEmail {...defaultProps} />);

    expect(html).toContain('Security Notice');
    expect(html).toContain('Never share this link');
  });

  it('should include instructions for unwanted reset', async () => {
    const html = await render(<ResetPasswordEmail {...defaultProps} />);

    expect(html).toContain('If you didn&#x27;t request a password reset');
    expect(html).toContain('safely ignore this email');
  });

  it('should display reset URL as text link', async () => {
    const customUrl = 'https://myapp.com/reset-password?token=xyz789';
    const html = await render(
      <ResetPasswordEmail userName="Alice" resetUrl={customUrl} expiresAt={new Date()} />
    );

    expect(html).toContain('copy and paste this link');
    expect(html).toContain(customUrl);
  });

  it('should warn about account security', async () => {
    const html = await render(<ResetPasswordEmail {...defaultProps} />);

    expect(html).toContain('your account may be at risk');
    expect(html).toContain('contact support immediately');
  });

  it('should render with different user names', async () => {
    const html = await render(
      <ResetPasswordEmail
        userName="李明"
        resetUrl="https://example.com/reset"
        expiresAt={new Date()}
      />
    );

    expect(html).toContain('李明');
  });

  it('should include password reset instructions', async () => {
    const html = await render(<ResetPasswordEmail {...defaultProps} />);

    expect(html).toContain('We received a request to reset the password');
    expect(html).toContain('create a new password');
  });
});
