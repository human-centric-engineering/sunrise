import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VerifyEmailClientContent } from '@/app/(auth)/verify-email/verify-email-content';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.verifyEmail.meta');
  return {
    title: t('title'),
    description: t('description'),
  };
}

/**
 * Verify Email Page
 *
 * Shown after email/password signup when email verification is required.
 * Renders the client component that handles the verification pending state.
 */
export default function VerifyEmailPage() {
  return <VerifyEmailClientContent />;
}
