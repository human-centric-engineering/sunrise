import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { VerifyCallbackClientContent } from '@/app/(auth)/verify-email/callback/verify-callback-content';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.verifyEmail.callback.meta');
  return {
    title: t('title'),
    description: t('description'),
  };
}

/**
 * Verify Email Callback Page
 *
 * Handles the redirect from better-auth's email verification endpoint.
 * Renders the client component that processes verification results.
 */
export default function VerifyEmailCallbackPage() {
  return <VerifyCallbackClientContent />;
}
