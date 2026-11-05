import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from '@/components/forms/login-form';
import { WaitlistLoginNotice } from '@/components/waitlist/waitlist-login-notice';
import { BRAND } from '@/lib/brand';
import { isInviteOnly } from '@/lib/auth/signup-mode';

export const metadata: Metadata = {
  title: 'Sign In',
  description: `Sign in to your ${BRAND.name} account`,
};

/**
 * Login Page
 *
 * Allows users to sign in with email and password.
 * Protected by proxy - authenticated users are redirected to /dashboard
 */
export default function LoginPage() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Welcome back</CardTitle>
        <CardDescription>Enter your email and password to sign in to your account</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Suspense fallback={<div>Loading...</div>}>
          <LoginForm />
        </Suspense>

        {/* Sign Up Link — omitted under SIGNUP_MODE=invite_only, where /signup
            redirects straight back here and self-signup cannot succeed. */}
        {!isInviteOnly() && (
          <div className="text-center text-sm">
            <span className="text-muted-foreground">Don&apos;t have an account? </span>
            <Link href="/signup" className="text-primary font-medium hover:underline">
              Sign up
            </Link>
          </div>
        )}
        {/* Under invite_only, the way in is the waitlist, when the app has one. */}
        {isInviteOnly() && <WaitlistLoginNotice />}

        {/* Password Reset Link */}
        <div className="text-center text-sm">
          <Link
            href="/reset-password"
            className="text-muted-foreground hover:text-primary hover:underline"
          >
            Forgot your password?
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
