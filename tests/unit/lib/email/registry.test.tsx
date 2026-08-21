// @vitest-environment happy-dom

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

  it('lets a fork override changeEmailApproval (#489)', async () => {
    // Named out separately from the generic "welcome" case above because this
    // kind is the actual takeover control (#489) — a fork overriding it must
    // still receive the address it should mail the approval to.
    vi.resetModules();
    const changeEmailProps = {
      userName: 'Test User',
      currentEmail: 'old@example.com',
      newEmail: 'new@example.com',
      approvalUrl: 'https://example.com/approve',
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    };
    const OverrideChangeEmail = (props: typeof changeEmailProps): React.ReactElement =>
      React.createElement('div', { 'data-testid': 'override', id: props.currentEmail });
    vi.doMock('@/lib/app/emails', () => ({
      emailOverrides: { changeEmailApproval: OverrideChangeEmail },
    }));

    const { resolveEmailTemplate } = await import('@/lib/email/registry');

    const { container } = render(resolveEmailTemplate('changeEmailApproval', changeEmailProps));
    const overrideEl = container.querySelector('[data-testid="override"]');
    expect(overrideEl).not.toBeNull();
    expect(overrideEl?.id).toBe(changeEmailProps.currentEmail);
  });
});

// ---------------------------------------------------------------------------
// Fork-added kinds (#468)
// ---------------------------------------------------------------------------

describe('resolveEmailTemplate — fork-added kinds', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@/lib/app/emails');
  });

  it('resolves a kind that exists ONLY as a fork override', async () => {
    // The point of #468: EmailPropsMap is an interface, so a fork adds a kind by
    // declaration merging and supplies the template in emailOverrides. There is
    // no platform default for such a kind — which is why defaultTemplates had to
    // become Partial.
    vi.resetModules();
    const ForkTemplate = (props: { note: string }): React.ReactElement =>
      React.createElement('div', { 'data-testid': 'fork', id: props.note });
    vi.doMock('@/lib/app/emails', () => ({
      emailOverrides: { 'app.invoiceReceipt': ForkTemplate },
    }));

    const { resolveEmailTemplate } = await import('@/lib/email/registry');

    // Cast at the boundary: the real fork declares this kind via `declare module`,
    // which a test in this repo cannot do without polluting the global type.
    const resolve = resolveEmailTemplate as unknown as (
      kind: string,
      props: { note: string }
    ) => React.ReactElement;
    const { container } = render(resolve('app.invoiceReceipt', { note: 'INV-1' }));

    const el = container.querySelector('[data-testid="fork"]');
    expect(el).not.toBeNull();
    expect(el?.id).toBe('INV-1');
  });

  it('throws naming the kind when there is neither an override nor a default', async () => {
    // Reachable only for a fork-declared kind with no override registered. The
    // type system cannot catch it, because declaration merging widens EmailKind
    // without requiring an entry anywhere. Must throw rather than render
    // undefined — a blank email is much harder to diagnose than a failed send.
    vi.resetModules();
    vi.doMock('@/lib/app/emails', () => ({ emailOverrides: {} }));

    const { resolveEmailTemplate } = await import('@/lib/email/registry');
    const resolve = resolveEmailTemplate as unknown as (kind: string, props: unknown) => unknown;

    expect(() => resolve('app.neverRegistered', {})).toThrow(/app\.neverRegistered/);
  });

  it('still returns the platform default for every core kind', async () => {
    // Guards the Partial change: making defaultTemplates optional must not have
    // dropped a platform template.
    vi.resetModules();
    vi.doMock('@/lib/app/emails', () => ({ emailOverrides: {} }));

    const { resolveEmailTemplate } = await import('@/lib/email/registry');

    expect(() => resolveEmailTemplate('welcome', welcomeProps)).not.toThrow();
    expect(() => resolveEmailTemplate('verifyEmail', verifyProps)).not.toThrow();
    expect(() =>
      resolveEmailTemplate('resetPassword', {
        userName: 'A',
        resetUrl: 'https://example.com/r',
        expiresAt: new Date(),
      })
    ).not.toThrow();
    expect(() =>
      resolveEmailTemplate('invitation', {
        inviterName: 'A',
        inviteeName: 'B',
        inviteeEmail: 'b@example.com',
        invitationUrl: 'https://example.com/i',
        expiresAt: new Date(),
      })
    ).not.toThrow();
    expect(() =>
      resolveEmailTemplate('changeEmailApproval', {
        userName: 'A',
        currentEmail: 'old@example.com',
        newEmail: 'new@example.com',
        approvalUrl: 'https://example.com/approve',
        expiresAt: new Date(),
      })
    ).not.toThrow();
  });
});
