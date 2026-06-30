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

// legalName derives from NEXT_PUBLIC_LEGAL_NAME, then NEXT_PUBLIC_APP_NAME, then
// "Sunrise" — so both vars matter. Empty string == unset-equivalent (the seam
// uses `?.trim() ||`).
async function loadLegalName(legal: string, appName: string): Promise<string> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_APP_NAME', appName);
  vi.stubEnv('NEXT_PUBLIC_LEGAL_NAME', legal);
  const { BRAND } = await import('@/lib/brand');
  return BRAND.legalName;
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

describe('BRAND.legalName', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses NEXT_PUBLIC_LEGAL_NAME verbatim when set (distinct from the product name)', async () => {
    expect(await loadLegalName('All Too Human Ltd', 'ConQuest')).toBe('All Too Human Ltd');
  });

  it('trims surrounding whitespace from the legal name', async () => {
    expect(await loadLegalName('  All Too Human Ltd  ', 'ConQuest')).toBe('All Too Human Ltd');
  });

  it('falls back to the product name when the legal name is unset', async () => {
    expect(await loadLegalName('', 'ConQuest')).toBe('ConQuest');
  });

  it('falls back to the product name when the legal name is only whitespace', async () => {
    expect(await loadLegalName('   ', 'ConQuest')).toBe('ConQuest');
  });

  it('falls back to "Sunrise" when both legal name and product name are unset', async () => {
    expect(await loadLegalName('', '')).toBe('Sunrise');
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
