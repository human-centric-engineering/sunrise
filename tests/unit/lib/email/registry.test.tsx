/**
 * Email template resolver (issue #347)
 *
 * `resolveEmailTemplate(kind, props)` renders the fork override registered in
 * `lib/app/emails.ts` if present, else the platform default from `emails/*`.
 * The overrides module is read at registry-load, so the override case stubs it
 * via `vi.doMock` and re-imports the registry fresh.
 *
 * Covers: default fallback returns the platform template's output; a registered
 * override is used for its kind while other kinds keep the default; the resolver
 * passes props straight through.
 *
 * @see lib/email/registry.ts · lib/app/emails.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';

const welcomeProps = {
  userName: 'Test User',
  userEmail: 'test@example.com',
  baseUrl: 'https://example.com',
};

const verifyProps = {
  userName: 'Test User',
  verificationUrl: 'https://example.com/verify',
  expiresAt: new Date('2026-01-01T00:00:00Z'),
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/app/emails');
});

describe('resolveEmailTemplate', () => {
  it('falls back to the platform default when no override is registered', async () => {
    vi.resetModules();
    const { resolveEmailTemplate } = await import('@/lib/email/registry');
    const { default: WelcomeEmail } = await import('@/emails/welcome');

    // The resolver invokes the template, so its output must equal calling the
    // platform default directly with the same props.
    expect(resolveEmailTemplate('welcome', welcomeProps)).toEqual(WelcomeEmail(welcomeProps));
  });

  it('uses a registered override for that kind and the default for the rest', async () => {
    vi.resetModules();
    // A recognizable stand-in component for the `welcome` kind only.
    const OverrideWelcome = (props: typeof welcomeProps): React.ReactElement =>
      React.createElement('div', { 'data-testid': 'override', id: props.userEmail });
    vi.doMock('@/lib/app/emails', () => ({ emailOverrides: { welcome: OverrideWelcome } }));

    const { resolveEmailTemplate } = await import('@/lib/email/registry');
    const { default: VerifyEmail } = await import('@/emails/verify-email');

    // welcome → the override is used (props passed through)
    const { container } = render(resolveEmailTemplate('welcome', welcomeProps));
    const overrideEl = container.querySelector('[data-testid="override"]');
    expect(overrideEl).not.toBeNull();
    expect(overrideEl?.id).toBe(welcomeProps.userEmail);

    // verifyEmail → still the platform default (override is per-kind)
    expect(resolveEmailTemplate('verifyEmail', verifyProps)).toEqual(VerifyEmail(verifyProps));
  });
});
