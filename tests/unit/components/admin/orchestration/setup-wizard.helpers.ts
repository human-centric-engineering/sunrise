/**
 * Shared test helpers for SetupWizard.
 *
 * Both `setup-wizard.test.tsx` (top-level navigation, step indicator,
 * snap-back) and `setup-wizard-steps.test.tsx` (per-step content +
 * API contracts) reach through the same localStorage key and the same
 * fetch surface. Keeping the storage key and the fetch URL routing in
 * one place means a wire-format change touches one helper, not two
 * test files — and the helper's URL dispatch can grow as the wizard
 * gains new endpoints without forcing duplicate updates.
 *
 * Not a runtime fixture — this file exports plain functions and is
 * imported only from test files.
 */

import { vi } from 'vitest';

/**
 * localStorage key used by SetupWizard for resume state. Bumped any
 * time the persisted shape changes (current: v3).
 */
export const STORAGE_KEY = 'sunrise.orchestration.setup-wizard.v3';

/**
 * Detection row shape — mirrors `DetectionRow` in
 * `components/admin/orchestration/setup-wizard.tsx`. Optional fields
 * default to null/false in `makeFetchMock` so callers can pass a
 * minimal subset.
 */
export interface DetectionRowFixture {
  slug: string;
  name: string;
  providerType: 'anthropic' | 'openai-compatible' | 'voyage';
  defaultBaseUrl: string | null;
  apiKeyEnvVar: string | null;
  primaryEnvVar?: string | null;
  apiKeyPresent: boolean;
  alreadyConfigured: boolean;
  isLocal: boolean;
  suggestedDefaultChatModel: string | null;
  suggestedRoutingModel: string | null;
  suggestedReasoningModel: string | null;
  suggestedEmbeddingModel: string | null;
}

/**
 * Provider summary returned by GET /providers. Subset of the full
 * AiProviderConfig shape — only fields the wizard reads.
 */
export interface ProviderRowFixture {
  id: string;
  slug: string;
  name: string;
  isLocal?: boolean;
  apiKeyPresent?: boolean;
  /**
   * Optional in test fixtures (older tests don't care). The default in
   * `makeFetchMock` is `true` so providers count as active and
   * `DefaultModelsForm` renders its dropdowns rather than the
   * "no providers configured" CTA.
   */
  isActive?: boolean;
}

export interface MakeFetchMockOptions {
  /** Pagination meta.total returned by GET /providers. */
  providerTotal?: number;
  /** Full list returned by GET /providers (overrides providerTotal-derived list). */
  providers?: ProviderRowFixture[];
  /** Rows returned by GET /providers/detect. */
  detected?: DetectionRowFixture[];
  /** Whether POST /providers (create) succeeds. */
  postProviderOk?: boolean;
  /** Result returned by POST /providers/:id/test. */
  providerTestOk?: boolean;
  /** Whether POST /providers/:id/test HTTP response is ok (default true). */
  providerTestHttpOk?: boolean;
  /** Result returned by POST /providers/:id/test-model. */
  providerTestModelOk?: boolean;
  /** Whether POST /providers/:id/test-model HTTP response is ok (default true). */
  providerTestModelHttpOk?: boolean;
  /** Models returned by GET /models. */
  models?: Array<{ id: string; provider: string }>;
  /** defaultModels echoed back by GET /settings. */
  defaultModels?: Record<string, string>;
}

/**
 * Build a `fetch` mock that dispatches by URL across every endpoint
 * the wizard reaches. Order-sensitive matchers (e.g. `/test-model`
 * must come before `/test`) are encoded here so callers don't have to
 * worry about regex specificity.
 */
export function makeFetchMock(opts: MakeFetchMockOptions = {}) {
  const {
    providerTotal = 0,
    providers,
    detected = [],
    postProviderOk = true,
    providerTestOk = true,
    providerTestHttpOk = true,
    providerTestModelOk = true,
    providerTestModelHttpOk = true,
    models = [],
    defaultModels = {},
  } = opts;

  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : '';

    if (u.includes('/providers/detect')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { detected } }),
      });
    }

    // Test-model BEFORE test — `/test-model` is a prefix-of-suffix
    // match that would otherwise be swallowed by the generic /test
    // arm.
    if (u.match(/\/providers\/[^/]+\/test-model/) && init?.method === 'POST') {
      if (!providerTestModelHttpOk) {
        return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, data: { ok: providerTestModelOk, latencyMs: 42 } }),
      });
    }

    if (u.match(/\/providers\/[^/]+\/test/) && init?.method === 'POST') {
      if (!providerTestHttpOk) {
        return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { ok: providerTestOk } }),
      });
    }

    if (init?.method === 'POST' && u.includes('/providers')) {
      if (!postProviderOk) {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({ success: false, error: { code: 'VALIDATION', message: 'bad' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: { id: 'prov-1' } }),
      });
    }

    if (u.includes('/providers')) {
      const raw: ProviderRowFixture[] =
        providers ??
        Array.from({ length: providerTotal }, (_, i) => ({
          id: `id-${i}`,
          slug: `p${i}`,
          name: `Provider ${i}`,
          isLocal: false,
          apiKeyPresent: true,
        }));
      // Default `isActive: true` so the DefaultModelsForm rendered
      // inside the wizard doesn't mistake every fixture row for an
      // inactive provider and short-circuit to the "no providers"
      // CTA. Tests that need an inactive row can set it explicitly.
      const data = raw.map((p) => ({ isActive: true, ...p }));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data, meta: { total: providerTotal } }),
      });
    }

    if (init?.method === 'PATCH' && u.includes('/settings')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: {} }),
      });
    }

    if (u.includes('/settings')) {
      // Provide both the hydrated `defaultModels` (suggestion source)
      // and the operator-saved `defaultModelsStored` (form value
      // source) — DefaultModelsForm reads them separately so the
      // wizard step pre-fills correctly in tests.
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { defaultModels, defaultModelsStored: defaultModels },
          }),
      });
    }

    // Matrix-driven chat / audio rows used by DefaultModelsForm. The
    // wizard's StepDefaultModels hits `/provider-models?capability=chat`
    // and `/provider-models?capability=audio`; reshape the `models`
    // fixture into the matrix row shape so the same fixture serves
    // both endpoints. `/embedding-models` returns an empty list by
    // default — tests that need embeddings pass `embeddingModels`.
    if (u.includes('/provider-models')) {
      const data = models.map((m) => ({
        modelId: m.id,
        name: m.id,
        providerSlug: m.provider,
        tierRole: 'worker',
      }));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data }),
      });
    }

    if (u.includes('/embedding-models')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      });
    }

    if (u.includes('/models')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: models }),
      });
    }

    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

/**
 * Persist a stored wizard state at the canonical STORAGE_KEY. Defaults
 * mirror a fresh install: stepIndex 0 with empty providerDraft.
 */
export function seedStorage(stepIndex = 0, overrides: Record<string, unknown> = {}): void {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      stepIndex,
      providerDraft: {
        name: '',
        slug: '',
        apiKeyEnvVar: '',
        providerType: '',
        baseUrl: '',
        suggestedDefaultChatModel: '',
        suggestedEmbeddingModel: '',
      },
      ...overrides,
    })
  );
}

/**
 * Build the same JSON state seedStorage would write, without writing
 * it. Useful for tests that want to assert against the stored shape
 * or inject custom localStorage timing.
 */
export function makeStoredState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    stepIndex: 0,
    providerDraft: {
      name: '',
      slug: '',
      apiKeyEnvVar: '',
      providerType: '',
      baseUrl: '',
      suggestedDefaultChatModel: '',
      suggestedEmbeddingModel: '',
    },
    ...overrides,
  });
}
