import type { Metadata } from 'next';
import Link from 'next/link';

import {
  SettingsForm,
  type OrchestrationSettings,
} from '@/components/admin/orchestration/settings-form';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Settings · AI Orchestration',
  description:
    'Global orchestration settings — guard modes, budget, limits, retention, approvals, and search.',
};

async function getSettings(): Promise<OrchestrationSettings> {
  const defaults: OrchestrationSettings = {
    inputGuardMode: null,
    outputGuardMode: null,
    globalMonthlyBudgetUsd: null,
    defaultApprovalTimeoutMs: null,
    approvalDefaultAction: null,
    searchConfig: null,
    webhookRetentionDays: null,
    costLogRetentionDays: null,
    maxConversationsPerUser: null,
    maxMessagesPerConversation: null,
  };
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.SETTINGS);
    if (!res.ok) return defaults;
    const body = await parseApiResponse<OrchestrationSettings>(res);
    return body.success ? body.data : defaults;
  } catch (err) {
    logger.error('settings page: fetch failed', err);
    return defaults;
  }
}

export default async function OrchestrationSettingsPage() {
  const settings = await getSettings();

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Settings</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Settings{' '}
          <FieldHelp title="Global orchestration settings" contentClassName="w-96">
            <p>
              These settings apply platform-wide. Individual agents can override some of these (like
              guard mode) in their own configuration.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Global defaults for guard modes, spending caps, usage limits, retention, approvals, and
          search tuning.
        </p>
      </header>

      <SettingsForm initialSettings={settings} />
    </div>
  );
}
