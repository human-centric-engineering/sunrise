// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Edit Capability Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/capabilities/[id]/page.tsx`.
 *
 * Test Coverage:
 * - serverFetch answered by path for the capability GET, /capabilities/:id/agents,
 *   the category list and the quarantine attribution, with real Responses
 * - Asserts edit form is pre-filled with fixture capability name
 * - Asserts notFound() is called on a 404, and only on a 404: a 500 on the
 *   capability throws to the error boundary (#518). Only the capability
 *   decides not-found.
 * - A failed agent-usage list renders the page with a notice in the "Used by"
 *   card's place and in the quarantine card, never a count of zero
 * - A failed category list shows a "Couldn't load" notice; the form still renders
 * - A failed attribution load omits the attribution line
 *
 * @see app/admin/orchestration/capabilities/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: mockNotFound,
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),

  useSearchParams: () => ({ get: () => null }),
}));

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_CAPABILITY = {
  id: 'cap-edit-id',
  name: 'Search Knowledge Base',
  slug: 'search-knowledge-base',
  description: 'Semantic search over the knowledge base',
  category: 'knowledge',
  executionType: 'internal',
  executionHandler: 'SearchKnowledgeCapability',
  executionConfig: null,
  functionDefinition: {},
  requiresApproval: false,
  rateLimit: null,
  isActive: true,
  createdBy: 'system',
  createdAt: new Date('2025-01-01').toISOString(),
  updatedAt: new Date('2025-01-01').toISOString(),
  deletedAt: null,
  metadata: {},
  quarantineState: 'active',
  quarantineReason: null,
  quarantineUntil: null,
};

/**
 * Capability with an active soft quarantine (no expiry → indefinitely quarantined).
 * `resolveQuarantineState` returns 'quarantined-soft', so isQuarantined === true.
 */
const MOCK_CAPABILITY_SOFT_QUARANTINED = {
  ...MOCK_CAPABILITY,
  quarantineState: 'quarantined-soft',
  quarantineReason: 'Vendor API returning 500s',
  quarantineUntil: null,
};

/**
 * Capability with quarantineState='quarantined-soft' but quarantineUntil in the
 * past. `resolveQuarantineState` returns 'active' — the effective state is active
 * even though the stored column says quarantined-soft. This is the load-bearing
 * regression scenario the page comment at lines 114–119 warns about.
 */
const MOCK_CAPABILITY_SOFT_QUARANTINE_EXPIRED = {
  ...MOCK_CAPABILITY,
  quarantineState: 'quarantined-soft',
  quarantineReason: 'Old outage — expired',
  quarantineUntil: new Date('2020-01-01').toISOString(),
};

const MOCK_USED_BY = [{ id: 'agent-1', name: 'Alpha Bot', slug: 'alpha-bot' }];

type Answer = () => Promise<Response>;

const ok =
  (data: unknown, meta?: unknown): Answer =>
  () =>
    Promise.resolve(apiSuccess(data, meta));
const fail =
  (status = 500): Answer =>
  () =>
    Promise.resolve(apiFailure(status, status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR'));
const reject = (): Answer => () => Promise.reject(new Error('Network error'));

/** Answer each of the page's four fetches by path. */
async function mockApi({
  capability = ok(MOCK_CAPABILITY),
  usedBy = ok([]),
  categories = ok([]),
  attribution = ok({ attribution: null }),
}: {
  capability?: Answer;
  usedBy?: Answer;
  categories?: Answer;
  attribution?: Answer;
} = {}) {
  const { serverFetch } = await import('@/lib/api/server-fetch');
  vi.mocked(serverFetch).mockImplementation((path: string) => {
    if (path.endsWith('/agents')) return usedBy();
    if (path.endsWith('/quarantine-attribution')) return attribution();
    if (path.includes('?page=')) return categories();
    return capability();
  });
}

async function renderPage(id = 'cap-edit-id') {
  const { default: EditCapabilityPage } =
    await import('@/app/admin/orchestration/capabilities/[id]/page');
  render(await EditCapabilityPage({ params: Promise.resolve({ id }) }));
}

async function loadPage(id = 'cap-edit-id') {
  const { default: EditCapabilityPage } =
    await import('@/app/admin/orchestration/capabilities/[id]/page');
  return EditCapabilityPage({ params: Promise.resolve({ id }) });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditCapabilityPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders form pre-filled with capability name in edit mode', async () => {
    await mockApi({ usedBy: ok(MOCK_USED_BY) });

    await renderPage();

    await waitFor(() => {
      const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^name/i });
      expect(nameInput.value).toBe('Search Knowledge Base');
    });
    expect(screen.queryByText(/couldn.t load/i)).not.toBeInTheDocument();
  });

  it('requests the capability, its agents, the category list and the attribution', async () => {
    await mockApi();
    const { serverFetch } = await import('@/lib/api/server-fetch');

    await renderPage();

    const paths = vi.mocked(serverFetch).mock.calls.map((c) => c[0]);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/admin/orchestration/capabilities/cap-edit-id',
        '/api/v1/admin/orchestration/capabilities/cap-edit-id/agents',
        '/api/v1/admin/orchestration/capabilities?page=1&limit=100',
        '/api/v1/admin/orchestration/capabilities/cap-edit-id/quarantine-attribution',
      ])
    );
  });

  it('renders "Save changes" button in edit mode', async () => {
    await mockApi();

    await renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug input pre-filled and disabled in edit mode', async () => {
    await mockApi();

    await renderPage();

    await waitFor(() => {
      const slugInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^slug/i });
      expect(slugInput.value).toBe('search-knowledge-base');
      expect(slugInput).toBeDisabled();
    });
  });

  // ── Not found vs failed (#518) ─────────────────────────────────────────────

  it('calls notFound() when the capability does not exist', async () => {
    // The agents sub-route 404s for a missing capability too.
    await mockApi({ capability: fail(404), usedBy: fail(404) });

    await expect(loadPage('nonexistent-id')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalled(); // test-review:accept no_arg_called — callback-fired guard;
  });

  it('throws to the error boundary, not notFound(), when the capability load fails', async () => {
    const { ServerLoadError } = await import('@/lib/api/server-load');
    await mockApi({ capability: fail(500) });

    await expect(loadPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('throws to the error boundary when the capability fetch rejects', async () => {
    const { ServerLoadError } = await import('@/lib/api/server-load');
    await mockApi({ capability: reject() });

    await expect(loadPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('calls notFound() when the capability 404s even if its agent list fails differently', async () => {
    await mockApi({ capability: fail(404), usedBy: fail(500) });

    await expect(loadPage('nonexistent-id')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  // ── Agent-usage list: secondary, shown as failed (#518) ────────────────────

  // The usage list feeds "Used by" and the quarantine card's "Will affect N
  // agents": rendered from a failed load, both would state zero as fact.
  describe('when the agent-usage list fails to load', () => {
    it.each([
      ['answers 500', fail(500)],
      ['answers success:false', fail(200)],
      ['rejects', reject()],
      // Only the capability fetch may decide not-found.
      ['answers 404', fail(404)],
    ])('renders the form, with a notice on the Safety tab, when it %s', async (_l, usedBy) => {
      await mockApi({ usedBy });
      const user = userEvent.setup();

      await renderPage();

      expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      expect(mockNotFound).not.toHaveBeenCalled();
      await user.click(screen.getByRole('tab', { name: /safety/i }));
      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load the agents using this capability/i
      );
      expect(screen.queryByText(/used by/i)).not.toBeInTheDocument();
    });

    it('shows a notice in the quarantine card instead of an agent count', async () => {
      await mockApi({ capability: ok(MOCK_CAPABILITY_SOFT_QUARANTINED), usedBy: fail(500) });

      await renderPage();

      expect(screen.getByRole('button', { name: /lift quarantine/i })).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load the agents using this capability/i
      );
      expect(screen.queryByText(/no agents currently use/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/agents? affected/i)).not.toBeInTheDocument();
    });
  });

  // ── Category list: secondary, shown as failed (#518) ───────────────────────

  describe('when the category list fails to load', () => {
    it.each([
      ['answers 500', fail(500)],
      ['answers success:false', fail(200)],
      ['rejects', reject()],
    ])('still renders the form, with a notice, when it %s', async (_label, categories) => {
      await mockApi({ usedBy: ok(MOCK_USED_BY), categories });

      await renderPage();

      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load existing capability categories/i
      );
      expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
    });
  });

  // ── getQuarantineAttribution error paths ────────────────────────────────────

  describe('getQuarantineAttribution fallback paths', () => {
    it.each([
      ['rejects', reject()],
      ['answers 500', fail(500)],
      ['answers success:false', fail(200)],
    ])('renders quarantine card WITHOUT attribution when the fetch %s', async (_l, attribution) => {
      await mockApi({ capability: ok(MOCK_CAPABILITY_SOFT_QUARANTINED), attribution });

      await renderPage();

      await waitFor(() => {
        // QuarantinedView renders the "Lift quarantine" button
        expect(screen.getByRole('button', { name: /lift quarantine/i })).toBeInTheDocument();
        // No audit attribution paragraph
        expect(screen.queryByLabelText('Audit attribution')).not.toBeInTheDocument();
      });
      // The failure was logged (by the loader), not thrown
      const { logger } = await import('@/lib/logging');
      const loggedPaths = vi.mocked(logger.error).mock.calls.map((c) => c[2]);
      expect(loggedPaths).toContainEqual(
        expect.objectContaining({
          path: '/api/v1/admin/orchestration/capabilities/cap-edit-id/quarantine-attribution',
        })
      );
    });

    it('renders quarantine card WITH attribution when attribution fetch succeeds', async () => {
      await mockApi({
        capability: ok(MOCK_CAPABILITY_SOFT_QUARANTINED),
        attribution: ok({
          attribution: { at: '2026-05-01T10:00:00.000Z', actorName: 'Alice Admin' },
        }),
      });

      await renderPage();

      // Assert: attribution paragraph rendered — the page passed the attribution prop
      // to CapabilityQuarantineCard and the QuarantinedView used it
      await waitFor(() => {
        expect(screen.getByLabelText('Audit attribution')).toBeInTheDocument();
      });
    });
  });

  // ── Effective quarantine state + card placement ──────────────────────────────

  describe('effective quarantine state and card DOM placement', () => {
    it('places quarantine card ABOVE the form when capability is actively quarantined', async () => {
      // Arrange: quarantined-soft with no expiry → isQuarantined === true
      // → {isQuarantined && quarantineCard} renders BEFORE <CapabilityForm>
      await mockApi({ capability: ok(MOCK_CAPABILITY_SOFT_QUARANTINED) });

      await renderPage();

      await waitFor(() => {
        // "Lift quarantine" button signals QuarantinedView is rendered
        expect(screen.getByRole('button', { name: /lift quarantine/i })).toBeInTheDocument();
        // The Name form field is always present
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });

      // Assert DOM order: quarantine card (QuarantinedView) must come BEFORE the form.
      const liftButton = screen.getByRole('button', { name: /lift quarantine/i });
      const nameInput = screen.getByRole('textbox', { name: /^name/i });
      const allElements = Array.from(document.querySelectorAll('button, input'));
      const liftIndex = allElements.indexOf(liftButton);
      const nameIndex = allElements.indexOf(nameInput);
      expect(liftIndex).toBeGreaterThanOrEqual(0); // both elements are in the DOM
      expect(nameIndex).toBeGreaterThanOrEqual(0);
      expect(liftIndex).toBeLessThan(nameIndex); // quarantine card is above the form
    });

    it('places quarantine card BELOW the form when capability is active (no quarantine)', async () => {
      // Arrange: quarantineState=null → ?? 'active' → isQuarantined === false
      // → {!isQuarantined && quarantineCard} renders AFTER <CapabilityForm>
      await mockApi({ capability: ok({ ...MOCK_CAPABILITY, quarantineState: null }) });

      await renderPage();

      await waitFor(() => {
        // ActiveView renders "Emergency disable (quarantine)" toggle
        expect(screen.getByText('Emergency disable (quarantine)')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });

      // Assert DOM order: the quarantine card (ActiveView) must come AFTER the form.
      const emergencyDisable = screen.getByText('Emergency disable (quarantine)');
      const nameInput = screen.getByRole('textbox', { name: /^name/i });
      const allTextNodes = Array.from(document.querySelectorAll('input, span'));
      const nameIndex = allTextNodes.indexOf(nameInput);
      const disableIndex = allTextNodes.indexOf(emergencyDisable);
      expect(nameIndex).toBeGreaterThanOrEqual(0);
      expect(disableIndex).toBeGreaterThanOrEqual(0);
      expect(nameIndex).toBeLessThan(disableIndex); // form is above the quarantine card
    });

    it('load-bearing bug probe: past-expiry quarantine is treated as active — card placed BELOW form', async () => {
      // quarantineState='quarantined-soft' but quarantineUntil is 2020-01-01 (past).
      // resolveQuarantineState returns 'active' (auto-expiry), so isQuarantined === false.
      // The page MUST agree with the dispatcher: card goes BELOW the form.
      // If the page naively checks the stored quarantineState column instead of
      // calling resolveQuarantineState, it would place the card above the form —
      // lying about the runtime behaviour.
      await mockApi({ capability: ok(MOCK_CAPABILITY_SOFT_QUARANTINE_EXPIRED) });

      await renderPage();

      await waitFor(() => {
        // ActiveView is rendered (not QuarantinedView) because effective state is 'active'
        expect(screen.getByText('Emergency disable (quarantine)')).toBeInTheDocument();
        // "Lift quarantine" button must NOT be present — that's QuarantinedView's domain
        expect(screen.queryByRole('button', { name: /lift quarantine/i })).not.toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });

      // Assert DOM order: card (ActiveView) comes AFTER form — same contract as active capability.
      const emergencyDisable = screen.getByText('Emergency disable (quarantine)');
      const nameInput = screen.getByRole('textbox', { name: /^name/i });
      const allTextNodes = Array.from(document.querySelectorAll('input, span'));
      const nameIndex = allTextNodes.indexOf(nameInput);
      const disableIndex = allTextNodes.indexOf(emergencyDisable);
      expect(nameIndex).toBeGreaterThanOrEqual(0);
      expect(disableIndex).toBeGreaterThanOrEqual(0);
      expect(nameIndex).toBeLessThan(disableIndex); // form is above the quarantine card
    });
  });

  describe('agents in other organisations (§107 t-752)', () => {
    async function renderWithUsedByMeta(meta: Record<string, unknown> | undefined) {
      await mockApi({
        capability: ok(MOCK_CAPABILITY_SOFT_QUARANTINED),
        usedBy: ok(MOCK_USED_BY, meta),
      });
      await renderPage();
    }

    it('reads meta.otherOrgAgentCount and counts it into the affected agents', async () => {
      await renderWithUsedByMeta({ otherOrgAgentCount: 2 });

      expect(await screen.findByRole('button', { name: /3 agents affected/i })).toBeInTheDocument();
    });

    it('treats a missing or malformed count as none', async () => {
      await renderWithUsedByMeta({ otherOrgAgentCount: 'two' });

      expect(await screen.findByRole('button', { name: /1 agent affected/i })).toBeInTheDocument();
    });

    it('treats a response with no meta as none', async () => {
      await renderWithUsedByMeta(undefined);

      expect(await screen.findByRole('button', { name: /1 agent affected/i })).toBeInTheDocument();
    });
  });
});
