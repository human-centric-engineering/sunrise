'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, useEffect } from 'react'
import { authClient } from '@/lib/auth/client'
import { signUpSchema, type SignUpInput } from '@/lib/validations/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FormError } from './form-error'
import { PasswordStrength } from './password-strength'
import { OAuthButtons } from './oauth-buttons'

/**
 * Signup Form Component
 *
 * Handles user registration with OAuth providers or email/password.
 * Uses react-hook-form with Zod validation and better-auth for user creation.
 *
 * Features:
 * - OAuth authentication (Google)
 * - Email/password registration
 * - Form validation with Zod schema (password strength, email format, etc.)
 * - Real-time password strength meter with visual feedback
 * - Password confirmation matching
 * - Loading states during submission
 * - Error handling and display (including OAuth errors from URL)
 * - Auto-login after successful registration
 */
export function SignupForm() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Check for OAuth errors in URL params
  useEffect(() => {
    const oauthError = searchParams.get('error')
    const oauthErrorDescription = searchParams.get('error_description')

    if (oauthError) {
      setError(oauthErrorDescription || 'OAuth authentication failed. Please try again.')
    }
  }, [searchParams])

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      password: '',
      confirmPassword: '',
    },
  })

  // Watch password field for strength meter
  const password = watch('password')

  const onSubmit = async (data: SignUpInput) => {
    try {
      setIsLoading(true)
      setError(null)

      await authClient.signUp.email(
        {
          email: data.email,
          password: data.password,
          name: data.name,
        },
        {
          onRequest: () => {
            // Request started
          },
          onSuccess: () => {
            // Redirect to dashboard after successful signup
            // better-auth automatically logs in the user after registration
            router.push('/dashboard')
            router.refresh()
          },
          onError: (ctx) => {
            setError(
              ctx.error.message ||
                'Failed to create account. Please try again.'
            )
            setIsLoading(false)
          },
        }
      )
    } catch {
      setError('An unexpected error occurred. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* OAuth Buttons */}
      <OAuthButtons callbackUrl="/dashboard" />

      {/* Email/Password Form */}
      <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
        {/* Name Field */}
      <div className="space-y-2">
        <Label htmlFor="name">Full Name</Label>
        <Input
          id="name"
          type="text"
          placeholder="John Doe"
          autoComplete="name"
          disabled={isLoading}
          {...register('name')}
        />
        <FormError message={errors.name?.message} />
      </div>

      {/* Email Field */}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          disabled={isLoading}
          {...register('email')}
        />
        <FormError message={errors.email?.message} />
      </div>

      {/* Password Field */}
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          placeholder="••••••••"
          autoComplete="new-password"
          disabled={isLoading}
          {...register('password')}
        />
        <FormError message={errors.password?.message} />
        <PasswordStrength password={password} />
        <p className="text-xs text-muted-foreground">
          Must be at least 8 characters with uppercase, lowercase, number, and
          special character
        </p>
      </div>

      {/* Confirm Password Field */}
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <Input
          id="confirmPassword"
          type="password"
          placeholder="••••••••"
          autoComplete="new-password"
          disabled={isLoading}
          {...register('confirmPassword')}
        />
        <FormError message={errors.confirmPassword?.message} />
      </div>

      {/* Error Message */}
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

        {/* Submit Button */}
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? 'Creating account...' : 'Create Account'}
        </Button>
      </form>
    </div>
  )
}
