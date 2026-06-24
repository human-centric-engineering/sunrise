/**
 * Brand seam (issue #305)
 *
 * `BRAND.name` is read from `NEXT_PUBLIC_APP_NAME` at module load, so each case
 * stubs the env and re-imports the module (and any consumer) fresh. Covers the
 * default/fallback, a custom value, trimming, and — to prove the wiring is real,
 * not just the constant — that an actual email template renders the custom name.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

async function loadBrandName(value: string): Promise<string> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_APP_NAME', value);
  const { BRAND } = await import('@/lib/brand');
  return BRAND.name;
}

async function renderWelcomeWith(value: string): Promise<string> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_APP_NAME', value);
  const React = await import('react');
  const { render } = await import('@react-email/render');
  const { default: WelcomeEmail } = await import('@/emails/welcome');
  return render(
    React.createElement(WelcomeEmail, {
      userName: 'Test User',
      userEmail: 'test@example.com',
      baseUrl: 'https://example.com',
    })
  );
}

describe('BRAND.name', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('falls back to "Sunrise" when the env var is empty (unset-equivalent)', async () => {
    expect(await loadBrandName('')).toBe('Sunrise');
  });

  it('falls back to "Sunrise" when the env var is only whitespace', async () => {
    expect(await loadBrandName('   ')).toBe('Sunrise');
  });

  it('uses a custom NEXT_PUBLIC_APP_NAME verbatim', async () => {
    expect(await loadBrandName('Acme')).toBe('Acme');
  });

  it('trims surrounding whitespace from a custom value', async () => {
    expect(await loadBrandName('  Acme Corp  ')).toBe('Acme Corp');
  });
});

describe('brand seam is wired into templates', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('renders the default brand in the welcome email when unset', async () => {
    const html = await renderWelcomeWith('');
    expect(html).toContain('Welcome to Sunrise!');
    expect(html).not.toContain('Welcome to Acme!');
  });

  it('renders the custom brand in the welcome email when set', async () => {
    const html = await renderWelcomeWith('Acme');
    expect(html).toContain('Welcome to Acme!');
    expect(html).not.toContain('Welcome to Sunrise!');
  });
});
