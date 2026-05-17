/**
 * SetupWizard Component Tests — top-level navigation and step indicator
 *
 * Scope:
 *   - Initial render at step 1 (fresh install)
 *   - Detection-card content (env-var presence → suggested defaults)
 *   - Snap-back when persisted state points beyond actual setup
 *   - Resume from a stored stepIndex
 *   - Step indicator renders the completed-trail
 *
 * Per-step API contracts (Continue advances, PATCH /settings on
 * defaults, POST /test + /test-model on smoke step, Finish clears
 * storage) live in `setup-wizard-steps.test.tsx`.
 *
 * The wizard's 4-step layout (config-oriented):
 *   0 provider · 1 defaults · 2 smoke test · 3 done
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizard } from '@/components/admin/orchestration/setup-wizard';
import {
  STORAGE_KEY,
  makeFetchMock,
  makeStoredState,
} from '@/tests/unit/components/admin/orchestration/setup-wizard.helpers';

describe('SetupWizard', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it('opens at step 1 of 4 (Provider) by default on a fresh install', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Configure a provider/i)).toBeInTheDocument();
  });

  // The "already-have-a-provider" success card test moved to
  // `setup-wizard-steps.test.tsx` ("already-exists card auto-shows
  // when providers exist and Continue advances") — that version is
  // strictly stronger because it also asserts the Continue advance.

  it('Provider step surfaces detection cards when an env-var key is present', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        providerTotal: 0,
        detected: [
          {
            slug: 'anthropic',
            name: 'Anthropic',
            providerType: 'anthropic',
            defaultBaseUrl: null,
            apiKeyEnvVar: 'ANTHROPIC_API_KEY',
            apiKeyPresent: true,
            alreadyConfigured: false,
            isLocal: false,
            suggestedDefaultChatModel: 'claude-sonnet-4-6',
            suggestedRoutingModel: null,
            suggestedReasoningModel: null,
            suggestedEmbeddingModel: null,
          },
        ],
      })
    );

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/We detected an API key/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/ANTHROPIC_API_KEY/i)).toBeInTheDocument();
    // The card now shows the suggested chat model up front and warns
    // that Anthropic doesn't offer embeddings — so the operator knows
    // what they're getting before clicking Configure.
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText(/Anthropic doesn't offer embeddings/i)).toBeInTheDocument();
    expect(screen.getByText(/Existing defaults are never overwritten/i)).toBeInTheDocument();
  });

  it('Provider step shows both chat + embedding suggestions when the provider supports both', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({
        providerTotal: 0,
        detected: [
          {
            slug: 'openai',
            name: 'OpenAI',
            providerType: 'openai-compatible',
            defaultBaseUrl: 'https://api.openai.com/v1',
            apiKeyEnvVar: 'OPENAI_API_KEY',
            apiKeyPresent: true,
            alreadyConfigured: false,
            isLocal: false,
            suggestedDefaultChatModel: 'gpt-4o-mini',
            suggestedRoutingModel: null,
            suggestedReasoningModel: null,
            suggestedEmbeddingModel: 'text-embedding-3-small',
          },
        ],
      })
    );

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 0 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument();
    });
    expect(screen.getByText('text-embedding-3-small')).toBeInTheDocument();
    expect(screen.queryByText(/doesn't offer embeddings/i)).not.toBeInTheDocument();
  });

  // The "manual flavour-picker form" fallback test moved to
  // `setup-wizard-steps.test.tsx` ("renders manual flavour-picker
  // form when no providers and no env vars detected") — same
  // assertions, lives next to the other Step 1 content checks.

  it('Snaps back to Provider step when persisted state points beyond actual setup', async () => {
    // No providers configured but persisted stepIndex points at smoke test.
    // The wizard should redirect back to Provider, not let the user sit on
    // a step that has no prerequisites met.
    vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 0 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 2 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument());
  });

  it('Resume: saved progress at Defaults reopens on Defaults', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 1 }));

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 1 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 2 of 4/i)).toBeInTheDocument());
  });

  it('Surfaces a friendly probing-error banner when the provider check fails', async () => {
    // When the wizard's fresh-install probe fetch throws (network drop,
    // CORS misconfiguration, etc.) the wizard shouldn't blank out — it
    // shows a muted banner telling the operator they can still walk the
    // wizard manually. Without this branch covered, a deploy gone wrong
    // on the discovery endpoint would land an empty dialog.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        // Make the wizard's own probe fail; allow detection fetches to
        // resolve so StepProvider can still render its content.
        if (url.includes('/providers/detect')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { detected: [] } }),
          });
        }
        if (url.includes('/providers')) {
          return Promise.reject(new Error('Network down'));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      })
    );

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    expect(await screen.findByText(/Could not check your current setup/i)).toBeInTheDocument();
    // Wizard still snaps to Step 1 (Provider) — the manual walk-through
    // remains the fallback path.
    expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument();
  });

  it('paginatedTotalGt0 returns false on non-OK provider response (treated as fresh)', async () => {
    // The probe helper short-circuits to `false` when the providers
    // fetch returns HTTP 4xx/5xx without reading the body. Covers the
    // `if (!res.ok) return false` branch in `paginatedTotalGt0`.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/providers/detect')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { detected: [] } }),
          });
        }
        if (url.includes('/providers')) {
          // Non-OK response — paginatedTotalGt0 returns false, treating
          // the install as fresh.
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({}),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      })
    );

    // Persisted state points beyond Provider — with a non-OK probe the
    // wizard should still snap back to Provider since hasProvider=false.
    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 2 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument());
  });

  it('paginatedTotalGt0 returns false when provider response body fails to JSON-parse', async () => {
    // Covers the catch in `paginatedTotalGt0` — when res.json() throws
    // (truncated body, non-JSON content), treat as no providers found.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/providers/detect')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, data: { detected: [] } }),
          });
        }
        if (url.includes('/providers')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.reject(new Error('malformed JSON')),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      })
    );

    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 2 }));
    render(<SetupWizard open={true} onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument());
  });

  it('StepProvider recovers gracefully when the detection fetch throws', async () => {
    // The Step-1 component's parallel fetches (providers + detect) sit
    // inside an IIFE with its own catch. If either rejects, hasExisting
    // collapses to false and detection collapses to an empty array — the
    // manual flavour-picker fallback takes over rather than the wizard
    // hanging on a never-resolving state.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        // The wizard's top-level probe still resolves so the wizard
        // mounts; the StepProvider's parallel fetches both fail and
        // the IIFE's catch sets the fallback state.
        if (url.includes('/providers/detect')) {
          return Promise.reject(new Error('detect endpoint offline'));
        }
        if (url.includes('/providers')) {
          // First call (probe) ok with 0 providers; subsequent calls
          // from StepProvider also reject.
          return Promise.reject(new Error('providers endpoint offline'));
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      })
    );

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    // The wizard still renders Step 1 even though both Step-1 fetches
    // failed — the manual flavour-picker path is the IIFE catch's
    // fallback. Probing-error banner surfaces from the top-level probe.
    await waitFor(() => {
      expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Could not check your current setup/i)).toBeInTheDocument();
  });

  it('Step indicator shows a clickable trail of completed steps', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ providerTotal: 1 }));
    const user = userEvent.setup();

    // Open at step 3 (smoke test) — provider configured, defaults set.
    window.localStorage.setItem(STORAGE_KEY, makeStoredState({ stepIndex: 2 }));

    render(<SetupWizard open={true} onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Step 3 of 4/i)).toBeInTheDocument());

    const ol = screen.getByLabelText(/setup progress/i);
    const buttons = ol.querySelectorAll('button');
    expect(buttons).toHaveLength(4);

    // Steps 0 and 1 are completed (clickable). Step 2 (current) and Step 3 (upcoming) are disabled.
    expect(buttons[0]).not.toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();
    expect(buttons[2]).toBeDisabled();
    expect(buttons[3]).toBeDisabled();

    // Clicking a completed step jumps the wizard back to it.
    await user.click(buttons[0]);
    await waitFor(() => expect(screen.getByText(/Step 1 of 4/i)).toBeInTheDocument());
  });
});
