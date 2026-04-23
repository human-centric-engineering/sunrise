/**
 * Public barrel for `lib/orchestration/capabilities/`.
 *
 * Callers go through `capabilityDispatcher` and
 * `registerBuiltInCapabilities` — the built-in capability classes
 * themselves are intentionally not re-exported.
 */

export * from '@/lib/orchestration/capabilities/types';
export {
  BaseCapability,
  CapabilityValidationError,
} from '@/lib/orchestration/capabilities/base-capability';
export { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
export {
  registerBuiltInCapabilities,
  getCapabilityDefinitions,
} from '@/lib/orchestration/capabilities/registry';
