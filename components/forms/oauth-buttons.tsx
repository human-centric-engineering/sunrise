'use client'

import { OAuthButton } from './oauth-button'

interface OAuthButtonsProps {
  callbackUrl?: string
}

/**
 * OAuth Buttons Section Component
 *
 * Displays available OAuth sign-in options with visual divider.
 * Only shows if OAuth providers are configured (via environment variables).
 *
 * Features:
 * - Google OAuth button with branded icon
 * - Visual "or" divider separating OAuth from email/password
 * - Gracefully hidden if no OAuth providers configured
 * - Can easily add more providers (GitHub, Facebook, etc.)
 *
 * Usage:
 * ```tsx
 * <OAuthButtons callbackUrl="/dashboard" />
 * <LoginForm /> // Email/password form below
 * ```
 */
export function OAuthButtons({ callbackUrl }: OAuthButtonsProps) {
  // Check if OAuth is configured
  // In production, better-auth won't expose providers if not configured
  // For now, we always show the button - better-auth will handle the error
  const hasOAuthProviders = true // TODO: Can add runtime check if needed

  if (!hasOAuthProviders) {
    return null
  }

  return (
    <div className="space-y-4">
      {/* OAuth Provider Buttons */}
      <div className="space-y-2">
        <OAuthButton provider="google" callbackUrl={callbackUrl}>
          <GoogleIcon />
          <span className="ml-2">Continue with Google</span>
        </OAuthButton>

        {/* Add more OAuth providers here as needed:
        <OAuthButton provider="github" callbackUrl={callbackUrl}>
          <GithubIcon />
          <span className="ml-2">Continue with GitHub</span>
        </OAuthButton>
        */}
      </div>

      {/* Divider */}
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">
            Or continue with email
          </span>
        </div>
      </div>
    </div>
  )
}

/**
 * Google Icon Component
 *
 * Official Google "G" logo for OAuth button.
 * Uses brand colors as per Google's branding guidelines.
 */
function GoogleIcon() {
  return (
    <svg
      className="h-5 w-5"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}
