/**
 * Unit Tests: NewAgentPage
 *
 * Thin server shell — prefetches the curated provider matrix and
 * effective defaults, then hands them to <AgentForm mode="create">.
 * These tests pin the wiring contract: the right prefetch helpers are
 * called, their return values flow through to AgentForm, the
 * breadcrumb is rendered, and the page tolerates either fetch
 * returning null.
 *
 * @see app/admin/orchestration/agents/new/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/orchestration/prefetch-helpers', () => ({
  getProviders: vi.fn(),
  getAgentModels: vi.fn(),
  getEffectiveAgentDefaults: vi.fn(async () => ({
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    inheritedProvider: false,
    inheritedModel: false,
  })),
}));

// Stub AgentForm so the test can inspect props without booting the
// full form (which has its own dedicated tests).
vi.mock('@/components/admin/orchestration/agent-form', () => ({
  AgentForm: (props: {
    mode: string;
    providers: unknown;
    models: unknown;
    effectiveDefaults: unknown;
  }) => (
    <div
      data-testid="agent-form"
      data-mode={props.mode}
      data-providers={JSON.stringify(props.providers)}
      data-models={JSON.stringify(props.models)}
      data-defaults={JSON.stringify(props.effectiveDefaults)}
    />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import NewAgentPage, { metadata } from '@/app/admin/orchestration/agents/new/page';
import {
  getProviders,
  getAgentModels,
  getEffectiveAgentDefaults,
} from '@/lib/orchestration/prefetch-helpers';
import type { AiProviderConfig } from '@/types/prisma';
import type { ModelOption } from '@/lib/orchestration/prefetch-helpers';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewAgentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports a static metadata object with the page title', () => {
    expect(metadata.title).toBe('New agent · AI Orchestration');
    expect(metadata.description).toBe('Create a new AI agent.');
  });

  it('calls the three prefetch helpers and renders the breadcrumb plus AgentForm in create mode', async () => {
    const providers: (AiProviderConfig & { apiKeyPresent?: boolean })[] = [
      {
        id: 'p1',
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        isActive: true,
        baseUrl: null,
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
        timeoutMs: null,
        maxRetries: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        apiKeyPresent: true,
      } as unknown as AiProviderConfig & { apiKeyPresent?: boolean },
    ];
    const models: ModelOption[] = [
      { provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' },
    ];

    vi.mocked(getProviders).mockResolvedValue(providers);
    vi.mocked(getAgentModels).mockResolvedValue(models);
    vi.mocked(getEffectiveAgentDefaults).mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inheritedProvider: false,
      inheritedModel: false,
    });

    const ui = await NewAgentPage();
    render(ui);

    // All three prefetch helpers fired. getEffectiveAgentDefaults
    // receives an empty seed because create mode has no existing agent
    // overrides; the helper resolves the deployment-wide defaults.
    expect(getProviders).toHaveBeenCalledTimes(1);
    expect(getAgentModels).toHaveBeenCalledTimes(1);
    expect(getEffectiveAgentDefaults).toHaveBeenCalledWith({ provider: '', model: '' });

    // Breadcrumb renders the two intermediate links plus the "New" leaf.
    expect(screen.getByRole('link', { name: /^AI Orchestration$/ })).toHaveAttribute(
      'href',
      '/admin/orchestration'
    );
    expect(screen.getByRole('link', { name: /^Agents$/ })).toHaveAttribute(
      'href',
      '/admin/orchestration/agents'
    );
    expect(screen.getByText('New')).toBeInTheDocument();

    // AgentForm receives mode="create" and the prefetched data inline.
    const form = screen.getByTestId('agent-form');
    expect(form).toHaveAttribute('data-mode', 'create');
    expect(form.getAttribute('data-providers')).toContain('"anthropic"');
    expect(form.getAttribute('data-models')).toContain('claude-opus-4-6');
    expect(form.getAttribute('data-defaults')).toContain('"provider":"anthropic"');
  });

  it('passes null providers and models through when the prefetch helpers fail', async () => {
    // Both prefetch helpers are documented to return null on failure
    // so the form can render its free-text fallback with a warning
    // banner. The page must NOT crash or swallow the null — the form
    // needs to see it to switch into fallback mode.
    vi.mocked(getProviders).mockResolvedValue(null);
    vi.mocked(getAgentModels).mockResolvedValue(null);
    vi.mocked(getEffectiveAgentDefaults).mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inheritedProvider: false,
      inheritedModel: false,
    });

    const ui = await NewAgentPage();
    render(ui);

    const form = screen.getByTestId('agent-form');
    expect(form.getAttribute('data-providers')).toBe('null');
    expect(form.getAttribute('data-models')).toBe('null');
  });
});
