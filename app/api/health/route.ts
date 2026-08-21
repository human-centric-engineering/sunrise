import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseHealth } from '@/lib/db/utils';
import { getRouteLogger } from '@/lib/api/context';
import { getMemoryUsage } from '@/lib/monitoring';
import type { HealthCheckResponse, ServiceStatus } from '@/lib/monitoring';
import { APP_VERSION } from '@/lib/app-version';

/**
 * Check if memory should be included in health response
 * Default: false (security consideration in production)
 */
function shouldIncludeMemory(): boolean {
  return process.env.HEALTH_INCLUDE_MEMORY === 'true';
}

/**
 * Determine service status based on health metrics
 */
function determineServiceStatus(connected: boolean, latency?: number): ServiceStatus {
  if (!connected) {
    return 'outage';
  }

  // Consider latency > 500ms as degraded performance
  if (latency !== undefined && latency > 500) {
    return 'degraded';
  }

  return 'operational';
}

/**
 * Build the health response payload.
 *
 * Centralises the response-shape construction so `version`, uptime, timestamp,
 * and the memory toggle live in ONE place — the success and error branches both
 * call through here. Adding a new top-level field to the contract means one
 * edit, not two.
 *
 * **The Sunrise platform version is deliberately not here.** This endpoint is
 * unauthenticated — load balancers and container orchestrators probe it — so
 * anything it returns is returned to anyone. `SUNRISE_VERSION` names the exact
 * upstream release a deployment runs, and therefore the exact set of published
 * issues to try against it, across every Sunrise-derived deployment rather than
 * just this one. It is served from `GET /api/v1/admin/stats` instead, behind
 * `withAdminAuth`, and rendered on `/admin/overview` — the operator who needs
 * it can see it, and an anonymous caller cannot (#531).
 *
 * `version` (the fork's own `package.json` version) stays: it is the fork's
 * number to disclose, means nothing outside that fork, and container health
 * checks and deploy-verification scripts read it.
 */
function buildHealthPayload(params: {
  status: 'ok' | 'error';
  database: HealthCheckResponse['services']['database'];
  error?: string;
}): HealthCheckResponse {
  const payload: HealthCheckResponse = {
    status: params.status,
    version: APP_VERSION,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    services: {
      database: params.database,
    },
    ...(params.error !== undefined && { error: params.error }),
  };

  if (shouldIncludeMemory()) {
    payload.memory = getMemoryUsage();
  }

  return payload;
}

/**
 * Health Check Endpoint
 *
 * Returns the health status of the application and its dependencies.
 * Useful for monitoring, uptime checks, load balancers, and container orchestration.
 *
 * GET /api/health
 *
 * Response format:
 * {
 *   status: 'ok' | 'error',
 *   version: string,        // fork's app version (package.json)
 *   uptime: number,
 *   timestamp: string,
 *   services: {
 *     database: {
 *       status: 'operational' | 'degraded' | 'outage',
 *       connected: boolean,
 *       latency?: number
 *     }
 *   },
 *   memory?: {
 *     heapUsed: number,
 *     heapTotal: number,
 *     rss: number,
 *     percentage: number
 *   }
 * }
 *
 * Environment variables:
 * - HEALTH_INCLUDE_MEMORY: Set to 'true' to include memory stats (default: false)
 *
 * HTTP Status Codes:
 * - 200: All services operational
 * - 503: One or more services unavailable
 */
export async function GET(request: NextRequest): Promise<Response> {
  const log = await getRouteLogger(request);

  try {
    const dbHealth = await getDatabaseHealth();
    const dbStatus = determineServiceStatus(dbHealth.connected, dbHealth.latency);

    const response = buildHealthPayload({
      status: dbHealth.connected ? 'ok' : 'error',
      database: {
        status: dbStatus,
        connected: dbHealth.connected,
        ...(dbHealth.latency !== undefined && { latency: dbHealth.latency }),
      },
    });

    // 503 Service Unavailable if the database is not connected
    return NextResponse.json(response, { status: dbHealth.connected ? 200 : 503 });
  } catch (error) {
    log.error('Health check failed', error);

    const errorResponse = buildHealthPayload({
      status: 'error',
      database: { status: 'outage', connected: false },
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return NextResponse.json(errorResponse, { status: 503 });
  }
}
