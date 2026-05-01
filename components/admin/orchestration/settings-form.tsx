'use client';

/**
 * OrchestrationSettingsForm
 *
 * Comprehensive form for global orchestration settings, organized into
 * six sections: Safety, Limits, Retention, Approvals, Escalation, and Search.
 *
 * Uses react-hook-form + Zod for client-side validation, matching the
 * pattern used in agent-form.tsx and capability-form.tsx.
 */

import * as React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { AlertCircle, Check, Loader2, Save, Plus, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EscalationConfig {
  emailAddresses: string[];
  webhookUrl?: string;
  notifyOnPriority: 'all' | 'high' | 'medium_and_above';
}

export interface OrchestrationSettings {
  inputGuardMode: string | null;
  outputGuardMode: string | null;
  globalMonthlyBudgetUsd: number | null;
  defaultApprovalTimeoutMs: number | null;
  approvalDefaultAction: string | null;
  searchConfig: {
    keywordBoostWeight: number;
    vectorWeight: number;
    hybridEnabled?: boolean;
    bm25Weight?: number;
  } | null;
  webhookRetentionDays: number | null;
  costLogRetentionDays: number | null;
  auditLogRetentionDays: number | null;
  maxConversationsPerUser: number | null;
  maxMessagesPerConversation: number | null;
  escalationConfig?: EscalationConfig | null;
}

export interface SettingsFormProps {
  initialSettings: OrchestrationSettings;
}

// ─── Client-side validation schema ──────────────────────────────────────────

const GUARD_MODES = ['none', 'log_only', 'warn_and_continue', 'block'] as const;
const APPROVAL_ACTIONS = ['deny', 'allow'] as const;
const ESCALATION_PRIORITY_FILTERS = ['all', 'medium_and_above', 'high'] as const;

const nullableNumber = z
  .union([z.literal(''), z.coerce.number()])
  .transform((v) => (v === '' ? null : v));

const settingsFormSchema = z.object({
  // Safety
  inputGuardMode: z.enum(GUARD_MODES),
  outputGuardMode: z.enum(GUARD_MODES),
  // Limits
  globalMonthlyBudgetUsd: nullableNumber.pipe(z.number().nonnegative().max(1_000_000).nullable()),
  maxConversationsPerUser: nullableNumber.pipe(z.number().int().positive().max(10_000).nullable()),
  maxMessagesPerConversation: nullableNumber.pipe(
    z.number().int().positive().max(10_000).nullable()
  ),
  // Retention
  webhookRetentionDays: nullableNumber.pipe(z.number().int().positive().max(365).nullable()),
  costLogRetentionDays: nullableNumber.pipe(z.number().int().positive().max(365).nullable()),
  auditLogRetentionDays: nullableNumber.pipe(z.number().int().positive().max(3650).nullable()),
  // Approvals
  approvalTimeout: nullableNumber.pipe(z.number().int().positive().max(3_600_000).nullable()),
  approvalDefaultAction: z.enum(APPROVAL_ACTIONS),
  // Search
  keywordBoostWeight: nullableNumber.pipe(z.number().min(-0.2).max(0).nullable()),
  vectorWeight: nullableNumber.pipe(z.number().min(0.1).max(2.0).nullable()),
  hybridEnabled: z.boolean(),
  bm25Weight: nullableNumber.pipe(z.number().min(0.1).max(2.0).nullable()),
  // Escalation
  escalationEnabled: z.boolean(),
  escalationPriorityFilter: z.enum(ESCALATION_PRIORITY_FILTERS),
  escalationWebhookUrl: z.string().url().max(2000).or(z.literal('')).optional(),
});

type SettingsFormData = z.input<typeof settingsFormSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function toStr(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

function guardModeToForm(v: string | null): (typeof GUARD_MODES)[number] {
  if (v === null) return 'none';
  if (GUARD_MODES.includes(v as (typeof GUARD_MODES)[number])) {
    return v as (typeof GUARD_MODES)[number];
  }
  return 'log_only';
}

function guardModeToApi(v: string): string | null {
  return v === 'none' ? null : v;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function SettingsForm({ initialSettings }: SettingsFormProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const [savedEmails, setSavedEmails] = React.useState<string[]>(
    initialSettings.escalationConfig?.emailAddresses ?? []
  );
  const [escalationEmails, setEscalationEmails] = React.useState<string[]>(
    initialSettings.escalationConfig?.emailAddresses ?? []
  );
  const [emailInput, setEmailInput] = React.useState('');
  const [emailError, setEmailError] = React.useState<string | null>(null);

  const addEscalationEmail = () => {
    const val = emailInput.trim();
    if (!val) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      setEmailError('Enter a valid email address');
      return;
    }
    if (escalationEmails.includes(val)) {
      setEmailError('Email already added');
      return;
    }
    if (escalationEmails.length >= 20) {
      setEmailError('Maximum 20 email addresses');
      return;
    }
    setEmailError(null);
    setEscalationEmails((prev) => [...prev, val]);
    setEmailInput('');
  };

  const defaults: SettingsFormData = React.useMemo(
    () => ({
      inputGuardMode: guardModeToForm(initialSettings.inputGuardMode),
      outputGuardMode: guardModeToForm(initialSettings.outputGuardMode),
      globalMonthlyBudgetUsd: toStr(initialSettings.globalMonthlyBudgetUsd),
      maxConversationsPerUser: toStr(initialSettings.maxConversationsPerUser),
      maxMessagesPerConversation: toStr(initialSettings.maxMessagesPerConversation),
      webhookRetentionDays: toStr(initialSettings.webhookRetentionDays),
      costLogRetentionDays: toStr(initialSettings.costLogRetentionDays),
      auditLogRetentionDays: toStr(initialSettings.auditLogRetentionDays),
      approvalTimeout: toStr(initialSettings.defaultApprovalTimeoutMs),
      approvalDefaultAction: (initialSettings.approvalDefaultAction ?? 'deny') as 'deny' | 'allow',
      keywordBoostWeight: toStr(initialSettings.searchConfig?.keywordBoostWeight),
      vectorWeight: toStr(initialSettings.searchConfig?.vectorWeight),
      hybridEnabled: initialSettings.searchConfig?.hybridEnabled === true,
      bm25Weight: toStr(initialSettings.searchConfig?.bm25Weight),
      escalationEnabled: !!initialSettings.escalationConfig,
      escalationPriorityFilter: initialSettings.escalationConfig?.notifyOnPriority ?? 'all',
      escalationWebhookUrl: initialSettings.escalationConfig?.webhookUrl ?? '',
    }),
    [initialSettings]
  );

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<SettingsFormData>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: defaults,
  });

  const watchedKeyword = watch('keywordBoostWeight');
  const watchedVector = watch('vectorWeight');
  const watchedHybrid = watch('hybridEnabled');
  const searchPartialFill =
    (watchedKeyword !== '' && watchedVector === '') ||
    (watchedKeyword === '' && watchedVector !== '');

  React.useEffect(() => {
    reset(defaults);
  }, [defaults, reset]);

  // Track escalation email changes outside react-hook-form
  const emailsChanged = JSON.stringify(escalationEmails) !== JSON.stringify(savedEmails);
  const hasChanges = isDirty || emailsChanged;

  // zodResolver already validates and transforms the data via settingsFormSchema,
  // so `values` here is the parsed output type (numbers/null, not strings).
  const onSubmit = async (values: z.output<typeof settingsFormSchema>) => {
    setError(null);
    try {
      const searchConfig =
        values.keywordBoostWeight !== null && values.vectorWeight !== null
          ? {
              keywordBoostWeight: values.keywordBoostWeight,
              vectorWeight: values.vectorWeight,
              hybridEnabled: values.hybridEnabled,
              // When hybrid is on, default bm25Weight to 1.0 if the admin left it blank
              ...(values.hybridEnabled
                ? { bm25Weight: values.bm25Weight ?? 1.0 }
                : values.bm25Weight !== null
                  ? { bm25Weight: values.bm25Weight }
                  : {}),
            }
          : null;

      const escalationConfig =
        values.escalationEnabled && escalationEmails.length > 0
          ? {
              emailAddresses: escalationEmails,
              notifyOnPriority: values.escalationPriorityFilter,
              ...(values.escalationWebhookUrl ? { webhookUrl: values.escalationWebhookUrl } : {}),
            }
          : null;

      await apiClient.patch(API.ADMIN.ORCHESTRATION.SETTINGS, {
        body: {
          inputGuardMode: guardModeToApi(values.inputGuardMode),
          outputGuardMode: guardModeToApi(values.outputGuardMode),
          globalMonthlyBudgetUsd: values.globalMonthlyBudgetUsd,
          maxConversationsPerUser: values.maxConversationsPerUser,
          maxMessagesPerConversation: values.maxMessagesPerConversation,
          webhookRetentionDays: values.webhookRetentionDays,
          costLogRetentionDays: values.costLogRetentionDays,
          auditLogRetentionDays: values.auditLogRetentionDays,
          defaultApprovalTimeoutMs: values.approvalTimeout,
          approvalDefaultAction: values.approvalDefaultAction,
          searchConfig,
          escalationConfig,
        },
      });
      reset(undefined, { keepValues: true });
      setSavedEmails([...escalationEmails]);
      setSavedAt(new Date());
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not save settings. Try again in a moment.'
      );
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(onSubmit as Parameters<typeof handleSubmit>[0])(e)}
      className="max-w-3xl space-y-6"
    >
      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* ── Safety ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Safety</CardTitle>
          <p className="text-muted-foreground text-xs">
            Guard modes for prompt injection detection and output filtering.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="inputGuardMode" className="flex items-center gap-1">
              Input guard mode
              <FieldHelp title="Prompt injection protection">
                Controls how suspected prompt injection in user messages is handled. Agents can
                override this in their own config.
              </FieldHelp>
            </Label>
            <Controller
              name="inputGuardMode"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="inputGuardMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (disabled)</SelectItem>
                    <SelectItem value="log_only">Log only</SelectItem>
                    <SelectItem value="warn_and_continue">Warn and continue</SelectItem>
                    <SelectItem value="block">Block</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="outputGuardMode" className="flex items-center gap-1">
              Output guard mode
              <FieldHelp title="Output filtering">
                Controls how the system handles agent responses that violate topic boundaries or
                contain PII. Agents can override this in their own config.
              </FieldHelp>
            </Label>
            <Controller
              name="outputGuardMode"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="outputGuardMode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (disabled)</SelectItem>
                    <SelectItem value="log_only">Log only</SelectItem>
                    <SelectItem value="warn_and_continue">Warn and continue</SelectItem>
                    <SelectItem value="block">Block</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Limits ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Limits</CardTitle>
          <p className="text-muted-foreground text-xs">
            Spending caps and conversation limits across all agents.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="globalMonthlyBudgetUsd" className="flex items-center gap-1">
              Monthly budget (USD)
              <FieldHelp title="Platform-wide spend cap">
                Hard spending cap across all agents combined. When month-to-date spend reaches this
                limit, all new chats are rejected. Leave blank for no global cap. Resets on the 1st
                of each month (UTC).
              </FieldHelp>
            </Label>
            <Input
              id="globalMonthlyBudgetUsd"
              type="number"
              step="0.01"
              min={0}
              placeholder="No cap"
              {...register('globalMonthlyBudgetUsd')}
            />
            {errors.globalMonthlyBudgetUsd && (
              <p className="text-xs text-red-600">{errors.globalMonthlyBudgetUsd.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maxConversationsPerUser" className="flex items-center gap-1">
              Max conversations / user
              <FieldHelp title="Per-user conversation limit">
                Maximum number of active conversations a single user can have with any one agent.
                Prevents runaway usage. Leave blank for unlimited.
              </FieldHelp>
            </Label>
            <Input
              id="maxConversationsPerUser"
              type="number"
              min={1}
              placeholder="Unlimited"
              {...register('maxConversationsPerUser')}
            />
            {errors.maxConversationsPerUser && (
              <p className="text-xs text-red-600">{errors.maxConversationsPerUser.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="maxMessagesPerConversation" className="flex items-center gap-1">
              Max messages / conversation
              <FieldHelp title="Per-conversation message limit">
                Maximum number of messages in a single conversation before it is closed. Prevents
                unbounded token usage. Leave blank for unlimited.
              </FieldHelp>
            </Label>
            <Input
              id="maxMessagesPerConversation"
              type="number"
              min={1}
              placeholder="Unlimited"
              {...register('maxMessagesPerConversation')}
            />
            {errors.maxMessagesPerConversation && (
              <p className="text-xs text-red-600">{errors.maxMessagesPerConversation.message}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Retention ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Retention</CardTitle>
          <p className="text-muted-foreground text-xs">
            How long to keep operational logs before automatic cleanup.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="webhookRetentionDays" className="flex items-center gap-1">
              Webhook log retention (days)
              <FieldHelp title="Webhook delivery log cleanup">
                Webhook delivery records older than this are automatically deleted. Leave blank to
                keep all records indefinitely.
              </FieldHelp>
            </Label>
            <Input
              id="webhookRetentionDays"
              type="number"
              min={1}
              max={365}
              placeholder="Keep indefinitely"
              {...register('webhookRetentionDays')}
            />
            {errors.webhookRetentionDays && (
              <p className="text-xs text-red-600">{errors.webhookRetentionDays.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="costLogRetentionDays" className="flex items-center gap-1">
              Cost log retention (days)
              <FieldHelp title="Cost log cleanup">
                Cost log entries older than this are automatically deleted. Leave blank to keep all
                records indefinitely. The cost dashboard aggregates are not affected.
              </FieldHelp>
            </Label>
            <Input
              id="costLogRetentionDays"
              type="number"
              min={1}
              max={365}
              placeholder="Keep indefinitely"
              {...register('costLogRetentionDays')}
            />
            {errors.costLogRetentionDays && (
              <p className="text-xs text-red-600">{errors.costLogRetentionDays.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="auditLogRetentionDays" className="flex items-center gap-1">
              Audit log retention (days)
              <FieldHelp title="Admin audit log cleanup">
                Admin audit log entries older than this are automatically deleted. Leave blank to
                keep all records indefinitely. Compliance regimes often require 1–7 years — the max
                is 3650 days (10 years).
              </FieldHelp>
            </Label>
            <Input
              id="auditLogRetentionDays"
              type="number"
              min={1}
              max={3650}
              placeholder="Keep indefinitely"
              {...register('auditLogRetentionDays')}
            />
            {errors.auditLogRetentionDays && (
              <p className="text-xs text-red-600">{errors.auditLogRetentionDays.message}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Approvals ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Approvals</CardTitle>
          <p className="text-muted-foreground text-xs">
            Defaults for human-in-the-loop approval gates.
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="approvalTimeout" className="flex items-center gap-1">
              Approval timeout (ms)
              <FieldHelp title="Human-in-the-loop timeout">
                How long to wait for approval on sensitive operations before applying the default
                action. Leave blank for the system default (5 minutes).
              </FieldHelp>
            </Label>
            <Input
              id="approvalTimeout"
              type="number"
              min={1}
              placeholder="300000 (5 minutes)"
              {...register('approvalTimeout')}
            />
            {errors.approvalTimeout && (
              <p className="text-xs text-red-600">{errors.approvalTimeout.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="approvalDefaultAction" className="flex items-center gap-1">
              Default action on timeout
              <FieldHelp title="Timeout fallback action">
                When a human-in-the-loop approval request times out, this action is taken
                automatically. &ldquo;Deny&rdquo; is safer; &ldquo;Allow&rdquo; keeps workflows
                moving.
              </FieldHelp>
            </Label>
            <Controller
              name="approvalDefaultAction"
              control={control}
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="approvalDefaultAction">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deny">Deny</SelectItem>
                    <SelectItem value="allow">Allow</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Escalation ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Escalation Routing</CardTitle>
          <p className="text-muted-foreground text-xs">
            Notify humans when agents escalate conversations.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Controller
              name="escalationEnabled"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Enable escalation notifications
                  <FieldHelp title="Escalation notifications">
                    When enabled, the system sends email (and optional webhook) notifications when
                    an agent escalates a conversation to a human.
                  </FieldHelp>
                </label>
              )}
            />
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1">
                Notification emails
                <FieldHelp title="Escalation recipients">
                  Email addresses that receive escalation notifications. Add at least one to enable
                  email alerts.
                </FieldHelp>
              </Label>
              <div className="flex gap-2">
                <Input
                  type="email"
                  placeholder="Add email address…"
                  value={emailInput}
                  onChange={(e) => {
                    setEmailInput(e.target.value);
                    if (emailError) setEmailError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addEscalationEmail();
                    }
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={addEscalationEmail}>
                  <Plus className="mr-1 h-3 w-3" />
                  Add
                </Button>
              </div>
              {emailError && <p className="text-xs text-red-600">{emailError}</p>}
              {escalationEmails.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {escalationEmails.map((email) => (
                    <span
                      key={email}
                      className="bg-muted inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs"
                    >
                      {email}
                      <button
                        type="button"
                        onClick={() =>
                          setEscalationEmails((prev) => prev.filter((e) => e !== email))
                        }
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="escalationPriorityFilter" className="flex items-center gap-1">
                  Notify on priority
                  <FieldHelp title="Priority filter">
                    Which escalation priorities trigger a notification. &ldquo;All&rdquo; sends for
                    every escalation; &ldquo;Medium+&rdquo; skips low-priority; &ldquo;High
                    only&rdquo; only notifies for high-priority.
                  </FieldHelp>
                </Label>
                <Controller
                  name="escalationPriorityFilter"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="escalationPriorityFilter">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All priorities</SelectItem>
                        <SelectItem value="medium_and_above">Medium and above</SelectItem>
                        <SelectItem value="high">High only</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="escalationWebhookUrl" className="flex items-center gap-1">
                  Webhook URL (optional)
                  <FieldHelp title="Escalation webhook">
                    An additional HTTP endpoint to POST escalation payloads to. Useful for Slack,
                    PagerDuty, or custom integrations. This is separate from the webhook
                    subscription system.
                  </FieldHelp>
                </Label>
                <Input
                  id="escalationWebhookUrl"
                  type="url"
                  placeholder="https://…"
                  {...register('escalationWebhookUrl')}
                />
                {errors.escalationWebhookUrl && (
                  <p className="text-xs text-red-600">{errors.escalationWebhookUrl.message}</p>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Search ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Knowledge search</CardTitle>
          <p className="text-muted-foreground text-xs">
            The knowledge base supports two ranking modes. <strong>Vector-only</strong> (default)
            ranks chunks by semantic similarity — great for paraphrased questions, weak on exact
            terminology. <strong>Hybrid</strong> blends a keyword (BM25-flavoured) score with vector
            similarity, surfacing exact-term matches like &ldquo;Section 21 notice&rdquo; or
            &ldquo;ELM Countryside Stewardship&rdquo; that vector alone often misses. Switch modes
            below; only the relevant weights apply.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Hybrid toggle */}
          <div className="flex items-center gap-2">
            <Controller
              name="hybridEnabled"
              control={control}
              render={({ field }) => (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={(e) => field.onChange(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  Enable hybrid search (BM25 + vector)
                  <FieldHelp title="Enable hybrid search (BM25 + vector)">
                    When on, results are ranked by{' '}
                    <code>vectorWeight × vector_score + bm25Weight × keyword_score</code>, where{' '}
                    <code>keyword_score</code> is PostgreSQL&apos;s <code>ts_rank_cd</code> (a
                    BM25-flavoured ranker) over an indexed tsvector of each chunk&apos;s content +
                    keywords. Use this for domain-specific terminology (legal, financial,
                    regulatory, medical). When off, the legacy vector-only ranking with the small
                    additive keyword boost is used. Default: off — turn on after seeding your
                    knowledge base if exact-term recall matters.
                  </FieldHelp>
                </label>
              )}
            />
          </div>

          {/* Weight inputs grid */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="vectorWeight" className="flex items-center gap-1">
                Vector weight
                <FieldHelp title="Vector similarity weight">
                  Multiplier on the vector similarity score. <strong>In vector-only mode</strong>,
                  scales the cosine-similarity term. <strong>In hybrid mode</strong>, the weight on
                  the vector half of the blend formula. Range: 0.1 to 2.0. Default 1.0. Lower this
                  in hybrid mode if you want keyword matches to dominate.
                </FieldHelp>
              </Label>
              <Input
                id="vectorWeight"
                type="number"
                step="0.1"
                min={0.1}
                max={2.0}
                placeholder="Default"
                {...register('vectorWeight')}
              />
              {errors.vectorWeight && (
                <p className="text-xs text-red-600">{errors.vectorWeight.message}</p>
              )}
            </div>

            <div className={`space-y-1.5 ${watchedHybrid ? '' : 'opacity-60'}`}>
              <Label htmlFor="bm25Weight" className="flex items-center gap-1">
                BM25 weight
                <FieldHelp title="BM25 weight (hybrid mode only)">
                  Multiplier on the keyword score in the hybrid blend formula. Higher = more weight
                  on exact-term matches; lower = more weight on semantic similarity. Range: 0.1 to
                  2.0. Start at <strong>1.0</strong> (equal weighting with vectorWeight); increase
                  toward 1.5–2.0 if exact terminology is being missed; decrease toward 0.3–0.5 if
                  keyword matches are crowding out semantically better answers. Ignored when hybrid
                  is off.
                </FieldHelp>
              </Label>
              <Input
                id="bm25Weight"
                type="number"
                step="0.1"
                min={0.1}
                max={2.0}
                placeholder="Default (1.0)"
                disabled={!watchedHybrid}
                {...register('bm25Weight')}
              />
              {errors.bm25Weight && (
                <p className="text-xs text-red-600">{errors.bm25Weight.message}</p>
              )}
              {!watchedHybrid && (
                <p className="text-muted-foreground text-xs">Active only when hybrid is enabled.</p>
              )}
            </div>

            <div className={`space-y-1.5 sm:col-span-2 ${watchedHybrid ? 'opacity-60' : ''}`}>
              <Label htmlFor="keywordBoostWeight" className="flex items-center gap-1">
                Keyword boost weight
                <FieldHelp title="Keyword boost weight (vector-only mode)">
                  Used <strong>only when hybrid mode is off</strong>. A small non-positive offset
                  that nudges keyword-matched chunks ahead in the vector-only ranking — a flat
                  tiebreaker, not a real BM25 score. More negative = stronger nudge. Range: -0.2 to
                  0. Ignored when hybrid is on (use BM25 weight there instead).
                </FieldHelp>
              </Label>
              <Input
                id="keywordBoostWeight"
                type="number"
                step="0.01"
                min={-0.2}
                max={0}
                placeholder="Default"
                disabled={watchedHybrid}
                {...register('keywordBoostWeight')}
              />
              {errors.keywordBoostWeight && (
                <p className="text-xs text-red-600">{errors.keywordBoostWeight.message}</p>
              )}
              {watchedHybrid && (
                <p className="text-muted-foreground text-xs">
                  Inactive — hybrid mode is on; BM25 weight controls keyword influence.
                </p>
              )}
            </div>

            {searchPartialFill && (
              <p className="text-xs text-amber-600 sm:col-span-2">
                Both keyword and vector weights must be set together. If only one is provided,
                search config will reset to built-in defaults on save.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Submit ─────────────────────────────────────────────────────── */}
      <div className="sticky bottom-4 flex items-center gap-3">
        <Button type="submit" disabled={isSubmitting || !hasChanges}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving…
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Save settings
            </>
          )}
        </Button>
        {savedAt && !hasChanges && (
          <span className="text-muted-foreground flex items-center gap-1 text-sm">
            <Check className="h-4 w-4 text-emerald-500" />
            Saved
          </span>
        )}
      </div>
    </form>
  );
}
