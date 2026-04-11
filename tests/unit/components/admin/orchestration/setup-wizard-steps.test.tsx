/**
 * SetupWizard — Individual Step Content Tests
 *
 * Complements setup-wizard.test.tsx (shell + navigation) by drilling
 * into the per-step API interactions and edge cases that aren't covered
 * by the navigation tests.
 *
 * Steps under test:
 *   Step 2 (index 1) — StepProvider: POST provider, already-exists card, validation error
 *   Step 3 (index 2) — StepAgent: POST agent, POST failure leaves user on step
 *   Step 4 (index 3) — StepTestAgent: Continue button advances wizard
 *   Step 5 (index 4) — StepDone: done screen renders, Finish clears localStorage
 *
 * @see components/admin/orchestration/setup-wizard.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';

const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v1';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedStorage(stepIndex: number, overrides: Record<string, unknown> = {}) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      stepIndex,
      providerDraft: { name: '', slug: '', apiKeyEnvVar: '' },
      agentDraft: {
        name: 'My Agent',
        slug: 'my-agent',
        description: 'A test agent',
        systemInstructions: 'You are helpful.',
        model: 'claude-opus-4-6',
        provider: 'anthropic',
      },
      createdAgentSlug: null,
      ...overrides,
    })
  );
}

/** Returns a fetch mock that always says "no providers, no agents". */
function makeFetchMock(providerTotal = 0, agentTotal = 0) {
  return vi.fn().mockImplementation((url: string) => {
    const u = typeof url === 'string' ? url : '';
    if (u.includes('/providers')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [], meta: { total: providerTotal } }),
      });
    }
    if (u.includes('/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [], meta: { total: agentTotal } }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SetupWizard — step content', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Step 2 — Provider
  // --------------------------------------------------------------------------

  describe('Step 2 — StepProvider', () => {
    it('POST happy path: submitting a valid provider calls the providers endpoint and advances', async () => {
      // Arrange: probe returns no providers so the inline form is shown
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        // Probe fetches (GET)
        if (!init?.method || init.method === 'GET') {
          if (u.includes('/providers')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ success: true, data: [], meta: { total: 0 } }),
            });
          }
          if (u.includes('/agents')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ success: true, data: [], meta: { total: 0 } }),
            });
          }
        }
        // POST to providers — success
        if (init?.method === 'POST' && u.includes('/providers')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { id: 'prov-1' } }),
          });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
      seedStorage(1);

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // Wait for the inline form to appear (no providers)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
      });

      // Fill out the form
      await user.type(document.getElementById('provider-name')!, 'Anthropic Prod');
      await user.type(document.getElementById('provider-slug')!, 'anthropic-prod');

      // Submit
      await user.click(screen.getByRole('button', { name: /create provider/i }));

      // Assert: POST was called to providers endpoint
      await waitFor(() => {
        const postCalls = fetchMock.mock.calls.filter((call) => {
          const u = typeof call[0] === 'string' ? call[0] : '';
          const init = call[1] as RequestInit | undefined;
          return u.includes('/providers') && init?.method === 'POST';
        });
        expect(postCalls.length).toBeGreaterThanOrEqual(1);
      });

      // Assert: wizard advanced to step 3
      await waitFor(() => {
        expect(screen.getByText(/Step 3 of 5/i)).toBeInTheDocument();
      });
    });

    it('already-exists card auto-shows when providers exist and Continue advances without error', async () => {
      // Arrange: provider check returns total=1 so the "already configured" card shows
      const fetchMock = makeFetchMock(1, 0);
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();
      seedStorage(1);

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      // The auto-complete card should render
      await waitFor(() => {
        expect(screen.getByText(/already have a provider configured/i)).toBeInTheDocument();
      });

      // Click Continue — should advance to step 3 without any POST
      const postCallsBefore = fetchMock.mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'POST';
      }).length;

      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/Step 3 of 5/i)).toBeInTheDocument();
      });

      // Assert: no POST was fired
      const postCallsAfter = fetchMock.mock.calls.filter((call) => {
        const init = call[1] as RequestInit | undefined;
        return init?.method === 'POST';
      }).length;
      expect(postCallsAfter).toBe(postCallsBefore);
    });

    it('renders inline error when the provider POST returns a non-ok response', async () => {
      // Arrange: probe shows no providers; POST returns 400
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (!init?.method || init.method === 'GET') {
          if (u.includes('/providers')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ success: true, data: [], meta: { total: 0 } }),
            });
          }
          if (u.includes('/agents')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ success: true, data: [], meta: { total: 0 } }),
            });
          }
        }
        // Provider POST fails
        if (init?.method === 'POST' && u.includes('/providers')) {
          return Promise.resolve({
            ok: false,
            status: 400,
            json: () =>
              Promise.resolve({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Invalid slug' },
              }),
          });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
      seedStorage(1);

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create provider/i })).toBeInTheDocument();
      });

      // Fill required fields so the form submits
      await user.type(document.getElementById('provider-name')!, 'Bad Provider');
      await user.type(document.getElementById('provider-slug')!, 'bad-provider');
      await user.click(screen.getByRole('button', { name: /create provider/i }));

      // Assert: inline error message appears, wizard stays on step 2
      await waitFor(() => {
        expect(screen.getByText(/could not create the provider/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/Step 2 of 5/i)).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Step 3 — Agent creation
  // --------------------------------------------------------------------------

  describe('Step 3 — StepAgent', () => {
    it('POST happy path: submitting valid agent data calls the agents endpoint and advances', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        // Probe
        if (u.includes('/providers')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: [], meta: { total: 1 } }),
          });
        }
        if (u.includes('/agents') && (!init?.method || init.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: [], meta: { total: 0 } }),
          });
        }
        // Agent POST
        if (init?.method === 'POST' && u.includes('/agents')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                data: { id: 'agent-1', slug: 'my-agent' },
              }),
          });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
      seedStorage(2, {
        agentDraft: {
          name: 'My Agent',
          slug: 'my-agent',
          description: 'A test agent',
          systemInstructions: 'You are helpful.',
          model: 'claude-opus-4-6',
          provider: 'anthropic',
        },
      });

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/Step 3 of 5/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /create agent/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /create agent/i }));

      // Assert: POST was fired to agents endpoint
      await waitFor(() => {
        const postCalls = fetchMock.mock.calls.filter((call) => {
          const u = typeof call[0] === 'string' ? call[0] : '';
          const init = call[1] as RequestInit | undefined;
          return u.includes('/agents') && init?.method === 'POST';
        });
        expect(postCalls.length).toBeGreaterThanOrEqual(1);
      });

      // Assert: advances to step 4
      await waitFor(() => {
        expect(screen.getByText(/Step 4 of 5/i)).toBeInTheDocument();
      });
    });

    it('POST failure renders an inline error and keeps user on step 3', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const u = typeof url === 'string' ? url : '';
        if (u.includes('/providers')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: [], meta: { total: 1 } }),
          });
        }
        if (u.includes('/agents') && (!init?.method || init.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: [], meta: { total: 0 } }),
          });
        }
        if (init?.method === 'POST' && u.includes('/agents')) {
          return Promise.resolve({
            ok: false,
            status: 422,
            json: () =>
              Promise.resolve({
                success: false,
                error: { code: 'VALIDATION_ERROR', message: 'Slug taken' },
              }),
          });
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      });
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
      seedStorage(2, {
        agentDraft: {
          name: 'My Agent',
          slug: 'my-agent',
          description: 'A test agent',
          systemInstructions: 'You are helpful.',
          model: 'claude-opus-4-6',
          provider: 'anthropic',
        },
      });

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create agent/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /create agent/i }));

      // Assert: error shown, still on step 3
      await waitFor(() => {
        expect(screen.getByText(/could not create the agent/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/Step 3 of 5/i)).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------------------------
  // Step 4 — Test agent
  // --------------------------------------------------------------------------

  describe('Step 4 — StepTestAgent', () => {
    it('Continue button on step 4 advances to step 5', async () => {
      const fetchMock = makeFetchMock(1, 1);
      vi.stubGlobal('fetch', fetchMock);
      const user = userEvent.setup();

      seedStorage(3, { createdAgentSlug: 'my-agent' });

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/Step 4 of 5/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => {
        expect(screen.getByText(/Step 5 of 5/i)).toBeInTheDocument();
      });
    });
  });

  // --------------------------------------------------------------------------
  // Step 5 — Done
  // --------------------------------------------------------------------------

  describe('Step 5 — StepDone', () => {
    it('renders done screen with success card and navigation links', async () => {
      const fetchMock = makeFetchMock(1, 1);
      vi.stubGlobal('fetch', fetchMock);

      seedStorage(4);

      render(<SetupWizard open={true} onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(screen.getByText(/Step 5 of 5/i)).toBeInTheDocument();
      });

      // Done card
      expect(screen.getByText(/you're set up/i)).toBeInTheDocument();

      // Navigation links to next steps
      expect(screen.getByRole('link', { name: /explore patterns/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /build a workflow/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /add knowledge docs/i })).toBeInTheDocument();
    });

    it('Finish button clears localStorage and calls onOpenChange(false)', async () => {
      const fetchMock = makeFetchMock(1, 1);
      vi.stubGlobal('fetch', fetchMock);

      const onOpenChange = vi.fn();
      seedStorage(4);

      const user = userEvent.setup();
      render(<SetupWizard open={true} onOpenChange={onOpenChange} />);

      await waitFor(() => {
        expect(screen.getByText(/Step 5 of 5/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /finish/i }));

      // Storage should be cleared
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
      // Dialog closed
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
