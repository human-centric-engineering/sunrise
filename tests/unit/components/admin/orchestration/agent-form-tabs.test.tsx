/**
 * AgentForm — Capabilities and Test Tabs Accessibility Tests
 *
 * Test Coverage:
 * - Capabilities and Test tabs are disabled in create mode
 * - Both tabs are enabled in edit mode
 *
 * @see components/admin/orchestration/agent-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { AgentForm } from '@/components/admin/orchestration/agent-form';
import type { AiAgent, AiProviderConfig } from '@/types/prisma';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_PROVIDERS: AiProviderConfig[] = [
  {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    isActive: true,
    isLocal: false,
    createdBy: 'system',
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    metadata: {},
  } as AiProviderConfig,
];

const MOCK_MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

function makeAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'agent-edit-id',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    systemInstructions: 'You are a test assistant.',
    provider: 'anthropic',
    providerConfig: null,
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    createdBy: 'system',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    systemInstructionsHistory: [],
    metadata: {},
    ...overrides,
  } as AiAgent;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentForm — Capabilities and Test tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('create mode', () => {
    it('Capabilities tab has disabled attribute in create mode', () => {
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      const capTab = screen.getByRole('tab', { name: /capabilities/i });
      // shadcn/ui Tabs uses data-disabled attribute when disabled prop is true
      expect(capTab).toHaveAttribute('data-disabled');
    });

    it('Test tab has disabled attribute in create mode', () => {
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      const testTab = screen.getByRole('tab', { name: /^test$/i });
      expect(testTab).toHaveAttribute('data-disabled');
    });

    it('Embed tab has disabled attribute in create mode', () => {
      render(<AgentForm mode="create" providers={MOCK_PROVIDERS} models={MOCK_MODELS} />);

      const embedTab = screen.getByRole('tab', { name: /^embed$/i });
      expect(embedTab).toHaveAttribute('data-disabled');
    });
  });

  describe('edit mode', () => {
    it('Capabilities tab is enabled in edit mode', async () => {
      const agent = makeAgent();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      await waitFor(() => {
        const capTab = screen.getByRole('tab', { name: /capabilities/i });
        expect(capTab).not.toHaveAttribute('data-disabled');
      });
    });

    it('Test tab is enabled in edit mode', async () => {
      const agent = makeAgent();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      await waitFor(() => {
        const testTab = screen.getByRole('tab', { name: /^test$/i });
        expect(testTab).not.toHaveAttribute('data-disabled');
      });
    });

    it('Embed tab is enabled in edit mode', async () => {
      const agent = makeAgent();
      render(
        <AgentForm mode="edit" agent={agent} providers={MOCK_PROVIDERS} models={MOCK_MODELS} />
      );

      await waitFor(() => {
        const embedTab = screen.getByRole('tab', { name: /^embed$/i });
        expect(embedTab).not.toHaveAttribute('data-disabled');
      });
    });
  });
});
