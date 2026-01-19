'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { contactSchema, type ContactInput } from '@/lib/validations/contact';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormError } from './form-error';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';

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
  const [error, setError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ContactInput>({
    resolver: zodResolver(contactSchema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      subject: '',
      message: '',
    },
  });

  const onSubmit = async (data: ContactInput) => {
    try {
      setIsLoading(true);
      setError(null);

      // Include honeypot field in submission
      const formData = {
        ...data,
        website: '', // Honeypot field - should be empty for real users
      };

      await apiClient.post<ContactFormResponse>('/api/v1/contact', {
        body: formData,
      });

      setIsSuccess(true);
      reset();
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
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
          <h3 className="text-lg font-semibold">Message Sent!</h3>
          <p className="text-muted-foreground mt-1">
            Thank you for reaching out. We&apos;ll get back to you as soon as possible.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
      {/* Hidden honeypot field - invisible to real users, attracts bots */}
      <div className="absolute -left-[9999px] opacity-0" aria-hidden="true">
        <label htmlFor="website">Website (leave blank)</label>
        <input type="text" id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {/* Name Field */}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          type="text"
          placeholder="Your name"
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

      {/* Subject Field */}
      <div className="space-y-2">
        <Label htmlFor="subject">Subject</Label>
        <Input
          id="subject"
          type="text"
          placeholder="What is this about?"
          disabled={isLoading}
          {...register('subject')}
        />
        <FormError message={errors.subject?.message} />
      </div>

      {/* Message Field */}
      <div className="space-y-2">
        <Label htmlFor="message">Message</Label>
        <Textarea
          id="message"
          placeholder="Your message..."
          className="min-h-[120px] resize-y"
          disabled={isLoading}
          {...register('message')}
        />
        <FormError message={errors.message?.message} />
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      {/* Submit Button */}
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Sending...
          </>
        ) : (
          'Send Message'
        )}
      </Button>
    </form>
  );
}
