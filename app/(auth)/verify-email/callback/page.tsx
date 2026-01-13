import type { Metadata } from 'next';
import { VerifyCallbackClientContent } from './verify-callback-content';

export const metadata: Metadata = {
  title: 'Email Verification',
  description: 'Complete your email verification',
};

/**
 * Verify Email Callback Page
 *
 * Handles the redirect from better-auth's email verification endpoint.
 * Renders the client component that processes verification results.
 */
export default function VerifyEmailCallbackPage() {
  return <VerifyCallbackClientContent />;
}
