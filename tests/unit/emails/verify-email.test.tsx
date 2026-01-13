import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import VerifyEmail from '@/emails/verify-email';

describe('VerifyEmail', () => {
  const defaultProps = {
    userName: 'John Doe',
    verificationUrl: 'https://example.com/verify?token=abc123',
    expiresAt: new Date('2026-12-31T23:59:59Z'),
  };

  it('should render with all required props', async () => {
    const html = await render(<VerifyEmail {...defaultProps} />);

    expect(html).toContain('Verify Your Email Address');
    expect(html).toContain('John Doe');
    expect(html).toContain('https://example.com/verify?token=abc123');
  });

  it('should include preview text', async () => {
    const html = await render(<VerifyEmail {...defaultProps} />);

    expect(html).toContain('Verify your email address');
  });

  it('should have proper HTML structure', async () => {
    const html = await render(<VerifyEmail {...defaultProps} />);

    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('lang="en"');
  });

  it('should include CTA button with verification href', async () => {
    const html = await render(<VerifyEmail {...defaultProps} />);

    expect(html).toContain('href=');
    expect(html).toContain('Verify Email');
    expect(html).toContain('https://example.com/verify?token=abc123');
  });

  it('should render without errors', () => {
    expect(() => render(<VerifyEmail {...defaultProps} />)).not.toThrow();
  });

  it('should display formatted expiration date', async () => {
    const expirationDate = new Date('2026-06-15T14:30:00Z');
    const html = await render(
      <VerifyEmail
        userName="Jane"
        verificationUrl="https://example.com/verify"
        expiresAt={expirationDate}
      />
    );

    expect(html).toContain('This verification link will expire on');
    // Check that some date formatting occurred (month, day, year pattern)
    expect(html).toMatch(/June|2026/);
  });

  it('should include security notice', async () => {
    const html = await render(<VerifyEmail {...defaultProps} />);

    expect(html).toContain('Security Note');
    expect(html).toContain('For your security');
    expect(html).toContain('can only be used once');
  });

  it('should include warning for unwanted verification', async () => {
    const html = await render(<VerifyEmail {...defaultProps} />);

    expect(html).toContain('If you didn&#x27;t request this verification');
    expect(html).toContain('safely ignore it');
  });

  it('should display verification URL as text link', async () => {
    const customUrl = 'https://myapp.com/verify?token=xyz789';
    const html = await render(
      <VerifyEmail userName="Alice" verificationUrl={customUrl} expiresAt={new Date()} />
    );

    expect(html).toContain('copy and paste this link');
    expect(html).toContain(customUrl);
  });

  it('should render with different user names', async () => {
    const html = await render(
      <VerifyEmail
        userName="María García"
        verificationUrl="https://example.com/verify"
        expiresAt={new Date()}
      />
    );

    expect(html).toContain('María García');
  });
});
