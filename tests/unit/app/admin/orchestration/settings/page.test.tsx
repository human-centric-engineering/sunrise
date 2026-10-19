// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/settings-form', () => ({
  SettingsForm: ({ initialSettings }: { initialSettings: unknown }) => (
    <div data-testid="settings-form" data-settings={JSON.stringify(initialSettings)} />
  ),
}));

vi.mock('@/components/admin/orchestration/default-models-form', () => ({
  DefaultModelsForm: (props: {
    settings: unknown;
    models: unknown;
    providers: unknown;
    embeddingModels: unknown;
  }) => (
    <div
      data-testid="default-models-form"
      data-models={JSON.stringify(props.models)}
      data-providers={JSON.stringify(props.providers)}
      data-embeddings={JSON.stringify(props.embeddingModels)}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/settings/backup-panel', () => ({
  BackupPanel: () => <div data-testid="backup-panel" />,
}));

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import React from 'react';
import OrchestrationSettingsPage, { metadata } from '@/app/admin/orchestration/settings/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const mockSettings = {
  inputGuardMode: 'strict',
  outputGuardMode: 'moderate',
  globalMonthlyBudgetUsd: 500,
  defaultApprovalTimeoutMs: 30000,
  approvalDefaultAction: 'reject',
  searchConfig: { provider: 'pinecone' },
  webhookRetentionDays: 90,
  costLogRetentionDays: 365,
  auditLogRetentionDays: 730,
  maxConversationsPerUser: 100,
  maxMessagesPerConversation: 500,
  escalationConfig: null,
};

type Source = 'settings' | 'chat' | 'audio' | 'embeddingMatrix' | 'providers' | 'embeddingModels';

function sourceOf(url: string): Source {
  if (url.startsWith(API.ADMIN.ORCHESTRATION.SETTINGS)) return 'settings';
  if (url.startsWith(API.ADMIN.ORCHESTRATION.PROVIDER_MODELS)) {
    if (url.includes('capability=chat')) return 'chat';
    if (url.includes('capability=audio')) return 'audio';
    return 'embeddingMatrix';
  }
  if (url.startsWith(API.ADMIN.ORCHESTRATION.PROVIDERS)) return 'providers';
  return 'embeddingModels';
}

/**
 * Route the page's six parallel fetches by URL. Every source answers with
 * its body in `bodies` (default: settings → mockSettings, lists → []); a
 * `Response` or `Error` replaces the answer (an Error makes serverFetch reject).
 */
function answer(bodies: Partial<Record<Source, unknown>> = {}) {
  vi.mocked(serverFetch).mockImplementation(async (url: string) => {
    const source = sourceOf(url);
    const given = source in bodies ? bodies[source] : source === 'settings' ? mockSettings : [];
    if (given instanceof Error) throw given;
    if (given instanceof Response) return given;
    return apiSuccess(given);
  });
}

describe('OrchestrationSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. Metadata
  it('has correct title and description metadata', () => {
    expect(metadata.title).toBe('Settings · AI Orchestration');
    expect(metadata.description).toBe(
      'Global orchestration settings — default models, guard modes, budget, limits, retention, approvals, and search.'
    );
  });

  // 2. serverFetch called with correct endpoint
  it('calls serverFetch with the orchestration settings endpoint', async () => {
    answer();

    await OrchestrationSettingsPage();

    expect(vi.mocked(serverFetch).mock.calls.map((call) => call[0])).toContain(
      API.ADMIN.ORCHESTRATION.SETTINGS
    );
  });

  // 3. Happy path: passes fetched settings object to SettingsForm
  it('passes fetched settings to SettingsForm when the load succeeds', async () => {
    answer();

    render(await OrchestrationSettingsPage());

    const form = screen.getByTestId('settings-form');
    expect(form).toHaveAttribute('data-settings', JSON.stringify(mockSettings));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // 4–6. A failed settings load must never pre-fill the forms with defaults
  // an admin could then save over the real settings (#518): it throws to the
  // error boundary instead.
  it.each([
    ['answers 500', () => apiFailure(500)],
    ['answers success:false', () => apiFailure(200)],
    ['rejects', () => new Error('Network failure')],
  ])('throws to the error boundary when the settings load %s', async (_label, failure) => {
    answer({ settings: failure() });

    await expect(OrchestrationSettingsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it.each([
    ['chat models', 'chat'],
    ['providers', 'providers'],
    ['embedding models', 'embeddingModels'],
    ['audio models', 'audio'],
  ] as const)(
    'shows a notice in place of the default-models form when the %s load fails',
    async (_label, source) => {
      answer({ [source]: apiFailure(500) });

      render(await OrchestrationSettingsPage());

      expect(screen.getByRole('alert')).toHaveTextContent(
        "Couldn't load the default model options"
      );
      expect(screen.queryByTestId('default-models-form')).not.toBeInTheDocument();
      // The settings form still renders with the real settings.
      expect(screen.getByTestId('settings-form')).toHaveAttribute(
        'data-settings',
        JSON.stringify(mockSettings)
      );
      expect(logger.error).toHaveBeenCalled();
    }
  );

  it('shows a notice in place of the active embedding model form when its options fail', async () => {
    answer({ embeddingMatrix: apiFailure(500) });

    render(await OrchestrationSettingsPage());

    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't load the embedding model options"
    );
    expect(screen.getByTestId('default-models-form')).toBeInTheDocument();
  });

  it('renders the forms with real empty option lists, with no notice', async () => {
    answer();

    render(await OrchestrationSettingsPage());

    const form = screen.getByTestId('default-models-form');
    expect(form).toHaveAttribute('data-models', '[]');
    expect(form).toHaveAttribute('data-providers', '[]');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // 6b. Happy path covering ALL four parallel serverFetch calls — proves
  // each helper's data lands on the corresponding DefaultModelsForm prop
  // (chat models, providers, embedding models), not just the settings.
  it('passes chat models, providers, and embedding models through to DefaultModelsForm', async () => {
    // Cover every matrixTierToModelTier branch by including one row
    // per tierRole + deploymentProfile combination the source maps.
    // Without this the switch arms for worker / infrastructure /
    // control_plane / sovereign-override / default stay uncovered.
    const chatRows = [
      {
        modelId: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerSlug: 'anthropic',
        tierRole: 'thinking',
        deploymentProfiles: ['hosted'],
      },
      {
        modelId: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        providerSlug: 'anthropic',
        tierRole: 'worker',
        deploymentProfiles: ['hosted'],
      },
      {
        modelId: 'embed-mini',
        name: 'Embed Mini',
        providerSlug: 'anthropic',
        tierRole: 'infrastructure',
        deploymentProfiles: ['hosted'],
      },
      {
        modelId: 'control-plane-bot',
        name: 'Control Plane Bot',
        providerSlug: 'anthropic',
        tierRole: 'control_plane',
        deploymentProfiles: ['hosted'],
      },
      {
        modelId: 'ollama-llama',
        name: 'Local Llama',
        providerSlug: 'ollama',
        tierRole: 'worker',
        deploymentProfiles: ['sovereign'],
      },
      {
        modelId: 'unknown-tier',
        name: 'Unknown Tier',
        providerSlug: 'anthropic',
        tierRole: 'something-new',
        deploymentProfiles: ['hosted'],
      },
    ];
    const providers = [{ slug: 'anthropic', name: 'Anthropic', isActive: true }];
    const embeddingModels = [
      { id: 'voyage-3', name: 'Voyage 3', provider: 'voyage', model: 'voyage-3' },
    ];

    // Promise.all() does not guarantee call ordering, so answers are
    // dispatched by URL rather than by mockResolvedValueOnce sequencing.
    answer({ chat: chatRows, providers, embeddingModels });

    render(await OrchestrationSettingsPage());

    const form = screen.getByTestId('default-models-form');
    // Chat rows are reshaped to ModelInfo by the source — assert the
    // shape the form actually receives, not the raw matrix row.
    const passedModels = JSON.parse(form.getAttribute('data-models') ?? '[]');
    expect(passedModels).toHaveLength(6);
    // matrixTierToModelTier maps:
    //   thinking → frontier, worker → mid,
    //   infrastructure / control_plane → budget,
    //   deploymentProfiles ⊇ sovereign → local (overrides tier),
    //   default tier → mid.
    const tierByModelId = Object.fromEntries(
      passedModels.map((m: { id: string; tier: string }) => [m.id, m.tier])
    );
    expect(tierByModelId).toMatchObject({
      'claude-sonnet-4-6': 'frontier',
      'claude-haiku-4-5': 'mid',
      'embed-mini': 'budget',
      'control-plane-bot': 'budget',
      'ollama-llama': 'local',
      'unknown-tier': 'mid', // default arm
    });
    expect(JSON.parse(form.getAttribute('data-providers') ?? '[]')).toEqual(providers);
    expect(JSON.parse(form.getAttribute('data-embeddings') ?? '[]')).toEqual(embeddingModels);
  });

  // 7. Renders breadcrumb link to /admin/orchestration
  it('renders breadcrumb link to /admin/orchestration', async () => {
    answer();

    render(await OrchestrationSettingsPage());

    const link = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });

  // 8. Renders h1 containing "Settings"
  it('renders h1 heading containing "Settings"', async () => {
    answer();

    render(await OrchestrationSettingsPage());

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Settings');
  });

  // 9. Renders subtitle paragraph with exact copy
  it('renders the subtitle paragraph with exact copy', async () => {
    answer();

    render(await OrchestrationSettingsPage());

    expect(
      screen.getByText(
        'Default models, guard modes, spending caps, usage limits, retention, approvals, and search tuning.'
      )
    ).toBeInTheDocument();
  });

  // 10. Renders BackupPanel
  it('renders BackupPanel', async () => {
    answer();

    render(await OrchestrationSettingsPage());

    expect(screen.getByTestId('backup-panel')).toBeInTheDocument();
  });
});
