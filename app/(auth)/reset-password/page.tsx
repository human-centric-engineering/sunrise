import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ResetPasswordForm } from '@/components/forms/reset-password-form';
import { BRAND } from '@/lib/brand';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.resetPassword.meta');
  return {
    title: t('title'),
    description: t('description', { brand: BRAND.name }),
  };
}

/**
 * Password Reset Page
 *
 * Handles two flows based on URL query parameters:
 * 1. Request password reset (no token) - user enters email
 * 2. Complete password reset (token in URL) - user sets new password
 *
 * The form detects which state to show based on URL query parameters.
 *
 * Features:
 * - Email/password authentication recovery
 * - Token-based password reset
 * - OAuth-only user handling (backend check - no email sent if no password account)
 * - Password strength meter
 * - Show/hide password toggles
 * - Form validation with Zod schemas
 * - Loading states and error handling
 *
 * Security:
 * - Generic success messages (doesn't reveal if email exists)
 * - Token expiration (1 hour)
 * - Invalid token handling
 */
export default function ResetPasswordPage() {
  const t = useTranslations('auth');
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">{t('resetPassword.title')}</CardTitle>
        <CardDescription>{t('resetPassword.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<div>{t('shared.loading')}</div>}>
          <ResetPasswordForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
