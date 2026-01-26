'use client';

/**
 * Password Change Form
 *
 * Form for changing user password.
 * Uses better-auth's changePassword API.
 *
 * Phase 3.2: User Management
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { authClient } from '@/lib/auth/client';
import { passwordSchema } from '@/lib/validations/auth';
import { useSettingsAnalytics } from '@/lib/analytics/events';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordStrength } from './password-strength';
import { FormError } from './form-error';

// Password change schema with confirmation
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export function PasswordForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const { trackPasswordChanged } = useSettingsAnalytics();

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    mode: 'onTouched',
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const newPassword = watch('newPassword');

  const onSubmit = async (data: ChangePasswordInput) => {
    try {
      setIsLoading(true);
      setError(null);
      setSuccess(false);

      await authClient.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        revokeOtherSessions: true,
      });

      // Track password change
      void trackPasswordChanged();

      setSuccess(true);
      reset(); // Clear form after success

      // Reset success message after 5 seconds
      setTimeout(() => setSuccess(false), 5000);
    } catch (err) {
      if (err instanceof Error) {
        // Handle common better-auth error messages
        if (err.message.includes('incorrect') || err.message.includes('wrong')) {
          setError('Current password is incorrect');
        } else {
          setError(err.message || 'Failed to change password');
        }
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-md bg-green-50 p-6 text-center text-green-900 dark:bg-green-950/50 dark:text-green-300">
        <CheckCircle2 className="h-8 w-8" />
        <div>
          <p className="font-medium">Password changed successfully</p>
          <p className="mt-1 text-sm opacity-80">
            Other sessions have been logged out for security.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-6">
      {/* Current Password */}
      <div className="space-y-2">
        <Label htmlFor="currentPassword">Current Password</Label>
        <PasswordInput
          id="currentPassword"
          placeholder="Enter your current password"
          disabled={isLoading}
          {...register('currentPassword')}
        />
        <FormError message={errors.currentPassword?.message} />
      </div>

      {/* New Password */}
      <div className="space-y-2">
        <Label htmlFor="newPassword">New Password</Label>
        <PasswordInput
          id="newPassword"
          placeholder="Enter a new password"
          disabled={isLoading}
          {...register('newPassword')}
        />
        <FormError message={errors.newPassword?.message} />
        <PasswordStrength password={newPassword} />
      </div>

      {/* Confirm New Password */}
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm New Password</Label>
        <PasswordInput
          id="confirmPassword"
          placeholder="Confirm your new password"
          disabled={isLoading}
          {...register('confirmPassword')}
        />
        <FormError message={errors.confirmPassword?.message} />
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      {/* Submit button */}
      <Button type="submit" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Changing Password...
          </>
        ) : (
          'Change Password'
        )}
      </Button>
    </form>
  );
}
