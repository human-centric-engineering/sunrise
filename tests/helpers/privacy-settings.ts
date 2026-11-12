/**
 * Settings for a test that runs the real provider manager but is not about the
 * LLM privacy layer (§127).
 *
 * The privacy stage reads the install's privacy settings on every chat and
 * embedding call, and refuses a call when it cannot. A test whose database
 * mock has no settings row stubs the settings read with these: mode `off`, no
 * global budget. The stage still runs, and in `off` makes no change; it has
 * its own tests (`privacy-stage.test.ts`, `provider-manager.privacy.test.ts`).
 *
 * Usage, inside the `vi.mock` factory (a factory cannot see a top-level
 * import):
 *
 *   vi.mock('@/lib/orchestration/settings', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@/lib/orchestration/settings')>()),
 *     getOrchestrationSettings: vi.fn(async () =>
 *       (await import('@/tests/helpers/privacy-settings')).privacyOffSettings()
 *     ),
 *   }));
 */
export function privacyOffSettings() {
  return {
    globalMonthlyBudgetUsd: null,
    privacyMode: 'off' as const,
    privacyIgnoredEntityTypes: [] as string[],
    privacyProtectLocalProviders: false,
    privacyEmbeddingsPolicy: 'allow' as const,
  };
}

/**
 * Core's agent-and-org privacy resolver (t-1010), reading nothing: for a test
 * that runs the real provider manager, is not about the LLM privacy layer,
 * and counts or scripts the database reads the resolver would add (it reads
 * the call's agent and org once per privacy scope).
 *
 * Usage, inside the `vi.mock` factory:
 *
 *   vi.mock('@/lib/orchestration/privacy/scope-settings', async (importOriginal) =>
 *     (await import('@/tests/helpers/privacy-settings')).scopeSettingsReadingNothing(
 *       await importOriginal()
 *     )
 *   );
 */
export function scopeSettingsReadingNothing<T extends object>(real: T) {
  const nothing = { agentMode: null, orgMinimumMode: null, protectedTerms: [] };
  return {
    ...real,
    scopePrivacySettings: async () => nothing,
    scopeSettingsResolver: () => ({ id: 'core.scope-settings', resolve: () => undefined }),
  };
}
