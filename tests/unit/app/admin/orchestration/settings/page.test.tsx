import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

const defaults = {
  inputGuardMode: null,
  outputGuardMode: null,
  citationGuardMode: null,
  globalMonthlyBudgetUsd: null,
  defaultApprovalTimeoutMs: null,
  approvalDefaultAction: null,
  searchConfig: null,
  webhookRetentionDays: null,
  costLogRetentionDays: null,
  auditLogRetentionDays: null,
  maxConversationsPerUser: null,
  maxMessagesPerConversation: null,
  escalationConfig: null,
};

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
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    await OrchestrationSettingsPage();

    expect(serverFetch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.SETTINGS);
  });

  // 3. Happy path: passes fetched settings object to SettingsForm
  it('passes fetched settings to SettingsForm when res.ok and body.success', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: mockSettings,
    } as never);

    render(await OrchestrationSettingsPage());

    const form = screen.getByTestId('settings-form');
    expect(form).toHaveAttribute('data-settings', JSON.stringify(mockSettings));
  });

  // 4. res.ok === false: passes defaults to SettingsForm
  it('passes defaults to SettingsForm when res.ok is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await OrchestrationSettingsPage());

    const form = screen.getByTestId('settings-form');
    expect(form).toHaveAttribute('data-settings', JSON.stringify(defaults));
  });

  // 5. body.success === false: passes defaults to SettingsForm
  it('passes defaults to SettingsForm when body.success is false', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    } as never);

    render(await OrchestrationSettingsPage());

    const form = screen.getByTestId('settings-form');
    expect(form).toHaveAttribute('data-settings', JSON.stringify(defaults));
  });

  // 6. serverFetch throws: logger.error called for ALL four helpers and
  // defaults passed to SettingsForm. Each helper has its own try/catch
  // with a distinct message — toHaveBeenCalledWith is a partial check,
  // so a regression that broke any one of the chat/providers/embeddings
  // error branches would have been invisible without this coverage.
  it('calls logger.error for each of the four helpers and passes defaults when serverFetch throws', async () => {
    const fetchError = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchError);

    render(await OrchestrationSettingsPage());

    const form = screen.getByTestId('settings-form');
    expect(form).toHaveAttribute('data-settings', JSON.stringify(defaults));
    expect(logger.error).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalledWith('settings page: fetch failed', fetchError);
    expect(logger.error).toHaveBeenCalledWith(
      'settings page: chat models fetch failed',
      fetchError
    );
    expect(logger.error).toHaveBeenCalledWith('settings page: providers fetch failed', fetchError);
    expect(logger.error).toHaveBeenCalledWith(
      'settings page: embedding models fetch failed',
      fetchError
    );
  });

  // 6b. Happy path covering ALL four parallel serverFetch calls — proves
  // each helper's data lands on the corresponding DefaultModelsForm prop
  // (chat models, providers, embedding models). The original happy-path
  // test only verified settings; the other three helpers always
  // returned empty arrays in tests because their fetches resolved to
  // `{ ok: false }` from the global mock.
  it('passes chat models, providers, and embedding models through to DefaultModelsForm', async () => {
    // Cover every matrixTierToModelTier branch by including one row
    // per tierRole the source maps. Without this the switch arms for
    // worker / infrastructure / control_plane / local_sovereign /
    // default stay uncovered.
    const chatRows = [
      {
        modelId: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerSlug: 'anthropic',
        tierRole: 'thinking',
      },
      {
        modelId: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        providerSlug: 'anthropic',
        tierRole: 'worker',
      },
      {
        modelId: 'embed-mini',
        name: 'Embed Mini',
        providerSlug: 'anthropic',
        tierRole: 'infrastructure',
      },
      {
        modelId: 'control-plane-bot',
        name: 'Control Plane Bot',
        providerSlug: 'anthropic',
        tierRole: 'control_plane',
      },
      {
        modelId: 'ollama-llama',
        name: 'Local Llama',
        providerSlug: 'ollama',
        tierRole: 'local_sovereign',
      },
      {
        modelId: 'unknown-tier',
        name: 'Unknown Tier',
        providerSlug: 'anthropic',
        tierRole: 'something-new',
      },
    ];
    const providers = [{ slug: 'anthropic', name: 'Anthropic', isActive: true }];
    const embeddingModels = [
      { id: 'voyage-3', name: 'Voyage 3', provider: 'voyage', model: 'voyage-3' },
    ];

    // serverFetch returns a tagged response so parseApiResponse can
    // dispatch on the original URL — Promise.all() does not guarantee
    // call ordering, so dispatching by URL is more robust than relying
    // on mockResolvedValueOnce sequencing.
    vi.mocked(serverFetch).mockImplementation(((url: string) =>
      Promise.resolve({ ok: true, _testUrl: url } as unknown as Response)) as never);
    vi.mocked(parseApiResponse).mockImplementation(((res: Response & { _testUrl?: string }) => {
      const url = res._testUrl ?? '';
      if (url.includes(API.ADMIN.ORCHESTRATION.SETTINGS)) {
        return Promise.resolve({ success: true, data: mockSettings });
      }
      if (url.includes(API.ADMIN.ORCHESTRATION.PROVIDER_MODELS)) {
        return Promise.resolve({ success: true, data: chatRows });
      }
      if (url.includes(API.ADMIN.ORCHESTRATION.PROVIDERS)) {
        return Promise.resolve({ success: true, data: providers });
      }
      if (url.includes(API.ADMIN.ORCHESTRATION.EMBEDDING_MODELS)) {
        return Promise.resolve({ success: true, data: embeddingModels });
      }
      return Promise.resolve({ success: false });
    }) as never);

    render(await OrchestrationSettingsPage());

    const form = screen.getByTestId('default-models-form');
    // Chat rows are reshaped to ModelInfo by the source — assert the
    // shape the form actually receives, not the raw matrix row.
    const passedModels = JSON.parse(form.getAttribute('data-models') ?? '[]');
    expect(passedModels).toHaveLength(6);
    // matrixTierToModelTier maps:
    //   thinking → frontier, worker → mid,
    //   infrastructure / control_plane → budget,
    //   local_sovereign → local, default → mid.
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
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await OrchestrationSettingsPage());

    const link = screen.getByRole('link', { name: /AI Orchestration/i });
    expect(link).toHaveAttribute('href', '/admin/orchestration');
  });

  // 8. Renders h1 containing "Settings"
  it('renders h1 heading containing "Settings"', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await OrchestrationSettingsPage());

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Settings');
  });

  // 9. Renders subtitle paragraph with exact copy
  it('renders the subtitle paragraph with exact copy', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await OrchestrationSettingsPage());

    expect(
      screen.getByText(
        'Default models, guard modes, spending caps, usage limits, retention, approvals, and search tuning.'
      )
    ).toBeInTheDocument();
  });

  // 10. Renders BackupPanel
  it('renders BackupPanel', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await OrchestrationSettingsPage());

    expect(screen.getByTestId('backup-panel')).toBeInTheDocument();
  });
});
