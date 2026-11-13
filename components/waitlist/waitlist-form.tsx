'use client';

/**
 * The public waitlist join form (§125).
 *
 * Renders email, an optional name, and the fields the fork declares in
 * `lib/app/waitlist-config.ts`, and posts to `POST /api/v1/waitlist`. Most
 * pages mount the server wrapper `<Waitlist />`, which reads the config and
 * whether the list is open; mount this directly only to supply the fields
 * yourself.
 *
 * The copy is the fork's: every label, placeholder and message the form draws
 * is a `copy` prop with a neutral default. The exceptions are the schema's
 * validation messages, which come from the field labels the fork declares.
 * A list closed since the page rendered (the route's 409) shows the closed
 * message, as a list closed at render does. Styling comes from the surface's theme tokens, like any other form.
 *
 * The success state says the same thing whatever the server did — the route
 * gives one answer for a first join, a repeat and a removed address, and so
 * does this.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { emailSchema } from '@/lib/validations/auth';
import { buildWaitlistDetailsSchema, type WaitlistFieldShape } from '@/lib/validations/waitlist';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormError, SaveError } from '@/components/forms/form-error';
import { NoScriptNotice } from '@/components/forms/no-script-notice';

/** Every sentence the form shows (the schema's own validation messages aside). */
export interface WaitlistFormCopy {
  emailLabel: string;
  emailPlaceholder: string;
  nameLabel: string;
  /** Shown beside an optional field's label. */
  optionalMarker: string;
  /** A select's text before anything is chosen. */
  selectPlaceholder: string;
  /** The item that takes back an optional select's answer. */
  selectNoAnswerLabel: string;
  /** Shown beside the button when a join fails for a reason the server did not give. */
  failureMessage: string;
  submitLabel: string;
  submittingLabel: string;
  successTitle: string;
  successMessage: string;
  closedMessage: string;
  /** Shown above the button: what joining means and where the privacy notice is. */
  consentNotice: ReactNode;
}

/** The optional select's "no answer" item: Radix forbids an empty item value. */
const NO_ANSWER = '__no_answer__';

const DEFAULT_COPY: WaitlistFormCopy = {
  emailLabel: 'Email',
  emailPlaceholder: 'you@example.com',
  nameLabel: 'Name (optional)',
  optionalMarker: '(optional)',
  selectPlaceholder: 'Choose one',
  selectNoAnswerLabel: 'No answer',
  failureMessage: 'Something went wrong. Please try again in a moment.',
  submitLabel: 'Join the waitlist',
  submittingLabel: 'Joining…',
  successTitle: 'Thanks for joining',
  successMessage: 'We’ll be in touch when there’s a place for you.',
  closedMessage: 'This waitlist isn’t taking new sign-ups right now.',
  consentNotice: null,
};

export interface WaitlistFormProps {
  /** The fork's declared fields, in form order. */
  fields: readonly WaitlistFieldShape[];
  /** The list this form joins. */
  list: string;
  /** Show the closed message instead of the form. */
  closed?: boolean;
  copy?: Partial<WaitlistFormCopy>;
  className?: string;
}

/** The attribution a page arrived with: UTM tags from its URL, and the page before it. */
function attribution(): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(window.location.search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const value = params.get(key);
    if (value) out[key] = value.slice(0, 100);
  }
  if (document.referrer) out.referrer = document.referrer.slice(0, 2048);
  return out;
}

export function WaitlistForm({ fields, list, closed = false, copy, className }: WaitlistFormProps) {
  const text = { ...DEFAULT_COPY, ...copy };
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  // Closed when the page rendered, or closed since: the route's 409 says so.
  const [isClosed, setIsClosed] = useState(closed);

  const schema = useMemo(
    () =>
      z.object({
        email: emailSchema,
        name: z.string().trim().max(100, 'Name must be 100 characters or fewer'),
        details: buildWaitlistDetailsSchema(fields),
        website: z.string(),
      }),
    [fields]
  );

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: {
      email: '',
      name: '',
      details: Object.fromEntries(fields.map((f) => [f.key, ''])),
      website: '',
    },
  });

  const serverFields = useMemo(() => {
    const map: Partial<Record<string, 'email' | 'name' | `details.${string}`>> = {
      email: 'email',
      name: 'name',
    };
    for (const f of fields) map[`details.${f.key}`] = `details.${f.key}`;
    return map;
  }, [fields]);

  const save = useSaveFailure({
    fallback: text.failureMessage,
    fields: serverFields,
    setError,
    errors,
  });

  const onSubmit = async (data: z.output<typeof schema>) => {
    try {
      setIsLoading(true);
      await apiClient.post(API.PUBLIC.WAITLIST, {
        body: {
          email: data.email,
          name: data.name || null,
          list,
          details: data.details,
          website: data.website,
          ...attribution(),
        },
      });
      setIsSuccess(true);
    } catch (err) {
      if (err instanceof APIClientError && err.code === 'WAITLIST_CLOSED') setIsClosed(true);
      else save.report(err);
    } finally {
      setIsLoading(false);
    }
  };

  if (isClosed) {
    return (
      <p className={className} role="status">
        {text.closedMessage}
      </p>
    );
  }

  if (isSuccess) {
    return (
      <div className={className} role="status">
        <div className="space-y-3 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/20">
            <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" aria-hidden />
          </div>
          <h3 className="text-lg font-semibold">{text.successTitle}</h3>
          <p className="text-muted-foreground">{text.successMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={save.submit(handleSubmit(onSubmit, save.invalid))}
      className={['space-y-4', className].filter(Boolean).join(' ')}
    >
      <NoScriptNotice />
      {/* Honeypot — invisible to people, filled by bots. Decided on its value by the route. */}
      <div className="absolute -left-[9999px] opacity-0" aria-hidden="true">
        <label htmlFor="waitlist-website">Website (leave blank)</label>
        <input
          type="text"
          id="waitlist-website"
          tabIndex={-1}
          autoComplete="off"
          {...register('website')}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="waitlist-email">{text.emailLabel}</Label>
        <Input
          id="waitlist-email"
          type="email"
          autoComplete="email"
          placeholder={text.emailPlaceholder}
          disabled={isLoading}
          {...register('email')}
        />
        <FormError message={errors.email?.message} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="waitlist-name">{text.nameLabel}</Label>
        <Input
          id="waitlist-name"
          type="text"
          autoComplete="given-name"
          disabled={isLoading}
          {...register('name')}
        />
        <FormError message={errors.name?.message} />
      </div>

      {fields.map((field) => {
        const id = `waitlist-${field.key}`;
        const error = errors.details?.[field.key]?.message;
        const label = (
          <Label htmlFor={id} className="flex items-center gap-1">
            {field.label}
            {field.required ? null : (
              <span className="text-muted-foreground">{text.optionalMarker}</span>
            )}
            {field.help ? <FieldHelp title={field.label}>{field.help}</FieldHelp> : null}
          </Label>
        );
        return (
          <div key={field.key} className="space-y-2">
            {label}
            {field.kind === 'select' ? (
              <Controller
                name={`details.${field.key}`}
                control={control}
                render={({ field: control }) => (
                  <Select
                    // Always controlled: '' shows the placeholder (no answer).
                    value={typeof control.value === 'string' ? control.value : ''}
                    onValueChange={(v) => control.onChange(v === NO_ANSWER ? '' : v)}
                    // Closing the menu is the select's blur: it marks the field
                    // touched, as the text fields' blur does under onTouched.
                    onOpenChange={(open) => {
                      if (!open) control.onBlur();
                    }}
                    disabled={isLoading}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue placeholder={text.selectPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {/* An optional answer can be taken back; a required one cannot be blank. */}
                      {field.required ? null : (
                        <SelectItem value={NO_ANSWER}>{text.selectNoAnswerLabel}</SelectItem>
                      )}
                      {(field.options ?? []).map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            ) : field.kind === 'textarea' ? (
              <Textarea
                id={id}
                className="min-h-[100px] resize-y"
                disabled={isLoading}
                {...register(`details.${field.key}`)}
              />
            ) : (
              <Input
                id={id}
                type="text"
                disabled={isLoading}
                {...register(`details.${field.key}`)}
              />
            )}
            <FormError message={error} />
          </div>
        );
      })}

      {text.consentNotice ? (
        <div className="text-muted-foreground text-sm">{text.consentNotice}</div>
      ) : null}

      <SaveError failure={save.failure} />

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            {text.submittingLabel}
          </>
        ) : (
          text.submitLabel
        )}
      </Button>
    </form>
  );
}
