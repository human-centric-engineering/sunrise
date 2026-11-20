'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createContactClientSchema, type ContactClientInput } from '@/lib/validations/contact';
import { useFormAnalytics } from '@/lib/analytics/events';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormError, SaveError } from '@/components/forms/form-error';
import { NoScriptNotice } from '@/components/forms/no-script-notice';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';

/** Server path → the field that shows it: every field here renders its message. */
const SERVER_FIELDS: Partial<Record<string, keyof ContactClientInput>> = {
  name: 'name',
  email: 'email',
  subject: 'subject',
  message: 'message',
};

interface ContactFormResponse {
  message: string;
}

/**
 * Contact Form Component
 *
 * Public contact form for website visitors.
 * Submits to /api/v1/contact endpoint.
 *
 * Features:
 * - Form validation with Zod schema
 * - Honeypot field for spam prevention
 * - Loading and success states
 * - Error handling and display
 *
 * Phase 3.5: Landing Page & Marketing
 */
export function ContactForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const { trackFormSubmitted } = useFormAnalytics();
  const t = useTranslations('marketing.contact.form');
  const tv = useTranslations('validation');
  const schema = useMemo(() => createContactClientSchema(tv), [tv]);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<ContactClientInput>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      subject: '',
      message: '',
      website: '',
    },
  });

  const save = useSaveFailure({
    fallback: t('saveFailed'),
    fields: SERVER_FIELDS,
    setError,
    errors,
  });

  const onSubmit = async (data: ContactClientInput) => {
    try {
      setIsLoading(true);

      // Send form data including honeypot field
      await apiClient.post<ContactFormResponse>(API.PUBLIC.CONTACT, {
        body: data,
      });

      // Track contact form submission
      void trackFormSubmitted('contact');

      setIsSuccess(true);
      reset();
    } catch (err) {
      save.report(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Success state
  if (isSuccess) {
    return (
      <div className="space-y-4 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20">
          <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
        </div>
        <div>
          <h3 className="text-lg font-semibold">{t('successTitle')}</h3>
          <p className="text-muted-foreground mt-1">{t('successBody')}</p>
        </div>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={save.submit(handleSubmit(onSubmit, save.invalid))}
      className="space-y-4"
    >
      <NoScriptNotice />
      {/* Hidden honeypot field - invisible to real users, attracts bots */}
      <div className="absolute -left-[9999px] opacity-0" aria-hidden="true">
        <label htmlFor="website">{t('honeypotLabel')}</label>
        <input type="text" id="website" tabIndex={-1} autoComplete="off" {...register('website')} />
      </div>

      {/* Name Field */}
      <div className="space-y-2">
        <Label htmlFor="name">{t('name')}</Label>
        <Input
          id="name"
          type="text"
          placeholder={t('namePlaceholder')}
          autoComplete="name"
          disabled={isLoading}
          {...register('name')}
        />
        <FormError message={errors.name?.message} />
      </div>

      {/* Email Field */}
      <div className="space-y-2">
        <Label htmlFor="email">{t('email')}</Label>
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

      {/* Subject Field */}
      <div className="space-y-2">
        <Label htmlFor="subject">{t('subject')}</Label>
        <Input
          id="subject"
          type="text"
          placeholder={t('subjectPlaceholder')}
          disabled={isLoading}
          {...register('subject')}
        />
        <FormError message={errors.subject?.message} />
      </div>

      {/* Message Field */}
      <div className="space-y-2">
        <Label htmlFor="message">{t('message')}</Label>
        <Textarea
          id="message"
          placeholder={t('messagePlaceholder')}
          className="min-h-[120px] resize-y"
          disabled={isLoading}
          {...register('message')}
        />
        <FormError message={errors.message?.message} />
      </div>

      <SaveError failure={save.failure} />

      {/* Submit Button */}
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('submitting')}
          </>
        ) : (
          t('submit')
        )}
      </Button>
    </form>
  );
}
