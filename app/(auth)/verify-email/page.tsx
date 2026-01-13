import type { Metadata } from 'next';
import { VerifyEmailClientContent } from './verify-email-content';

export const metadata: Metadata = {
  title: 'Verify Email',
  description: 'Verify your email address to complete registration',
};

/**
 * Verify Email Page
 *
 * Shown after email/password signup when email verification is required.
 * Renders the client component that handles the verification pending state.
 */
export default function VerifyEmailPage() {
  return <VerifyEmailClientContent />;
}
