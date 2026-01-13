import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ResetPasswordForm } from '@/components/forms/reset-password-form';

export const metadata: Metadata = {
  title: 'Reset Password',
  description: 'Reset your Sunrise account password',
};

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
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Reset your password</CardTitle>
        <CardDescription>
          Enter your email address and we&apos;ll send you a password reset link
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<div>Loading...</div>}>
          <ResetPasswordForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
