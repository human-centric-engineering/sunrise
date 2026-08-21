// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Edit Capability Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/capabilities/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Mock serverFetch for capability GET + /capabilities/:id/agents in parallel
 * - Asserts edit form is pre-filled with fixture capability name
 * - Asserts notFound() is called when capability GET returns null
 *
 * @see app/admin/orchestration/capabilities/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),

  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditCapabilityPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders form pre-filled with capability name in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY }) // capability
      .mockResolvedValueOnce({ success: true, data: MOCK_USED_BY }) // usedBy
      .mockResolvedValueOnce({ success: true, data: [] }); // categories

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

    await waitFor(() => {
      const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^name/i });
      expect(nameInput.value).toBe('Search Knowledge Base');
    });
  });

  it('renders "Save changes" button in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY })
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug input pre-filled and disabled in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY })
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

    await waitFor(() => {
      const slugInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^slug/i });
      expect(slugInput.value).toBe('search-knowledge-base');
      expect(slugInput).toBeDisabled();
    });
  });

  it('calls notFound() when capability fetch returns null', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    await expect(
      EditCapabilityPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── Fallback branches ──────────────────────────────────────────────────────

  describe('usedBy / categories fallback branches', () => {
    it('renders when usedBy fetch rejects (network error on secondary fetch)', async () => {
      // Arrange: capability fetch succeeds; usedBy rejects; categories ok
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      let callCount = 0;
      vi.mocked(serverFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('Network error');
        return Promise.resolve({ ok: true } as Response);
      });
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY }) // capability
        .mockResolvedValueOnce({ success: true, data: [] }); // categories

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      // Act: should not throw — usedBy falls back to []
      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      // Assert: structural stability
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });
    });

    it('renders when usedBy fetch returns res.ok=false', async () => {
      // Arrange: capability ok, usedBy !ok, categories ok
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      let callCount = 0;
      vi.mocked(serverFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.resolve({ ok: false } as Response);
        return Promise.resolve({ ok: true } as Response);
      });
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY })
        .mockResolvedValueOnce({ success: true, data: [] }); // categories

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });
    });

    it('renders when categories parseApiResponse returns success=false', async () => {
      // Arrange: capability and usedBy succeed; categories parse fails
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY })
        .mockResolvedValueOnce({ success: true, data: MOCK_USED_BY })
        .mockResolvedValueOnce({
          success: false,
          error: { message: 'Parse failed', code: 'PARSE_ERROR' },
        });

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      // Page still renders with empty categories
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });
    });
  });

  // ── getQuarantineAttribution error paths ────────────────────────────────────

  describe('getQuarantineAttribution fallback paths', () => {
    it('renders quarantine card WITHOUT attribution when serverFetch throws', async () => {
      // Arrange: 3 parallel fetches succeed; quarantine attribution fetch throws.
      // Set up serverFetch and parseApiResponse directly (no helper) to avoid
      // stacking mock queues that could spill into subsequent tests.
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      let fetchCallCount = 0;
      vi.mocked(serverFetch).mockImplementation(() => {
        fetchCallCount++;
        if (fetchCallCount === 4) throw new Error('Network error on attribution');
        return Promise.resolve({ ok: true } as Response);
      });
      // Only 3 parseApiResponse calls happen — the 4th serverFetch throws before
      // parseApiResponse is ever reached inside getQuarantineAttribution.
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY_SOFT_QUARANTINED })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: [] });

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      // Assert: quarantine card renders (capability is quarantined) but attribution
      // section is absent — the page degraded gracefully from the fetch error
      await waitFor(() => {
        // QuarantinedView renders the "Lift quarantine" button
        expect(screen.getByRole('button', { name: /lift quarantine/i })).toBeInTheDocument();
        // No audit attribution paragraph
        expect(screen.queryByLabelText('Audit attribution')).not.toBeInTheDocument();
      });
      // The error was logged, not thrown
      const { logger } = await import('@/lib/logging');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        'edit capability page: quarantine attribution fetch failed',
        expect.any(Error),
        { capabilityId: 'cap-edit-id' }
      );
    });

    it('renders quarantine card WITHOUT attribution when serverFetch returns ok=false', async () => {
      // Arrange: 3 parallel fetches succeed; attribution endpoint returns !ok
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      let fetchCallCount = 0;
      vi.mocked(serverFetch).mockImplementation(() => {
        fetchCallCount++;
        if (fetchCallCount === 4) return Promise.resolve({ ok: false } as Response);
        return Promise.resolve({ ok: true } as Response);
      });
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY_SOFT_QUARANTINED })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: [] });
      // parseApiResponse is never called for the 4th serverFetch because !ok short-circuits

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /lift quarantine/i })).toBeInTheDocument();
        expect(screen.queryByLabelText('Audit attribution')).not.toBeInTheDocument();
      });
    });

    it('renders quarantine card WITHOUT attribution when parseApiResponse returns success=false', async () => {
      // Arrange: all 4 fetches succeed (ok: true); attribution parse returns success=false
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY_SOFT_QUARANTINED })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({
          success: false,
          error: { message: 'Attribution parse error', code: 'PARSE_ERROR' },
        }); // attribution — success: false → null attribution

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /lift quarantine/i })).toBeInTheDocument();
        expect(screen.queryByLabelText('Audit attribution')).not.toBeInTheDocument();
      });
    });

    it('renders quarantine card WITH attribution when attribution fetch succeeds', async () => {
      // Arrange: all 4 fetches succeed; attribution returns actorName
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY_SOFT_QUARANTINED })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({
          success: true,
          data: {
            attribution: {
              at: '2026-05-01T10:00:00.000Z',
              actorName: 'Alice Admin',
            },
          },
        }); // attribution — success: true with actorName

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

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
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY_SOFT_QUARANTINED })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: { attribution: null } });

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      await waitFor(() => {
        // "Lift quarantine" button signals QuarantinedView is rendered
        expect(screen.getByRole('button', { name: /lift quarantine/i })).toBeInTheDocument();
        // The Name form field is always present
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });

      // Assert DOM order: quarantine card (QuarantinedView) must come BEFORE the form.
      // "Lift quarantine" is inside the quarantine card; the name input is inside the form.
      // Walk all interactive elements in tree order and verify liftButton index < nameInput index.
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
      const capabilityWithNullState = { ...MOCK_CAPABILITY, quarantineState: null };
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: capabilityWithNullState })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: { attribution: null } });

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      await waitFor(() => {
        // ActiveView renders "Emergency disable (quarantine)" toggle
        expect(screen.getByText('Emergency disable (quarantine)')).toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });

      // Assert DOM order: the quarantine card (ActiveView) must come AFTER the form.
      // The name input is inside the form; "Emergency disable" span is inside the card.
      const emergencyDisable = screen.getByText('Emergency disable (quarantine)');
      const nameInput = screen.getByRole('textbox', { name: /^name/i });
      // Walk all inputs and spans in tree order to verify nameInput index < emergencyDisable index.
      const allTextNodes = Array.from(document.querySelectorAll('input, span'));
      const nameIndex = allTextNodes.indexOf(nameInput);
      const disableIndex = allTextNodes.indexOf(emergencyDisable);
      expect(nameIndex).toBeGreaterThanOrEqual(0);
      expect(disableIndex).toBeGreaterThanOrEqual(0);
      expect(nameIndex).toBeLessThan(disableIndex); // form is above the quarantine card
    });

    it('load-bearing bug probe: past-expiry quarantine is treated as active — card placed BELOW form', async () => {
      // This test guards the regression described in page.tsx lines 114–119.
      //
      // quarantineState='quarantined-soft' but quarantineUntil is 2020-01-01 (past).
      // resolveQuarantineState returns 'active' (auto-expiry), so isQuarantined === false.
      // The page MUST agree with the dispatcher: card goes BELOW the form.
      // If the page naively checks the stored quarantineState column instead of
      // calling resolveQuarantineState, it would place the card above the form —
      // lying about the runtime behaviour.
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY_SOFT_QUARANTINE_EXPIRED })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: [] })
        .mockResolvedValueOnce({ success: true, data: { attribution: null } });

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      await waitFor(() => {
        // ActiveView is rendered (not QuarantinedView) because effective state is 'active'
        expect(screen.getByText('Emergency disable (quarantine)')).toBeInTheDocument();
        // "Lift quarantine" button must NOT be present — that's QuarantinedView's domain
        expect(screen.queryByRole('button', { name: /lift quarantine/i })).not.toBeInTheDocument();
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });

      // Assert DOM order: card (ActiveView) comes AFTER form — same contract as active capability.
      // If this fails, the page is reading the raw column instead of the effective state.
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
});
