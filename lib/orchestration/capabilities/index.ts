/**
 * Public barrel for `lib/orchestration/capabilities/`.
 *
 * Callers go through `capabilityDispatcher` and
 * `registerBuiltInCapabilities` — the built-in capability classes
 * themselves are intentionally not re-exported.
 */

export * from './types';
export { BaseCapability, CapabilityValidationError } from './base-capability';
export { capabilityDispatcher } from './dispatcher';
export { registerBuiltInCapabilities, getCapabilityDefinitions } from './registry';
