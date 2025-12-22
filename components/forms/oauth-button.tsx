'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logging';

interface OAuthButtonProps {
  provider: 'google'; // Can add more providers later: 'github' | 'facebook' etc.
  children: React.ReactNode;
  callbackUrl?: string;
}

/**
 * OAuth Button Component
 *
 * Handles OAuth authentication flow for social providers.
 * Uses better-auth client to initiate OAuth sign-in.
 *
 * Features:
 * - Loading states during OAuth redirect
 * - Callback URL preservation
 * - Error handling via URL params
 *
 * Usage:
 * ```tsx
 * <OAuthButton provider="google" callbackUrl="/dashboard">
 *   <GoogleIcon /> Continue with Google
 * </OAuthButton>
 * ```
 */
export function OAuthButton({ provider, children, callbackUrl }: OAuthButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const searchParams = useSearchParams();
  const redirect = callbackUrl || searchParams.get('callbackUrl') || '/dashboard';

  const handleOAuthSignIn = async () => {
    try {
      setIsLoading(true);

      // Initiate OAuth flow
      await authClient.signIn.social({
        provider,
        callbackURL: redirect,
      });

      // Note: better-auth will redirect to provider's OAuth page
      // User will be redirected back to /api/auth/callback/[provider]
      // Then redirected to callbackURL after successful authentication
    } catch (error) {
      // Reset loading state if redirect fails
      setIsLoading(false);
      logger.error('OAuth sign-in error', error, { provider });
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={isLoading}
      onClick={() => void handleOAuthSignIn()}
    >
      {isLoading ? 'Redirecting...' : children}
    </Button>
  );
}
