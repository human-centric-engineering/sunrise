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
