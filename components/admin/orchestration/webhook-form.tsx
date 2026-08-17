'use client';

/**
 * WebhookForm
 *
 * Shared create / edit form for event subscriptions. The same row model
 * carries either a webhook destination (URL + HMAC secret) or an email
 * destination — the channel selector toggles which fields are required.
 *
 * Follows the agent-form pattern: react-hook-form + zodResolver.
 */

import { useEffect, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import {
  AlertCircle,
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Mail,
  Save,
  KeyRound,
  Webhook,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { EVENT_LABELS } from '@/lib/orchestration/webhooks/event-labels';
import { useTimeout } from '@/lib/hooks/use-timeout';
import {
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS_MIN,
  WEBHOOK_MAX_ATTEMPTS_MAX,
  isWiredWebhookEvent,
} from '@/lib/validations/orchestration';

// ─── Schema ────────────────────────────────────────────────────────────────

const commonFields = {
  channel: z.enum(['webhook', 'email']),
  events: z.array(z.string()).min(1, 'Select at least one event'),
  agentIds: z.array(z.string()).max(50, 'At most 50 agents per subscription'),
  workflowIds: z.array(z.string()).max(50, 'At most 50 workflows per subscription'),
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

// The destination fields are always part of the form so React-Hook-Form's
// register calls don't trip on a missing key when the user switches
// channels. Per-channel requirements are enforced by `.refine` below.
const destinationFields = {
  url: z.string().max(2000).optional().or(z.literal('')),
  secret: z.string().max(256).optional().or(z.literal('')),
  emailAddress: z.string().max(320).optional().or(z.literal('')),
};

function refineChannelFields<
  T extends {
    channel: 'webhook' | 'email';
    url?: string;
    secret?: string;
    emailAddress?: string;
    retryBackoffSeconds: string;
    maxAttempts: number;
  },
>(schema: z.ZodType<T>, opts: { allowEmptySecret: boolean }): z.ZodType<T> {
  return schema
    .refine(
      (data) => {
        if (data.channel !== 'webhook') return true;
        const url = data.url ?? '';
        if (!url) return false;
        try {
          new URL(url);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'Must be a valid URL', path: ['url'] }
    )
    .refine(
      (data) => {
        if (data.channel !== 'webhook') return true;
        const secret = data.secret ?? '';
        if (opts.allowEmptySecret && secret === '') return true;
        return secret.length >= 16;
      },
      { message: 'Secret must be at least 16 characters', path: ['secret'] }
    )
    .refine(
      (data) => {
        if (data.channel !== 'email') return true;
        const email = data.emailAddress ?? '';
        // basic email check — server-side Zod uses z.string().email() which
        // is stricter; this just catches the empty / clearly-wrong cases.
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      },
      { message: 'Must be a valid email address', path: ['emailAddress'] }
    )
    .refine(
      (data) => parseBackoffSeconds(data.retryBackoffSeconds).length >= data.maxAttempts - 1,
      {
        message: 'Need at least (maxAttempts - 1) backoff values',
        path: ['retryBackoffSeconds'],
      }
    );
}

const createWebhookSchema = refineChannelFields(
  z.object({ ...commonFields, ...destinationFields }),
  { allowEmptySecret: false }
);

// In edit mode an empty secret means "keep the existing one" — onSubmit
// omits the secret field from the PATCH body so it's never sent.
const editWebhookSchema = refineChannelFields(z.object({ ...commonFields, ...destinationFields }), {
  allowEmptySecret: true,
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
    channel: 'webhook' | 'email';
    url: string | null;
    emailAddress: string | null;
    events: string[];
    agentIds: string[];
    workflowIds: string[];
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
  const schedule = useTimeout();
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
    // zodResolver's typing trips on our refined union (input is `unknown`).
    // The disable-comment narrows the eslint scope to the cast itself —
    // runtime behaviour is unchanged; the schema still drives validation.
    resolver: zodResolver(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (isEdit ? editWebhookSchema : createWebhookSchema) as any
    ) as Resolver<WebhookFormData>,
    defaultValues: {
      channel: webhook?.channel ?? 'webhook',
      url: webhook?.url ?? '',
      secret: '',
      emailAddress: webhook?.emailAddress ?? '',
      events: webhook?.events ?? [],
      agentIds: webhook?.agentIds ?? [],
      workflowIds: webhook?.workflowIds ?? [],
      description: webhook?.description ?? '',
      isActive: webhook?.isActive ?? true,
      maxAttempts: webhook?.maxAttempts ?? 3,
      retryBackoffSeconds: defaultBackoffSeconds,
    },
  });

  const currentChannel = watch('channel');
  const currentEvents = watch('events');
  const currentIsActive = watch('isActive');
  const currentSecret = watch('secret');
  const currentAgentIds = watch('agentIds');
  const currentWorkflowIds = watch('workflowIds');
  const hasSecretValue = Boolean(currentSecret && currentSecret.length > 0);

  // Pre-fetch labels for any pre-selected agents/workflows so chips render
  // human names instead of raw CUIDs. The async loaders below only know
  // what the user types — without this lookup, edit-mode chips would show
  // bare IDs until the user typed something. See knowledge-access-section.tsx.
  const [selectedAgentLabels, setSelectedAgentLabels] = useState<Record<string, string>>({});
  const [selectedWorkflowLabels, setSelectedWorkflowLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (currentAgentIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const agents = await apiClient.get<Array<{ id: string; name: string; slug: string }>>(
          `${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100`
        );
        if (cancelled) return;
        const labels: Record<string, string> = {};
        for (const a of agents ?? []) {
          if (currentAgentIds.includes(a.id)) labels[a.id] = a.name;
        }
        setSelectedAgentLabels(labels);
      } catch {
        // Non-fatal — chips fall back to IDs until the user searches.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentAgentIds]);

  useEffect(() => {
    if (currentWorkflowIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const workflows = await apiClient.get<Array<{ id: string; name: string; slug: string }>>(
          `${API.ADMIN.ORCHESTRATION.WORKFLOWS}?limit=100`
        );
        if (cancelled) return;
        const labels: Record<string, string> = {};
        for (const w of workflows ?? []) {
          if (currentWorkflowIds.includes(w.id)) labels[w.id] = w.name;
        }
        setSelectedWorkflowLabels(labels);
      } catch {
        // Non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWorkflowIds]);

  async function loadAgentOptions(query: string): Promise<MultiSelectOption[]> {
    const url = new URL(API.ADMIN.ORCHESTRATION.AGENTS, window.location.origin);
    url.searchParams.set('limit', '50');
    if (query.trim()) url.searchParams.set('q', query.trim());
    try {
      const agents = await apiClient.get<Array<{ id: string; name: string; slug: string }>>(
        `${url.pathname}${url.search}`
      );
      return (agents ?? []).map((a) => ({
        value: a.id,
        label: a.name,
        description: a.slug,
      }));
    } catch {
      return [];
    }
  }

  async function loadWorkflowOptions(query: string): Promise<MultiSelectOption[]> {
    const url = new URL(API.ADMIN.ORCHESTRATION.WORKFLOWS, window.location.origin);
    url.searchParams.set('limit', '50');
    // Hide templates — they aren't instantiated runtime entities, so they
    // never appear in event payloads and scoping a sub to one is a no-op.
    url.searchParams.set('isTemplate', 'false');
    if (query.trim()) url.searchParams.set('q', query.trim());
    try {
      const workflows = await apiClient.get<Array<{ id: string; name: string; slug: string }>>(
        `${url.pathname}${url.search}`
      );
      return (workflows ?? []).map((w) => ({
        value: w.id,
        label: w.name,
        description: w.slug,
      }));
    } catch {
      return [];
    }
  }

  const copySecret = async () => {
    if (!currentSecret) return;
    setSecretCopyError(null);
    try {
      await navigator.clipboard.writeText(currentSecret);
      setSecretCopied(true);
      schedule(() => setSecretCopied(false), 2000);
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
      const retryBackoffMs = parseBackoffSeconds(data.retryBackoffSeconds).map((s) => s * 1000);

      // Build a clean payload — only the destination fields that belong
      // to the selected channel should reach the API. The form keeps the
      // "other" channel's fields populated so a flip-back doesn't lose
      // typed input, but we don't want to ship a stale URL when the user
      // chose email (or vice versa).
      const payload: Record<string, unknown> = {
        channel: data.channel,
        events: data.events,
        agentIds: data.agentIds,
        workflowIds: data.workflowIds,
        description: data.description,
        isActive: data.isActive,
        maxAttempts: data.maxAttempts,
        retryBackoffMs,
      };
      if (data.channel === 'webhook') {
        payload.url = data.url;
        if (data.secret) payload.secret = data.secret;
      } else {
        payload.emailAddress = data.emailAddress;
      }

      if (isEdit && webhook) {
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
          : 'Could not save subscription. Try again in a moment.'
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

      {/* Channel selector */}
      <div className="grid gap-2">
        <Label>
          Delivery channel{' '}
          <FieldHelp title="How notifications are delivered">
            <p>Choose how Sunrise should send each matching event:</p>
            <ul className="mt-2 list-disc space-y-1 pl-4">
              <li>
                <span className="font-medium">Webhook</span> — POSTs a signed JSON payload to a URL
                you provide. Best for integrations with your own backend, Zapier, n8n, Slack&apos;s
                incoming-webhook URL, etc.
              </li>
              <li>
                <span className="font-medium">Email</span> — sends a formatted email to the address
                you provide. Best for human notifications.
              </li>
            </ul>
            <p className="mt-2 text-xs">
              One subscription = one channel. Need both? Create two subscriptions.
            </p>
          </FieldHelp>
        </Label>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { value: 'webhook', label: 'Webhook', icon: Webhook },
              { value: 'email', label: 'Email', icon: Mail },
            ] as const
          ).map(({ value, label, icon: Icon }) => {
            const selected = currentChannel === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setValue('channel', value, { shouldValidate: true })}
                className={`flex items-center gap-2 rounded-md border p-3 text-sm transition-colors ${
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                }`}
              >
                <Icon
                  className={`h-4 w-4 ${selected ? 'text-primary' : 'text-muted-foreground'}`}
                />
                <span className={selected ? 'font-medium' : ''}>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Webhook-channel fields */}
      {currentChannel === 'webhook' && (
        <>
          <div className="grid gap-2">
            <Label htmlFor="url">
              Endpoint URL{' '}
              <FieldHelp title="Where to send events">
                The URL of your external system that should receive event notifications (e.g. a
                Slack integration, your backend API, or a service like Zapier). Sunrise will send a
                POST request to this address each time a selected event fires. Must be publicly
                reachable over HTTP or HTTPS — private IPs, localhost, and cloud metadata endpoints
                are blocked for security.
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

          <div className="grid gap-2">
            <Label htmlFor="secret">
              Signing secret{' '}
              <FieldHelp title="How signing works">
                A shared secret between Sunrise and your endpoint, used to prove each delivery is
                genuine. Sunrise hashes every request body with this secret and includes the result
                in the <code>X-Webhook-Signature</code> header. Your endpoint re-computes the same
                hash — if it matches, the request definitely came from Sunrise and hasn&apos;t been
                tampered with. Must be at least 16 characters. Click the key icon to generate one
                automatically.
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
                Copy this secret now — Sunrise won&apos;t display it again after you save. Paste it
                into your receiver so it can verify the <code>X-Webhook-Signature</code> header.
              </p>
            )}
            {secretCopyError && <p className="text-destructive text-xs">{secretCopyError}</p>}
            {errors.secret && <p className="text-destructive text-xs">{errors.secret.message}</p>}
          </div>
        </>
      )}

      {/* Email-channel fields */}
      {currentChannel === 'email' && (
        <div className="grid gap-2">
          <Label htmlFor="emailAddress">
            Email address{' '}
            <FieldHelp title="Where to send the email">
              The destination email address for event notifications. Sunrise renders a formatted
              email with the same data a webhook receiver would get and sends it via the configured
              email provider. Best for human notifications — alerts to an on-call team, copies to a
              shared inbox, etc.
            </FieldHelp>
          </Label>
          <Input
            id="emailAddress"
            type="email"
            {...register('emailAddress')}
            placeholder="alerts@example.com"
            className="font-mono"
          />
          {errors.emailAddress && (
            <p className="text-destructive text-xs">{errors.emailAddress.message}</p>
          )}
          <p className="text-muted-foreground text-xs">
            Requires <code>RESEND_API_KEY</code> and <code>EMAIL_FROM</code> to be configured on the
            server.
          </p>
        </div>
      )}

      {/* Description */}
      <div className="grid gap-2">
        <Label htmlFor="description">
          Description{' '}
          <FieldHelp title="Optional note">
            A short note to help you remember what this subscription is for — e.g. &ldquo;Slack
            budget alerts channel&rdquo; or &ldquo;On-call email&rdquo;.
          </FieldHelp>
        </Label>
        <Textarea id="description" rows={2} {...register('description')} placeholder="Optional" />
      </div>

      {/* Events */}
      <div className="grid gap-2">
        <Label>
          Events{' '}
          <FieldHelp title="Which events trigger this subscription" contentClassName="w-96">
            <p>
              Pick the events you care about. Each time one fires, Sunrise sends a notification via
              the selected channel.
            </p>
            <p className="text-foreground mt-2 font-medium">Example use cases</p>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              <li>
                <span className="font-medium">Budget Exceeded</span> → email the finance owner so
                they know an agent hit its spending limit
              </li>
              <li>
                <span className="font-medium">Approval Required</span> → webhook to JIRA or Zendesk
                to create a ticket
              </li>
              <li>
                <span className="font-medium">Workflow Failed</span> → webhook to PagerDuty so
                on-call engineers investigate
              </li>
            </ul>
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

      {/* Entity scope */}
      <div className="grid gap-4 rounded-lg border p-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Scope</p>
          <p className="text-muted-foreground text-xs">
            Optional. Limit this subscription to specific agents or workflows. Each filter applies
            only to events about that kind of entity — for example, an agent filter does not affect
            workflow_failed events.
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="webhook-agent-scope">
            Limit to agents{' '}
            <FieldHelp title="Limit to specific agents">
              Only fire when the event is about one of the agents you select here. Leave empty to
              receive events for all agents. Events that aren&apos;t about an agent (like
              workflow_failed) ignore this filter — set the workflow filter below for those.
            </FieldHelp>
          </Label>
          <MultiSelect
            id="webhook-agent-scope"
            value={currentAgentIds}
            onChange={(next) => setValue('agentIds', next, { shouldValidate: true })}
            loadOptions={loadAgentOptions}
            selectedLabels={selectedAgentLabels}
            placeholder="All agents"
            emptyText="No matching agents."
          />
          {errors.agentIds && <p className="text-destructive text-xs">{errors.agentIds.message}</p>}
        </div>

        <div className="grid gap-2">
          <Label htmlFor="webhook-workflow-scope">
            Limit to workflows{' '}
            <FieldHelp title="Limit to specific workflows">
              Only fire when the event is about one of the workflows you select here. Leave empty to
              receive events for all workflows. Events that aren&apos;t about a workflow (like
              budget_exceeded for a chat agent) ignore this filter — set the agent filter above for
              those.
            </FieldHelp>
          </Label>
          <MultiSelect
            id="webhook-workflow-scope"
            value={currentWorkflowIds}
            onChange={(next) => setValue('workflowIds', next, { shouldValidate: true })}
            loadOptions={loadWorkflowOptions}
            selectedLabels={selectedWorkflowLabels}
            placeholder="All workflows"
            emptyText="No matching workflows."
          />
          {errors.workflowIds && (
            <p className="text-destructive text-xs">{errors.workflowIds.message}</p>
          )}
        </div>
      </div>

      {/* Retry policy */}
      <div className="grid gap-4 rounded-lg border p-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Retry policy</p>
          <p className="text-muted-foreground text-xs">
            How Sunrise handles delivery failures before giving up and moving the delivery into the
            Dead Letter Queue.
            {currentChannel === 'email' && (
              <>
                {' '}
                For email subscriptions this controls how often Sunrise retries against its own
                provider; the email provider also handles its own retry semantics out-of-band.
              </>
            )}
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
            Inactive subscriptions stop receiving deliveries but keep their configuration.
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
