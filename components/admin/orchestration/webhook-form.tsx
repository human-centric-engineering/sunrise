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
import { AlertCircle, Loader2, Save, KeyRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { WEBHOOK_EVENT_TYPES } from '@/lib/validations/orchestration';

// ─── Schema ────────────────────────────────────────────────────────────────

const webhookFormSchema = z.object({
  url: z.string().url('Must be a valid URL').max(2000),
  secret: z.string().min(16, 'Secret must be at least 16 characters').max(256),
  events: z.array(z.string()).min(1, 'Select at least one event'),
  description: z.string().max(500).optional(),
  isActive: z.boolean(),
});

type WebhookFormData = z.infer<typeof webhookFormSchema>;

// ─── Props ─────────────────────────────────────────────────────────────────

export interface WebhookFormProps {
  mode: 'create' | 'edit';
  webhook?: {
    id: string;
    url: string;
    events: string[];
    isActive: boolean;
    description: string | null;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function generateSecret(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const hex = Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
  return `whsec_${hex}`;
}

const EVENT_LABELS: Record<string, string> = {
  budget_exceeded: 'Budget Exceeded',
  workflow_failed: 'Workflow Failed',
  approval_required: 'Approval Required',
  circuit_breaker_opened: 'Circuit Breaker Opened',
  conversation_started: 'Conversation Started',
  conversation_completed: 'Conversation Completed',
  message_created: 'Message Created',
  agent_updated: 'Agent Updated',
  budget_threshold_reached: 'Budget Threshold Reached',
  execution_completed: 'Execution Completed',
  execution_failed: 'Execution Failed',
};

// ─── Component ─────────────────────────────────────────────────────────────

export function WebhookForm({ mode, webhook }: WebhookFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<WebhookFormData>({
    resolver: zodResolver(webhookFormSchema),
    defaultValues: {
      url: webhook?.url ?? '',
      secret: '',
      events: webhook?.events ?? [],
      description: webhook?.description ?? '',
      isActive: webhook?.isActive ?? true,
    },
  });

  const currentEvents = watch('events');
  const currentIsActive = watch('isActive');

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
      if (isEdit && webhook) {
        // Only send secret if the user typed a new one
        const payload: Record<string, unknown> = { ...data };
        if (!data.secret) delete payload.secret;
        await apiClient.patch(API.ADMIN.ORCHESTRATION.webhookById(webhook.id), {
          body: payload,
        });
        router.push('/admin/orchestration/webhooks');
      } else {
        await apiClient.post(API.ADMIN.ORCHESTRATION.WEBHOOKS, {
          body: data,
        });
        router.push('/admin/orchestration/webhooks');
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
          {isEdit ? 'Edit webhook' : 'New webhook subscription'}
        </h1>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/webhooks">Cancel</Link>
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
                {isEdit ? 'Save changes' : 'Create webhook'}
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
            The HTTPS URL that will receive webhook POST requests. Must be a publicly reachable
            address — private IPs, localhost, and cloud metadata endpoints are blocked for security.
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
      </div>

      {/* Secret */}
      <div className="grid gap-2">
        <Label htmlFor="secret">
          Signing secret{' '}
          <FieldHelp title="HMAC verification">
            Used to sign each delivery with an HMAC-SHA256 signature in the{' '}
            <code>X-Webhook-Signature</code> header. Your endpoint should verify this to confirm the
            request came from Sunrise. Must be at least 16 characters.
          </FieldHelp>
        </Label>
        <div className="flex gap-2">
          <Input
            id="secret"
            type="password"
            {...register('secret')}
            placeholder={
              isEdit ? 'Leave blank to keep current secret' : 'Enter or generate a secret'
            }
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => setValue('secret', generateSecret(), { shouldValidate: true })}
            title="Generate a random secret"
          >
            <KeyRound className="h-4 w-4" />
          </Button>
        </div>
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
          <FieldHelp title="Which events trigger this webhook">
            Select the event types that should fire a POST to your endpoint. Each delivery includes
            the event type, timestamp, and relevant payload.
          </FieldHelp>
        </Label>
        <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
          {WEBHOOK_EVENT_TYPES.map((event) => {
            const checked = currentEvents.includes(event);
            return (
              <label key={event} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="rounded border-gray-300"
                  checked={checked}
                  onChange={() => toggleEvent(event)}
                />
                {EVENT_LABELS[event] ?? event}
              </label>
            );
          })}
        </div>
        {errors.events && <p className="text-destructive text-xs">{errors.events.message}</p>}
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
