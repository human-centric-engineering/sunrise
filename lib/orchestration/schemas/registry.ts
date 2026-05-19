/**
 * Schema registry — named Zod schemas that workflow steps reference
 * by string slug.
 *
 * Why a registry?
 *
 * Workflows are JSON documents persisted in the database; they cannot
 * carry executable Zod code directly. To let a step author "validate
 * this output against a known shape", we expose a registry of
 * Zod schemas keyed by stable string slugs. A workflow step references
 * the schema by `schemaName`; the executor looks it up here at run
 * time.
 *
 * Mirrors the executor-registry pattern (`lib/orchestration/engine/
 * executor-registry.ts`): schemas register themselves on import via
 * side-effect, and feature code imports the schemas-barrel module
 * once at process start to populate the registry.
 *
 * **The registry ships empty.** Sunrise itself does not register any
 * built-in schemas — that would couple the engine to specific
 * workflow domains. Workflow authors register their own schemas in
 * feature modules (`lib/orchestration/<feature>/schemas.ts`) and
 * ensure those modules are imported on app start.
 *
 * Concurrency note: registration happens at module load, before
 * requests are served. The Map is read at run time but never mutated
 * during a request, so no locking is needed.
 */

import type { z } from 'zod';

const REGISTRY = new Map<string, z.ZodTypeAny>();

/**
 * Register a schema under a stable slug. Calling twice with the same
 * slug throws — registration is meant to happen at module load and
 * silent overwrites would mask import-order bugs that swap schemas
 * out from under live executors.
 */
export function registerSchema(name: string, schema: z.ZodTypeAny): void {
  if (!name || typeof name !== 'string') {
    throw new Error('registerSchema: name must be a non-empty string');
  }
  if (REGISTRY.has(name)) {
    throw new Error(
      `registerSchema: a schema named "${name}" is already registered — registration is meant to happen at module load. If you need to override at runtime, call \`unregisterSchema\` first (test-only).`
    );
  }
  REGISTRY.set(name, schema);
}

/**
 * Resolve a registered schema by name, or `undefined` when no schema
 * is registered under that slug. Executors are expected to surface
 * the "not found" case to operators (an admin authored a workflow
 * referencing a schema that wasn't registered), not silently
 * fall back.
 */
export function getSchema(name: string): z.ZodTypeAny | undefined {
  return REGISTRY.get(name);
}

/** True when a schema with this slug is registered. */
export function hasSchema(name: string): boolean {
  return REGISTRY.has(name);
}

/**
 * Snapshot of every registered slug. Useful for admin UI surfaces
 * that want to offer a Select widget over registered schemas, and
 * for diagnostics.
 */
export function listSchemaNames(): string[] {
  return [...REGISTRY.keys()].sort();
}

/**
 * Test-only escape hatch. Removes a previously-registered schema so
 * tests can re-register variants without process restart. The
 * production code path uses module-load registration once.
 */
export function unregisterSchema(name: string): boolean {
  return REGISTRY.delete(name);
}

/**
 * Test-only. Clears the entire registry. Use in `beforeEach` when a
 * test suite registers its own schemas and you want a clean slate.
 */
export function resetSchemaRegistry(): void {
  REGISTRY.clear();
}
