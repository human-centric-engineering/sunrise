import { NextResponse } from 'next/server'
import { getDatabaseHealth } from '@/lib/db/utils'

/**
 * Health Check Endpoint
 *
 * Returns the health status of the application and its dependencies.
 * Useful for monitoring, uptime checks, and verifying database connectivity.
 *
 * GET /api/health
 *
 * Returns:
 * {
 *   status: 'ok' | 'error',
 *   timestamp: string,
 *   database: {
 *     connected: boolean,
 *     latency?: number
 *   }
 * }
 */
export async function GET() {
  try {
    const dbHealth = await getDatabaseHealth()

    const response = {
      status: dbHealth.connected ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      database: {
        connected: dbHealth.connected,
        ...(dbHealth.latency !== undefined && { latency: dbHealth.latency }),
      },
    }

    // Return 503 Service Unavailable if database is not connected
    if (!dbHealth.connected) {
      return NextResponse.json(response, { status: 503 })
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('Health check failed:', error)

    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        database: {
          connected: false,
        },
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 503 }
    )
  }
}
