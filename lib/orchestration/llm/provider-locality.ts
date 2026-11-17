/**
 * Whether a provider row builds a local client: one rule for the provider
 * manager, the model for confidential messages' check (§130 t-1038) and the
 * settings page that lists the models it may be.
 *
 * A Voyage row never does: its `isLocal` decides only whether its `baseUrl`
 * may be on loopback.
 */
export function buildsLocalClient(config: { isLocal: boolean; providerType: string }): boolean {
  return config.isLocal && config.providerType !== 'voyage';
}
