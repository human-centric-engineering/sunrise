'use client';

/**
 * WebhookForm
 *
 * Shared create / edit form for webhook subscriptions.
 * Follows the agent-form pattern: react-hook-form + zodResolver.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { AlertCircle, Check, Copy, Eye, EyeOff, Loader2, Save, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { EVENT_LABELS } from '@/lib/orchestration/webhooks/event-labels';
import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS_MIN,
  WEBHOOK_MAX_ATTEMPTS_MAX,
  isWiredWebhookEvent,
} from '@/lib/validations/orchestration';

// ─── Schema ────────────────────────────────────────────────────────────────

const baseFields = {
  url: z.string().url('Must be a valid URL').max(2000),
  events: z.array(z.string()).min(1, 'Select at least one event'),
  description: z.string().max(500).optional(),
  isActive: z.boolean(),
  maxAttempts: z
    .number()
    .int()
    .min(WEBHOOK_MAX_ATTEMPTS_MIN, `Must be at least ${WEBHOOK_MAX_ATTEMPTS_MIN}`)
    .max(WEBHOOK_MAX_ATTEMPTS_MAX, `Must be at most ${WEBHOOK_MAX_ATTEMPTS_MAX}`),
  // Comma- or space-separated list of seconds — easier to enter than ms in a
  // text field. Submission converts to the ms-array the API expects.
  retryBackoffSeconds: z
    .string()
    .refine((v) => v.trim().length > 0, 'At least one backoff value is required')
    .refine(
      (v) =>
        v
          .split(/[\s,]+/)
          .filter(Boolean)
          .every((part) => /^\d+$/.test(part) && Number(part) >= 1 && Number(part) <= 86400),
      'Each backoff must be a whole number of seconds between 1 and 86400 (24h)'
    ),
};

const createWebhookSchema = z
  .object({
    ...baseFields,
    secret: z.string().min(16, 'Secret must be at least 16 characters').max(256),
  })
  .refine((data) => parseBackoffSeconds(data.retryBackoffSeconds).length >= data.maxAttempts - 1, {
    message: 'Need at least (maxAttempts - 1) backoff values',
    path: ['retryBackoffSeconds'],
  });

// In edit mode an empty secret means "keep the existing one" — onSubmit omits
// the secret field from the PATCH body so it's never sent to the server.
const editWebhookSchema = z
  .object({
    ...baseFields,
    secret: z
      .string()
      .max(256)
      .refine((v) => v === '' || v.length >= 16, 'Secret must be at least 16 characters'),
  })
  .refine((data) => parseBackoffSeconds(data.retryBackoffSeconds).length >= data.maxAttempts - 1, {
    message: 'Need at least (maxAttempts - 1) backoff values',
    path: ['retryBackoffSeconds'],
  });

type WebhookFormData = z.infer<typeof createWebhookSchema>;

function parseBackoffSeconds(input: string): number[] {
  return input
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => Number(s));
}

// ─── Props ─────────────────────────────────────────────────────────────────

export interface WebhookFormProps {
  mode: 'create' | 'edit';
  webhook?: {
    id: string;
    url: string;
    events: string[];
    isActive: boolean;
    description: string | null;
    maxAttempts: number;
    retryBackoffMs: number[];
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function generateSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const hex = Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  return `whsec_${hex}`;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function WebhookForm({ mode, webhook }: WebhookFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretRevealed, setSecretRevealed] = useState(false);
  // Briefly latched to give the copy button a "✓ Copied" affordance.
  const [secretCopied, setSecretCopied] = useState(false);
  const [secretCopyError, setSecretCopyError] = useState<string | null>(null);

  const defaultBackoffSeconds = webhook?.retryBackoffMs
    ? webhook.retryBackoffMs.map((ms) => Math.round(ms / 1000)).join(', ')
    : '10, 60, 300';

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<WebhookFormData>({
    resolver: zodResolver(isEdit ? editWebhookSchema : createWebhookSchema),
    defaultValues: {
      url: webhook?.url ?? '',
      secret: '',
      events: webhook?.events ?? [],
      description: webhook?.description ?? '',
      isActive: webhook?.isActive ?? true,
      maxAttempts: webhook?.maxAttempts ?? 3,
      retryBackoffSeconds: defaultBackoffSeconds,
    },
  });

  const currentEvents = watch('events');
  const currentIsActive = watch('isActive');
  const currentSecret = watch('secret');
  const hasSecretValue = Boolean(currentSecret && currentSecret.length > 0);

  const copySecret = async () => {
    if (!currentSecret) return;
    setSecretCopyError(null);
    try {
      await navigator.clipboard.writeText(currentSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      setSecretCopyError(
        'Could not copy to clipboard. Your browser may require a secure (HTTPS) context.'
      );
    }
  };

  const toggleEvent = (event: string) => {
    const current = watch('events');
    if (current.includes(event)) {
      setValue(
        'events',
        current.filter((e: string) => e !== event),
        { shouldValidate: true }
      );
    } else {
      setValue('events', [...current, event], { shouldValidate: true });
    }
  };

  const onSubmit = async (data: WebhookFormData) => {
    setSubmitting(true);
    setError(null);
    try {
      // Convert the seconds-string the form uses into the ms-array the API expects.
      const { retryBackoffSeconds, ...rest } = data;
      const retryBackoffMs = parseBackoffSeconds(retryBackoffSeconds).map((s) => s * 1000);
      const payload: Record<string, unknown> = { ...rest, retryBackoffMs };

      if (isEdit && webhook) {
        // Only send secret if the user typed a new one
        if (!data.secret) delete payload.secret;
        await apiClient.patch(API.ADMIN.ORCHESTRATION.webhookById(webhook.id), {
          body: payload,
        });
        router.push('/admin/orchestration/event-subscriptions');
      } else {
        await apiClient.post(API.ADMIN.ORCHESTRATION.WEBHOOKS, {
          body: payload,
        });
        router.push('/admin/orchestration/event-subscriptions');
      }
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not save webhook. Try again in a moment.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="max-w-2xl space-y-6">
      {/* Sticky action bar */}
      <div className="bg-background/95 sticky top-0 z-10 -mx-2 flex items-center justify-between border-b px-2 py-3 backdrop-blur">
        <h1 className="text-xl font-semibold">
          {isEdit ? 'Edit subscription' : 'New event subscription'}
        </h1>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/event-subscriptions">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                {isEdit ? 'Save changes' : 'Create subscription'}
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* URL */}
      <div className="grid gap-2">
        <Label htmlFor="url">
          Endpoint URL{' '}
          <FieldHelp title="Where to send events">
            The URL of your external system that should receive event notifications (e.g. a Slack
            integration, your backend API, or a service like Zapier). Sunrise will send a POST
            request to this address each time a selected event fires. Must be publicly reachable
            over HTTP or HTTPS — private IPs, localhost, and cloud metadata endpoints are blocked
            for security.
          </FieldHelp>
        </Label>
        <Input
          id="url"
          type="url"
          {...register('url')}
          placeholder="https://example.com/webhooks/sunrise"
          className="font-mono"
        />
        {errors.url && <p className="text-destructive text-xs">{errors.url.message}</p>}
        <p className="text-muted-foreground text-xs">
          Private IPs, localhost, and cloud metadata endpoints are blocked.
        </p>
      </div>

      {/* Secret */}
      <div className="grid gap-2">
        <Label htmlFor="secret">
          Signing secret{' '}
          <FieldHelp title="How signing works">
            A shared secret between Sunrise and your endpoint, used to prove each delivery is
            genuine. Sunrise hashes every request body with this secret and includes the result in
            the <code>X-Webhook-Signature</code> header. Your endpoint re-computes the same hash —
            if it matches, the request definitely came from Sunrise and hasn&apos;t been tampered
            with. Must be at least 16 characters. Click the key icon to generate one automatically.
          </FieldHelp>
        </Label>
        <div className="flex gap-2">
          <Input
            id="secret"
            type={secretRevealed ? 'text' : 'password'}
            {...register('secret')}
            placeholder={
              isEdit ? 'Leave blank to keep current secret' : 'Enter or generate a secret'
            }
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            disabled={!hasSecretValue}
            onClick={() => setSecretRevealed((v) => !v)}
            title={secretRevealed ? 'Hide secret' : 'Reveal secret'}
            aria-label={secretRevealed ? 'Hide secret' : 'Reveal secret'}
          >
            {secretRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!hasSecretValue}
            onClick={() => void copySecret()}
            title="Copy secret to clipboard"
            aria-label="Copy secret to clipboard"
          >
            {secretCopied ? (
              <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setValue('secret', generateSecret(), { shouldValidate: true });
              setSecretRevealed(true);
            }}
            title="Generate a random secret"
            aria-label="Generate a random secret"
          >
            <KeyRound className="h-4 w-4" />
          </Button>
        </div>
        {hasSecretValue && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
            Copy this secret now — Sunrise won&apos;t display it again after you save. Paste it into
            your receiver so it can verify the <code>X-Webhook-Signature</code> header.
          </p>
        )}
        {secretCopyError && <p className="text-destructive text-xs">{secretCopyError}</p>}
        {errors.secret && <p className="text-destructive text-xs">{errors.secret.message}</p>}
      </div>

      {/* Description */}
      <div className="grid gap-2">
        <Label htmlFor="description">
          Description{' '}
          <FieldHelp title="Optional note">
            A short note to help you remember what this webhook is for — e.g. &ldquo;Slack budget
            alerts channel&rdquo; or &ldquo;PagerDuty circuit breaker&rdquo;.
          </FieldHelp>
        </Label>
        <Textarea id="description" rows={2} {...register('description')} placeholder="Optional" />
      </div>

      {/* Events */}
      <div className="grid gap-2">
        <Label>
          Events{' '}
          <FieldHelp title="Which events trigger this webhook" contentClassName="w-96">
            <p>
              Pick the events you care about. Each time one fires, Sunrise sends a POST with the
              event type, timestamp, and relevant data to your endpoint.
            </p>
            <p className="text-foreground mt-2 font-medium">Example use cases</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>
                <span className="font-medium">Budget Exceeded</span> → post to a Slack channel so
                your team knows an agent hit its spending limit
              </li>
              <li>
                <span className="font-medium">Approval Required</span> → create a support ticket in
                Zendesk or JIRA when an agent needs human approval
              </li>
              <li>
                <span className="font-medium">Workflow Failed</span> → trigger a PagerDuty alert so
                on-call engineers investigate
              </li>
            </ul>
            <p className="text-muted-foreground mt-2 text-xs">
              Tip: to send email, SMS, or WhatsApp notifications, point the webhook at an automation
              platform (Zapier, Make, n8n) or a service like SendGrid/Twilio that accepts incoming
              webhooks and routes to those channels.
            </p>
          </FieldHelp>
        </Label>
        <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
          {WEBHOOK_EVENT_TYPES.map((event) => {
            const checked = currentEvents.includes(event);
            // An event is "wired" when there's a dispatchWebhookEvent call
            // for it somewhere in the codebase. Unwired events stay in
            // the list (so admins know the full set) but are disabled.
            const wired = isWiredWebhookEvent(event);
            return (
              <label
                key={event}
                className={`flex items-center gap-2 text-sm ${
                  wired ? '' : 'text-muted-foreground cursor-not-allowed opacity-60'
                }`}
                title={wired ? undefined : 'This event is not yet supported.'}
              >
                <input
                  type="checkbox"
                  className="rounded border-gray-300 disabled:cursor-not-allowed"
                  checked={checked}
                  disabled={!wired}
                  onChange={() => wired && toggleEvent(event)}
                />
                <span>{EVENT_LABELS[event] ?? event}</span>
              </label>
            );
          })}
        </div>
        {errors.events && <p className="text-destructive text-xs">{errors.events.message}</p>}
      </div>

      {/* Retry policy */}
      <div className="grid gap-4 rounded-lg border p-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Retry policy</p>
          <p className="text-muted-foreground text-xs">
            How Sunrise handles delivery failures before giving up and moving the delivery into the
            Dead Letter Queue.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="maxAttempts">
            Maximum attempts{' '}
            <FieldHelp title="How many times to try">
              The total number of delivery attempts (including the first try) before Sunrise marks
              the delivery as <code>exhausted</code> and stops retrying. Allowed range:{' '}
              {WEBHOOK_MAX_ATTEMPTS_MIN}–{WEBHOOK_MAX_ATTEMPTS_MAX}. Default is 3.
            </FieldHelp>
          </Label>
          <Input
            id="maxAttempts"
            type="number"
            min={WEBHOOK_MAX_ATTEMPTS_MIN}
            max={WEBHOOK_MAX_ATTEMPTS_MAX}
            {...register('maxAttempts', { valueAsNumber: true })}
            className="w-32 font-mono"
          />
          {errors.maxAttempts && (
            <p className="text-destructive text-xs">{errors.maxAttempts.message}</p>
          )}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="retryBackoffSeconds">
            Backoff schedule (seconds){' '}
            <FieldHelp title="How long to wait between attempts">
              A comma-separated list of seconds — the wait before each retry. The first number is
              the wait after the first failure, the second after the second failure, and so on.
              Sunrise needs at least <code>(maxAttempts − 1)</code> values. Example:{' '}
              <code>10, 60, 300</code> gives a 10-second pause, then a minute, then five minutes.
              Each value must be between 1 second and 86400 (24 hours).
            </FieldHelp>
          </Label>
          <Input
            id="retryBackoffSeconds"
            {...register('retryBackoffSeconds')}
            placeholder="10, 60, 300"
            className="font-mono"
          />
          {errors.retryBackoffSeconds && (
            <p className="text-destructive text-xs">{errors.retryBackoffSeconds.message}</p>
          )}
        </div>
      </div>

      {/* Active toggle */}
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="space-y-0.5">
          <Label htmlFor="isActive">Active</Label>
          <p className="text-muted-foreground text-sm">
            Inactive webhooks stop receiving deliveries but keep their configuration.
          </p>
        </div>
        <Switch
          id="isActive"
          checked={currentIsActive}
          onCheckedChange={(v) => setValue('isActive', v)}
        />
      </div>
    </form>
  );
}
