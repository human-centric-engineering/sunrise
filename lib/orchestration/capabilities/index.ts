/**
 * Public barrel for `lib/orchestration/capabilities/`.
 *
 * Callers go through `capabilityDispatcher` and
 * `registerBuiltInCapabilities` — the built-in capability classes
 * themselves are intentionally not re-exported. Apps add their own tools
 * via `registerAppCapability` (extend `BaseCapability`).
 */

export * from '@/lib/orchestration/capabilities/types';
export {
  BaseCapability,
  CapabilityValidationError,
} from '@/lib/orchestration/capabilities/base-capability';
export {
  capabilityDispatcher,
  // The workflow-label seam. Exported because a fork writing its own executor
  // must MINT the label through `workflowAgentId()` rather than re-inlining
  // `workflow:${id}` — the executor and the dispatcher holding two copies of
  // that template is exactly what #528 was.
  WORKFLOW_AGENT_ID_PREFIX,
  workflowAgentId,
  isWorkflowAgentId,
} from '@/lib/orchestration/capabilities/dispatcher';
export {
  SEED_OWNED_CAPABILITY_FIELDS,
  changedSeedOwnedFields,
  type SeedOwnedCapabilityField,
  type SeedOwnedCapabilityValues,
} from '@/lib/orchestration/capabilities/seed-owned';
export {
  registerBuiltInCapabilities,
  registerAppCapability,
  registerAppCapabilities,
  getCapabilityDefinitions,
} from '@/lib/orchestration/capabilities/registry';
