import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SignupForm } from '@/components/forms/signup-form';

export const metadata: Metadata = {
  title: 'Create Account',
  description: 'Create a new Sunrise account',
};

/**
 * Signup Page
 *
 * Allows new users to create an account with email and password.
 * Protected by proxy - authenticated users are redirected to /dashboard
 *
 * Note: SignupForm uses useSearchParams() which requires Suspense boundary
 */
export default function SignupPage() {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold">Create an account</CardTitle>
        <CardDescription>Enter your information to create your account</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Suspense fallback={<div>Loading...</div>}>
          <SignupForm />
        </Suspense>

        {/* Login Link */}
        <div className="text-center text-sm">
          <span className="text-muted-foreground">Already have an account? </span>
          <Link href="/login" className="text-primary font-medium hover:underline">
            Sign in
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
