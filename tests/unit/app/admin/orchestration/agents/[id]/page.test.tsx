/**
 * Unit Tests: EditAgentPage
 *
 * Tests the admin "Edit Agent" server component page.
 *
 * Test Coverage:
 * - notFound() path — agent not found (res.ok false, body.success false, fetch throws)
 * - Happy path — agent found, renders breadcrumb and AgentForm with correct props
 * - serverFetch called with the correct agentById endpoint
 * - generateMetadata — title variants for found and missing agents
 * - Provider / model data flow — values passed through to AgentForm
 * - Provider / model failure tolerance — null values passed when prefetch fails
 *
 * @see app/admin/orchestration/agents/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/prefetch-helpers', () => ({
  getProviders: vi.fn(),
  getModels: vi.fn(),
}));

// Stub AgentForm so we can inspect its props without client-side complexity
vi.mock('@/components/admin/orchestration/agent-form', () => ({
  AgentForm: (props: {
    mode: string;
    agent?: { id: string; name: string };
    providers: unknown;
    models: unknown;
  }) => (
    <div
      data-testid="agent-form"
      data-mode={props.mode}
      data-agent-id={props.agent?.id}
      data-agent-name={props.agent?.name}
      data-providers={JSON.stringify(props.providers)}
      data-models={JSON.stringify(props.models)}
    />
  ),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import EditAgentPage, { generateMetadata } from '@/app/admin/orchestration/agents/[id]/page';
import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { notFound } from 'next/navigation';
import { getProviders, getModels } from '@/lib/orchestration/prefetch-helpers';
import { API } from '@/lib/api/endpoints';
import type { AiAgent, AiProviderConfig } from '@/types/prisma';
import type { ModelOption } from '@/lib/orchestration/prefetch-helpers';

// ─── Test Data ────────────────────────────────────────────────────────────────

function createMockAgent(overrides: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'agent-123',
    name: 'Support Bot',
    slug: 'support-bot',
    description: 'Handles customer support queries',
    systemInstructions: 'You are a helpful assistant.',
    systemInstructionsHistory: [],
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    fallbackProviders: [],
    providerConfig: null,
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    metadata: null,
    knowledgeCategories: [],
    topicBoundaries: [],
    brandVoiceInstructions: null,
    rateLimitRpm: null,
    inputGuardMode: null,
    outputGuardMode: null,
    maxHistoryTokens: null,
    retentionDays: null,
    visibility: 'internal',
    isActive: true,
    isSystem: false,
    createdBy: 'user-456',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-15'),
    ...overrides,
  } as AiAgent;
}

const mockProviders: AiProviderConfig[] = [
  {
    id: 'provider-1',
    name: 'Anthropic',
    slug: 'anthropic',
    providerType: 'anthropic',
    baseUrl: null,
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    isLocal: false,
    isActive: true,
    metadata: null,
    timeoutMs: null,
    maxRetries: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
];

const mockModels: ModelOption[] = [
  { provider: 'anthropic', id: 'claude-sonnet-4-6', tier: 'frontier' },
  { provider: 'anthropic', id: 'claude-haiku-3-5', tier: 'budget' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditAgentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: providers and models succeed
    vi.mocked(getProviders).mockResolvedValue(mockProviders);
    vi.mocked(getModels).mockResolvedValue(mockModels);
  });

  // ── notFound paths ─────────────────────────────────────────────────────────

  describe('notFound behavior', () => {
    it('calls notFound when res.ok is false', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act & Assert
      await expect(EditAgentPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard
    });

    it('calls notFound when body.success is false', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found' },
      } as never);
      const params = Promise.resolve({ id: 'agent-999' });

      // Act & Assert
      await expect(EditAgentPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard
    });

    it('calls notFound when serverFetch throws and logs the error', async () => {
      // Arrange
      const fetchError = new Error('Network failure');
      vi.mocked(serverFetch).mockRejectedValue(fetchError);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act & Assert
      await expect(EditAgentPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(notFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard
      expect(logger.error).toHaveBeenCalledWith('edit agent page: agent fetch failed', fetchError, {
        id: 'agent-123',
      });
    });
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  describe('serverFetch endpoint', () => {
    it('calls serverFetch with the correct agentById endpoint', async () => {
      // Arrange
      const agentId = 'agent-abc';
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: createMockAgent({ id: agentId }),
      } as never);
      const params = Promise.resolve({ id: agentId });

      // Act
      render(await EditAgentPage({ params }));

      // Assert: the correct URL was used to fetch the agent
      expect(serverFetch).toHaveBeenCalledWith(API.ADMIN.ORCHESTRATION.agentById(agentId));
    });
  });

  // ── Happy path — agent found ───────────────────────────────────────────────

  describe('happy path rendering', () => {
    it('renders AgentForm in edit mode with the fetched agent', async () => {
      // Arrange
      const agent = createMockAgent({ id: 'agent-123', name: 'Support Bot' });
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: agent } as never);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      render(await EditAgentPage({ params }));

      // Assert: AgentForm rendered in edit mode with the correct agent
      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-mode', 'edit');
      expect(form).toHaveAttribute('data-agent-id', 'agent-123');
      expect(form).toHaveAttribute('data-agent-name', 'Support Bot');
    });

    it('passes providers from getProviders to AgentForm', async () => {
      // Arrange
      const agent = createMockAgent();
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: agent } as never);
      vi.mocked(getProviders).mockResolvedValue(mockProviders);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      render(await EditAgentPage({ params }));

      // Assert: providers from getProviders are forwarded to AgentForm
      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-providers', JSON.stringify(mockProviders));
    });

    it('passes models from getModels to AgentForm', async () => {
      // Arrange
      const agent = createMockAgent();
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: agent } as never);
      vi.mocked(getModels).mockResolvedValue(mockModels);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      render(await EditAgentPage({ params }));

      // Assert: models from getModels are forwarded to AgentForm
      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-models', JSON.stringify(mockModels));
    });

    it('passes null providers to AgentForm when getProviders fails', async () => {
      // Arrange — page tolerates provider fetch failures (form falls back to text inputs)
      const agent = createMockAgent();
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: agent } as never);
      vi.mocked(getProviders).mockResolvedValue(null);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      render(await EditAgentPage({ params }));

      // Assert: null is forwarded to AgentForm — form handles fallback
      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-providers', 'null');
    });

    it('passes null models to AgentForm when getModels fails', async () => {
      // Arrange — page tolerates model registry fetch failures
      const agent = createMockAgent();
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: agent } as never);
      vi.mocked(getModels).mockResolvedValue(null);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      render(await EditAgentPage({ params }));

      // Assert: null is forwarded to AgentForm — form handles fallback
      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-models', 'null');
    });
  });

  // ── Breadcrumb navigation ─────────────────────────────────────────────────

  describe('breadcrumb navigation', () => {
    it('renders link to /admin/orchestration in breadcrumb', async () => {
      // Arrange
      const agent = createMockAgent({ name: 'Support Bot' });
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: agent } as never);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      render(await EditAgentPage({ params }));

      // Assert
      const orchLink = screen.getByRole('link', { name: 'AI Orchestration' });
      expect(orchLink).toHaveAttribute('href', '/admin/orchestration');
    });

    it('renders link to /admin/orchestration/agents in breadcrumb', async () => {
      // Arrange
      const agent = createMockAgent({ name: 'Support Bot' });
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: agent } as never);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      render(await EditAgentPage({ params }));

      // Assert
      const agentsLink = screen.getByRole('link', { name: 'Agents' });
      expect(agentsLink).toHaveAttribute('href', '/admin/orchestration/agents');
    });

    it('renders the agent name as the last breadcrumb segment', async () => {
      // Arrange
      const agent = createMockAgent({ name: 'Support Bot' });
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({ success: true, data: agent } as never);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      render(await EditAgentPage({ params }));

      // Assert: agent name shown as non-link breadcrumb tail
      expect(screen.getByText('Support Bot')).toBeInTheDocument();
    });
  });

  // ── generateMetadata ────────────────────────────────────────────────────────

  describe('generateMetadata', () => {
    it('returns edit title with agent name when agent is found', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse).mockResolvedValue({
        success: true,
        data: createMockAgent({ name: 'My Agent' }),
      } as never);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: title uses the agent name
      expect(metadata.title).toBe('Edit My Agent · AI Orchestration');
    });

    it('returns fallback title when agent is not found', async () => {
      // Arrange — res.ok false → getAgent returns null
      vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
      const params = Promise.resolve({ id: 'nonexistent' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert: fallback title used when agent cannot be loaded
      expect(metadata.title).toBe('Edit agent · AI Orchestration');
    });

    it('returns the correct description', async () => {
      // Arrange
      vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
      const params = Promise.resolve({ id: 'agent-123' });

      // Act
      const metadata = await generateMetadata({ params });

      // Assert
      expect(metadata.description).toBe('Edit an existing AI agent.');
    });
  });
});
