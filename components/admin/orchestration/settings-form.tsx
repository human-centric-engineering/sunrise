'use client';

/**
 * OrchestrationSettingsForm
 *
 * Form for global orchestration settings: input guard mode,
 * global monthly budget, and approval defaults.
 */

import { useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
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

export interface OrchestrationSettings {
  inputGuardMode: string | null;
  globalMonthlyBudgetUsd: number | null;
  defaultApprovalTimeoutMs: number | null;
  approvalDefaultAction: string | null;
}

export interface SettingsFormProps {
  initialSettings: OrchestrationSettings;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function SettingsForm({ initialSettings }: SettingsFormProps) {
  const [inputGuardMode, setInputGuardMode] = useState(
    initialSettings.inputGuardMode ?? 'log_only'
  );
  const [globalBudget, setGlobalBudget] = useState(
    initialSettings.globalMonthlyBudgetUsd?.toString() ?? ''
  );
  const [approvalTimeout, setApprovalTimeout] = useState(
    initialSettings.defaultApprovalTimeoutMs?.toString() ?? ''
  );
  const [approvalAction, setApprovalAction] = useState(
    initialSettings.approvalDefaultAction ?? 'deny'
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.SETTINGS, {
        body: {
          inputGuardMode: inputGuardMode === 'none' ? null : inputGuardMode,
          globalMonthlyBudgetUsd: globalBudget ? Number(globalBudget) : null,
          defaultApprovalTimeoutMs: approvalTimeout ? Number(approvalTimeout) : null,
          approvalDefaultAction: approvalAction,
        },
      });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'Could not save settings. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="max-w-2xl space-y-6">
      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm text-green-600 dark:bg-green-950/20 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Settings saved successfully.
        </div>
      )}

      {/* Input guard mode */}
      <div className="grid gap-2">
        <Label htmlFor="inputGuardMode">
          Default input guard mode{' '}
          <FieldHelp title="Global prompt injection protection">
            The default guard mode applied to all agents that don&apos;t override it. Controls how
            suspected prompt injection in user messages is handled.
          </FieldHelp>
        </Label>
        <Select value={inputGuardMode} onValueChange={setInputGuardMode}>
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
      </div>

      {/* Global monthly budget */}
      <div className="grid gap-2">
        <Label htmlFor="globalBudget">
          Global monthly budget (USD){' '}
          <FieldHelp title="Platform-wide spend cap">
            Hard spending cap across all agents combined. When month-to-date spend reaches this
            limit, all new chats are rejected. Leave blank for no global cap.
          </FieldHelp>
        </Label>
        <Input
          id="globalBudget"
          type="number"
          step="0.01"
          value={globalBudget}
          onChange={(e) => setGlobalBudget(e.target.value)}
          placeholder="No global cap"
        />
      </div>

      {/* Approval timeout */}
      <div className="grid gap-2">
        <Label htmlFor="approvalTimeout">
          Approval timeout (ms){' '}
          <FieldHelp title="Human-in-the-loop timeout">
            How long to wait for approval on sensitive operations before applying the default
            action. Leave blank for the system default (5 minutes).
          </FieldHelp>
        </Label>
        <Input
          id="approvalTimeout"
          type="number"
          value={approvalTimeout}
          onChange={(e) => setApprovalTimeout(e.target.value)}
          placeholder="300000 (5 minutes)"
        />
      </div>

      {/* Approval default action */}
      <div className="grid gap-2">
        <Label htmlFor="approvalAction">
          Approval default action{' '}
          <FieldHelp title="What happens when approval times out">
            When a human-in-the-loop approval request times out, this action is taken automatically.
          </FieldHelp>
        </Label>
        <Select value={approvalAction} onValueChange={setApprovalAction}>
          <SelectTrigger id="approvalAction">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deny">Deny</SelectItem>
            <SelectItem value="allow">Allow</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button type="submit" disabled={submitting}>
        {submitting ? (
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
    </form>
  );
}
