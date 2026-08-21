/**
 * Monitoring Validation Schemas
 *
 * Zod schemas mirroring the response shapes in `lib/monitoring/types.ts`.
 * These exist for **runtime validation at boundaries** — places where
 * untrusted bytes (a fetch response, an external monitoring probe) are
 * parsed into the static `HealthCheckResponse` type.
 *
 * The TypeScript interface (`HealthCheckResponse`) and this Zod schema must
 * stay in sync. The `z.infer<>` type is exported alongside so a caller can
 * verify equivalence at compile time via a `satisfies` check.
 */

import { z } from 'zod';

/**
 * Individual service health, mirrors `ServiceHealth` in lib/monitoring/types.ts
 */
export const serviceHealthSchema = z.object({
  status: z.enum(['operational', 'degraded', 'outage']),
  connected: z.boolean(),
  latency: z.number().optional(),
  error: z.string().optional(),
});

/**
 * Memory usage block, mirrors `MemoryUsage` in lib/monitoring/types.ts
 */
export const memoryUsageSchema = z.object({
  heapUsed: z.number(),
  heapTotal: z.number(),
  rss: z.number(),
  percentage: z.number(),
});

/**
 * Health-check response envelope, mirrors `HealthCheckResponse`.
 *
 * Use `healthCheckResponseSchema.parse(...)` to validate an untrusted
 * payload (e.g. a `fetch('/api/health')` response body) — the result is
 * typed and the parse throws ZodError on shape drift, which is what we
 * want at the client/server boundary instead of a silent bare `as` cast.
 */
export const healthCheckResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  version: z.string(),
  uptime: z.number(),
  timestamp: z.string(),
  services: z.object({
    database: serviceHealthSchema,
  }),
  memory: memoryUsageSchema.optional(),
  error: z.string().optional(),
});

/**
 * The inferred type — equivalent to `HealthCheckResponse` from
 * `lib/monitoring/types.ts`. A `satisfies` check in tests verifies the
 * two stay in sync.
 */
export type HealthCheckResponseSchema = z.infer<typeof healthCheckResponseSchema>;
