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
  errorCallbackUrl?: string;
  invitationToken?: string;
  invitationEmail?: string;
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
 * - Invitation flow support (pass invitation token and email via OAuth state)
 *
 * Usage:
 * ```tsx
 * // Standard OAuth
 * <OAuthButton provider="google" callbackUrl="/dashboard">
 *   <GoogleIcon /> Continue with Google
 * </OAuthButton>
 *
 * // OAuth with invitation
 * <OAuthButton
 *   provider="google"
 *   callbackUrl="/dashboard"
 *   invitationToken="abc123..."
 *   invitationEmail="user@example.com"
 * >
 *   <GoogleIcon /> Accept with Google
 * </OAuthButton>
 * ```
 */
export function OAuthButton({
  provider,
  children,
  callbackUrl,
  errorCallbackUrl,
  invitationToken,
  invitationEmail,
}: OAuthButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const searchParams = useSearchParams();
  const redirect = callbackUrl || searchParams.get('callbackUrl') || '/dashboard';

  const handleOAuthSignIn = async () => {
    try {
      setIsLoading(true);

      // Build OAuth request with optional invitation data
      const oauthRequest: {
        provider: string;
        callbackURL: string;
        errorCallbackURL?: string;
        additionalData?: {
          invitationToken: string;
          invitationEmail: string;
        };
      } = {
        provider,
        callbackURL: redirect,
      };

      // Add error callback URL if provided (redirects errors back to our page)
      if (errorCallbackUrl) {
        oauthRequest.errorCallbackURL = errorCallbackUrl;
      }

      // Add invitation data to OAuth state if provided (via additionalData)
      // better-auth preserves additionalData through the OAuth flow
      if (invitationToken && invitationEmail) {
        oauthRequest.additionalData = {
          invitationToken,
          invitationEmail,
        };
      }

      // Initiate OAuth flow
      await authClient.signIn.social(oauthRequest);

      // Note: better-auth will redirect to provider's OAuth page
      // User will be redirected back to /api/auth/callback/[provider]
      // Then redirected to callbackURL after successful authentication
      // Custom OAuth state (invitationToken, invitationEmail) will be available in hooks
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
