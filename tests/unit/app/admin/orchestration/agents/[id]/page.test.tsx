// @vitest-environment happy-dom

/**
 * Unit Tests: EditAgentPage
 *
 * Tests the admin "Edit Agent" server component page.
 *
 * Test Coverage:
 * - notFound() on a 404, and only on a 404: a 500, success:false or a network
 *   failure throws to the error boundary instead (#518)
 * - Happy path — agent found, renders breadcrumb and AgentForm with correct props
 * - serverFetch called with the correct agentById endpoint
 * - generateMetadata — title variants for found and missing agents
 * - Provider / model data flow — values passed through to AgentForm
 * - Provider / model failure tolerance — null values passed when prefetch fails
 * - Quarantine list / evaluation trend / profiles failures — a "Couldn't load"
 *   notice in the panel's place, never an empty all-clear (#518)
 *
 * @see app/admin/orchestration/agents/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/orchestration/prefetch-helpers', () => ({
  getProviders: vi.fn(),
  // The edit page now uses getAgentModels (matrix-only, capability-filtered)
  // instead of the broader getModels registry view. The old name is kept
  // mocked anyway so any leftover transitive import doesn't blow up.
  getAgentModels: vi.fn(),
  getModels: vi.fn(),
  getEffectiveAgentDefaults: vi.fn(async () => ({
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    inheritedProvider: false,
    inheritedModel: false,
  })),
}));

// Stub AgentForm so we can inspect its props without client-side complexity
vi.mock('@/components/admin/orchestration/agent-form', () => ({
  AgentForm: (props: {
    mode: string;
    agent?: { id: string; name: string };
    providers: unknown;
    models: unknown;
    profiles?: unknown;
  }) => (
    <div
      data-testid="agent-form"
      data-mode={props.mode}
      data-agent-id={props.agent?.id}
      data-agent-name={props.agent?.name}
      data-providers={JSON.stringify(props.providers)}
      data-models={JSON.stringify(props.models)}
      data-profiles={JSON.stringify(props.profiles)}
    />
  ),
}));

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import EditAgentPage, { generateMetadata } from '@/app/admin/orchestration/agents/[id]/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { notFound, unstable_rethrow } from 'next/navigation';
import { getProviders, getAgentModels } from '@/lib/orchestration/prefetch-helpers';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';
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
    citationGuardMode: null,
    maxHistoryTokens: null,
    retentionDays: null,
    visibility: 'internal',
    isActive: true,
    isSystem: false,
    createdBy: 'user-456',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-15'),
    deletedAt: null,
    lastActiveAt: null,
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
    jurisdiction: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  },
];

const mockModels: ModelOption[] = [
  { provider: 'anthropic', id: 'claude-sonnet-4-6', tier: 'frontier' },
  { provider: 'anthropic', id: 'claude-haiku-3-5', tier: 'budget' },
];

type Answer = () => Promise<Response>;

const ok =
  (data: unknown): Answer =>
  () =>
    Promise.resolve(apiSuccess(data));
const fail =
  (status = 500): Answer =>
  () =>
    Promise.resolve(apiFailure(status, status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR'));
const reject = (): Answer => () => Promise.reject(new Error('Network failure'));

/** Answer each of the page's own fetches by path. */
function mockApi({
  agent = ok(createMockAgent()),
  trend = ok({ points: [] }),
  profiles = ok([]),
  quarantined = ok({ items: [] }),
}: { agent?: Answer; trend?: Answer; profiles?: Answer; quarantined?: Answer } = {}) {
  vi.mocked(serverFetch).mockImplementation((path: string) => {
    if (path.endsWith('/evaluation-trend')) return trend();
    if (path.endsWith('/quarantined-capabilities')) return quarantined();
    if (path.includes('/agent-profiles')) return profiles();
    return agent();
  });
}

const QUARANTINED_ITEM = {
  capabilityId: 'cap-1',
  capabilitySlug: 'web-search',
  capabilityName: 'Web Search',
  mode: 'quarantined-soft',
  reason: 'Vendor outage',
  expiresAt: null,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditAgentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: providers and models succeed
    vi.mocked(getProviders).mockResolvedValue(mockProviders);
    vi.mocked(getAgentModels).mockResolvedValue(mockModels);
  });

  // ── Not found vs failed (#518) ─────────────────────────────────────────────

  describe('notFound behavior', () => {
    it('calls notFound when the agent does not exist', async () => {
      mockApi({ agent: fail(404) });

      await expect(EditAgentPage({ params: Promise.resolve({ id: 'agent-999' }) })).rejects.toThrow(
        'NEXT_NOT_FOUND'
      );
      expect(notFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard
    });

    it.each([
      ['answers 500', fail(500)],
      ['answers success:false', fail(200)],
      ['rejects', reject()],
    ])(
      'throws to the error boundary, not notFound(), when the agent fetch %s',
      async (_l, agent) => {
        mockApi({ agent });

        await expect(
          EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) })
        ).rejects.toBeInstanceOf(ServerLoadError);
        expect(notFound).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalled();
      }
    );
  });

  // ── serverFetch endpoint verification ─────────────────────────────────────

  describe('serverFetch endpoint', () => {
    it('calls serverFetch with the correct agentById endpoint', async () => {
      const agentId = 'agent-abc';
      mockApi({ agent: ok(createMockAgent({ id: agentId })) });

      render(await EditAgentPage({ params: Promise.resolve({ id: agentId }) }));

      const paths = vi.mocked(serverFetch).mock.calls.map((c) => c[0]);
      expect(paths).toContain(API.ADMIN.ORCHESTRATION.agentById(agentId));
    });
  });

  // ── Happy path — agent found ───────────────────────────────────────────────

  describe('happy path rendering', () => {
    it('renders AgentForm in edit mode with the fetched agent', async () => {
      mockApi({ agent: ok(createMockAgent({ id: 'agent-123', name: 'Support Bot' })) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-mode', 'edit');
      expect(form).toHaveAttribute('data-agent-id', 'agent-123');
      expect(form).toHaveAttribute('data-agent-name', 'Support Bot');
      expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument();
    });

    it('shows why an agent stranded by its org provider policy cannot respond (§120 t-745)', async () => {
      mockApi({
        agent: ok({ ...createMockAgent({ provider: 'openai' }), _unapprovedProviders: ['openai'] }),
      });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      expect(screen.getByRole('alert')).toHaveTextContent('This agent cannot respond');
      expect(screen.getByRole('alert')).toHaveTextContent('“openai”');
    });

    it('shows no provider banner for an agent its org may run', async () => {
      mockApi({ agent: ok({ ...createMockAgent(), _unapprovedProviders: [] }) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      expect(screen.queryByText(/not approved for this organisation/)).not.toBeInTheDocument();
      expect(screen.queryByText(/cannot respond/)).not.toBeInTheDocument();
    });

    it('passes providers from getProviders to AgentForm', async () => {
      mockApi();
      vi.mocked(getProviders).mockResolvedValue(mockProviders);

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-providers', JSON.stringify(mockProviders));
    });

    it('passes models from getAgentModels to AgentForm', async () => {
      mockApi();
      vi.mocked(getAgentModels).mockResolvedValue(mockModels);

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-models', JSON.stringify(mockModels));
    });

    it('passes null providers to AgentForm when getProviders fails', async () => {
      // Page tolerates provider fetch failures (form falls back to text inputs + warning)
      mockApi();
      vi.mocked(getProviders).mockResolvedValue(null);

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-providers', 'null');
    });

    it('passes null models to AgentForm when getAgentModels fails', async () => {
      mockApi();
      vi.mocked(getAgentModels).mockResolvedValue(null);

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      const form = screen.getByTestId('agent-form');
      expect(form).toHaveAttribute('data-models', 'null');
    });
  });

  // ── Secondary panels: a failure is shown, never an empty all-clear (#518) ──

  describe('secondary panels', () => {
    it('renders the quarantined-capabilities banner when the agent has quarantined tools', async () => {
      mockApi({ quarantined: ok({ items: [QUARANTINED_ITEM] }) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      expect(screen.getByText('Web Search')).toBeInTheDocument();
      expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument();
    });

    it.each([
      ['answers 500', fail(500)],
      ['rejects', reject()],
    ])(
      'shows a notice in place of the quarantine banner when its fetch %s',
      async (_l, quarantined) => {
        mockApi({ quarantined });

        render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

        expect(screen.getByRole('alert')).toHaveTextContent(
          /couldn.t load quarantined capabilities/i
        );
        // The rest of the page still works.
        expect(screen.getByTestId('agent-form')).toBeInTheDocument();
      }
    );

    it('shows a notice in place of the evaluation trend when its fetch fails', async () => {
      mockApi({ trend: fail(500) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load the evaluation trend/i);
      expect(screen.getByTestId('agent-form')).toBeInTheDocument();
    });

    it('passes the loaded profiles to AgentForm', async () => {
      const profiles = [{ id: 'p1', name: 'Support Family' }];
      mockApi({ profiles: ok(profiles) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      expect(screen.getByTestId('agent-form')).toHaveAttribute(
        'data-profiles',
        JSON.stringify(profiles)
      );
    });

    it('shows a notice above the form when the profiles fetch fails', async () => {
      mockApi({ profiles: fail(500) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load agent profiles/i);
      expect(screen.getByTestId('agent-form')).toHaveAttribute('data-profiles', '[]');
    });
  });

  // ── Breadcrumb navigation ─────────────────────────────────────────────────

  describe('breadcrumb navigation', () => {
    it('renders link to /admin/orchestration in breadcrumb', async () => {
      mockApi({ agent: ok(createMockAgent({ name: 'Support Bot' })) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      const orchLink = screen.getByRole('link', { name: 'AI Orchestration' });
      expect(orchLink).toHaveAttribute('href', '/admin/orchestration');
    });

    it('renders link to /admin/orchestration/agents in breadcrumb', async () => {
      mockApi({ agent: ok(createMockAgent({ name: 'Support Bot' })) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      const agentsLink = screen.getByRole('link', { name: 'Agents' });
      expect(agentsLink).toHaveAttribute('href', '/admin/orchestration/agents');
    });

    it('renders the agent name as the last breadcrumb segment', async () => {
      mockApi({ agent: ok(createMockAgent({ name: 'Support Bot' })) });

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-123' }) }));

      expect(screen.getByText('Support Bot')).toBeInTheDocument();
    });
  });

  // ── generateMetadata ────────────────────────────────────────────────────────

  describe('generateMetadata', () => {
    it('returns edit title with agent name when agent is found', async () => {
      mockApi({ agent: ok(createMockAgent({ name: 'My Agent' })) });

      const metadata = await generateMetadata({ params: Promise.resolve({ id: 'agent-123' }) });

      expect(metadata.title).toBe('Edit My Agent · AI Orchestration');
    });

    it('returns fallback title when agent is not found', async () => {
      mockApi({ agent: fail(404) });

      const metadata = await generateMetadata({ params: Promise.resolve({ id: 'nonexistent' }) });

      expect(metadata.title).toBe('Edit agent · AI Orchestration');
    });

    it('returns fallback title, without throwing, when the agent load fails', async () => {
      mockApi({ agent: fail(500) });

      const metadata = await generateMetadata({ params: Promise.resolve({ id: 'agent-123' }) });

      expect(metadata.title).toBe('Edit agent · AI Orchestration');
      expect(metadata.description).toBe('Edit an existing AI agent.');
    });

    it("lets Next's control-flow errors through rather than falling back", async () => {
      // The real unstable_rethrow rethrows Next's own errors, notFound()'s among them.
      vi.mocked(unstable_rethrow).mockImplementationOnce((err: unknown) => {
        if (err instanceof Error && err.message === 'NEXT_NOT_FOUND') throw err;
      });
      mockApi({ agent: fail(404) });

      await expect(
        generateMetadata({ params: Promise.resolve({ id: 'nonexistent' }) })
      ).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });
});
