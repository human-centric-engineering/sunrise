import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseHealth } from '@/lib/db/utils';
import { getRouteLogger } from '@/lib/api/context';
import { getMemoryUsage } from '@/lib/monitoring';
import type { HealthCheckResponse, ServiceStatus } from '@/lib/monitoring';

/**
 * Cache the version at module load time to avoid reading package.json on every request.
 * This is safe because the version doesn't change during runtime.
 */
const APP_VERSION = process.env.npm_package_version || '1.0.0';

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
 *   version: string,
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
export async function GET(request: NextRequest) {
  const log = await getRouteLogger(request);

  try {
    const dbHealth = await getDatabaseHealth();
    const dbStatus = determineServiceStatus(dbHealth.connected, dbHealth.latency);

    // Build response
    const response: HealthCheckResponse = {
      status: dbHealth.connected ? 'ok' : 'error',
      version: APP_VERSION,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      services: {
        database: {
          status: dbStatus,
          connected: dbHealth.connected,
          ...(dbHealth.latency !== undefined && { latency: dbHealth.latency }),
        },
      },
    };

    // Optionally include memory usage
    if (shouldIncludeMemory()) {
      response.memory = getMemoryUsage();
    }

    // Return 503 Service Unavailable if database is not connected
    if (!dbHealth.connected) {
      return NextResponse.json(response, { status: 503 });
    }

    return NextResponse.json(response);
  } catch (error) {
    log.error('Health check failed', error);

    // Build error response with same structure
    const errorResponse: HealthCheckResponse = {
      status: 'error',
      version: APP_VERSION,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      services: {
        database: {
          status: 'outage',
          connected: false,
        },
      },
      error: error instanceof Error ? error.message : 'Unknown error',
    };

    // Optionally include memory usage even in error case
    if (shouldIncludeMemory()) {
      errorResponse.memory = getMemoryUsage();
    }

    return NextResponse.json(errorResponse, { status: 503 });
  }
}
