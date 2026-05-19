/**
 * Schema barrel — re-exports the registry surface and imports every
 * feature-scoped schema module for its registration side-effects.
 *
 * Mirrors `lib/orchestration/engine/executor-registry.ts`'s pattern:
 * the registry itself is a module-level Map; feature modules call
 * `registerSchema(...)` at import time; consumers (the guard executor)
 * import THIS barrel rather than the bare `registry.ts` so the
 * feature modules are guaranteed to load before any consumer calls
 * `getSchema(...)`.
 *
 * Add a new feature schema:
 *   1. Create `lib/orchestration/schemas/<feature>.ts` and call
 *      `registerSchema('<slug>', zodSchema)` at module top level.
 *   2. Add a side-effect import in this file.
 *   3. Reference the slug from a workflow's `validate_*` guard
 *      step config (`mode: 'schema', schemaName: '<slug>'`).
 *
 * The registry ships empty by Sunrise itself — feature modules add
 * their own. The bare `registry.ts` module is still importable for
 * tests that want to register ephemeral schemas without triggering
 * the feature-module side effects.
 */

// Re-exports — the registry surface is what consumers actually call.
export {
  getSchema,
  hasSchema,
  listSchemaNames,
  registerSchema,
  resetSchemaRegistry,
  unregisterSchema,
} from '@/lib/orchestration/schemas/registry';

// Side-effect imports: each module's top-level `registerSchema(...)`
// runs the first time this barrel is loaded into a Node process.
// Order doesn't matter (each module owns a unique slug).
import '@/lib/orchestration/schemas/audit-proposals';
