'use client';

/**
 * Password Change Form
 *
 * Form for changing user password.
 * Uses better-auth's changePassword API.
 *
 * Phase 3.2: User Management
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { authClient } from '@/lib/auth/client';
import { createChangePasswordSchema, type ChangePasswordInput } from '@/lib/validations/auth';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordStrength } from '@/components/forms/password-strength';
import { FormError, SaveError } from '@/components/forms/form-error';
import { NoScriptNotice } from '@/components/forms/no-script-notice';
import { useTimeout } from '@/lib/hooks/use-timeout';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { fieldCount } from '@/lib/errors/save-error';

export function PasswordForm() {
  const t = useTranslations('account.password');
  const tv = useTranslations('validation');
  const changePasswordSchema = useMemo(() => createChangePasswordSchema(tv), [tv]);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const schedule = useTimeout();
  const { track } = useAnalytics();

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setError,
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

  const save = useSaveFailure({
    fallback: t('saveFailed'),
    errors,
  });

  const newPassword = watch('newPassword');

  const onSubmit = async (data: ChangePasswordInput) => {
    try {
      setIsLoading(true);
      setSuccess(false);

      // better-auth answers a refusal rather than throwing it.
      const { error } = await authClient.changePassword({
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
        revokeOtherSessions: true,
      });
      if (error) {
        if (error.code === 'INVALID_PASSWORD') {
          // The one field it is about: its message goes under it, and it takes
          // focus. By Save, the summary every form shows for a named field.
          const wrongPassword = t('wrongPassword');
          setError('currentPassword', { type: 'server', message: wrongPassword });
          save.show(fieldCount(1), [{ field: 'currentPassword', message: wrongPassword }]);
        } else {
          save.show(error.message || t('saveFailed'));
        }
        return;
      }

      // Track password change
      void track(EVENTS.PASSWORD_CHANGED);

      setSuccess(true);
      reset(); // Clear form after success

      // Reset success message after 5 seconds
      schedule(() => setSuccess(false), 5000);
    } catch (err) {
      // A network failure: the browser's own text says nothing useful.
      save.report(err);
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-md bg-green-50 p-6 text-center text-green-900 dark:bg-green-950/50 dark:text-green-300">
        <CheckCircle2 className="h-8 w-8" />
        <div>
          <p className="font-medium">{t('success')}</p>
          <p className="mt-1 text-sm opacity-80">{t('successHint')}</p>
        </div>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={save.submit(handleSubmit(onSubmit, save.invalid))}
      className="space-y-6"
    >
      <NoScriptNotice />
      {/* Current Password */}
      <div className="space-y-2">
        <Label htmlFor="currentPassword">{t('current')}</Label>
        <PasswordInput
          id="currentPassword"
          placeholder={t('currentPlaceholder')}
          disabled={isLoading}
          {...register('currentPassword')}
        />
        <FormError message={errors.currentPassword?.message} />
      </div>

      {/* New Password */}
      <div className="space-y-2">
        <Label htmlFor="newPassword" className="flex items-center gap-1">
          {t('new')}
          <FieldHelp title={t('helpTitle')}>{t('help')}</FieldHelp>
        </Label>
        <PasswordInput
          id="newPassword"
          placeholder={t('newPlaceholder')}
          disabled={isLoading}
          {...register('newPassword')}
        />
        <FormError message={errors.newPassword?.message} />
        <PasswordStrength password={newPassword} />
      </div>

      {/* Confirm New Password */}
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">{t('confirm')}</Label>
        <PasswordInput
          id="confirmPassword"
          placeholder={t('confirmPlaceholder')}
          disabled={isLoading}
          {...register('confirmPassword')}
        />
        <FormError message={errors.confirmPassword?.message} />
      </div>

      <SaveError failure={save.failure} />

      {/* Submit button */}
      <Button type="submit" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('changing')}
          </>
        ) : (
          t('submit')
        )}
      </Button>
    </form>
  );
}
