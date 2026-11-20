/**
 * Auth route metadata (§138 t-1073)
 *
 * The auth layout and the verify-email pages build their titles from the
 * catalogue, so a viewer's language reaches the browser tab too. The global
 * next-intl mock serves the real English catalogue.
 *
 * @see app/(auth)/layout.tsx
 * @see app/(auth)/verify-email/page.tsx
 * @see app/(auth)/verify-email/callback/page.tsx
 */

import { describe, it, expect } from 'vitest';
import { generateMetadata as layoutMetadata } from '@/app/(auth)/layout';
import { generateMetadata as verifyEmailMetadata } from '@/app/(auth)/verify-email/page';
import { generateMetadata as verifyCallbackMetadata } from '@/app/(auth)/verify-email/callback/page';
import { BRAND } from '@/lib/brand';

describe('auth metadata', () => {
  it('layout titles every auth page with the brand, keeping the %s slot for the page title', async () => {
    const metadata = await layoutMetadata();

    expect(metadata.title).toEqual({
      template: `%s - ${BRAND.name}`,
      default: `Authentication - ${BRAND.name}`,
    });
    expect(metadata.description).toBe('Sign in or create an account');
  });

  it('verify-email page', async () => {
    const metadata = await verifyEmailMetadata();

    expect(metadata.title).toBe('Verify Email');
    expect(metadata.description).toBe('Verify your email address to complete registration');
  });

  it('verify-email callback page', async () => {
    const metadata = await verifyCallbackMetadata();

    expect(metadata.title).toBe('Email Verification');
    expect(metadata.description).toBe('Complete your email verification');
  });
});
