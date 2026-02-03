/**
 * CSP Violation Report Endpoint
 *
 * Receives Content-Security-Policy violation reports from browsers.
 * When a CSP violation occurs, browsers send a JSON report to this endpoint.
 *
 * This is useful for:
 * - Monitoring CSP violations in production
 * - Identifying overly restrictive CSP policies
 * - Detecting potential XSS attempts
 *
 * The CSP header includes: report-uri /api/csp-report
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
 * @see .context/security/csp.md for CSP configuration details
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logging';
import { cspReportLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

/**
 * Zod schema for CSP violation reports
 *
 * Validates and constrains field sizes to prevent log flooding
 * with arbitrarily large payloads.
 */
const cspViolationSchema = z.object({
  'document-uri': z.string().max(2048).optional(),
  referrer: z.string().max(2048).optional(),
  'violated-directive': z.string().max(500).optional(),
  'effective-directive': z.string().max(500).optional(),
  'original-policy': z.string().max(5000).optional(),
  'blocked-uri': z.string().max(2048).optional(),
  'status-code': z.number().int().min(0).max(999).optional(),
  'source-file': z.string().max(2048).optional(),
  'line-number': z.number().int().min(0).optional(),
  'column-number': z.number().int().min(0).optional(),
});

const cspReportSchema = z.object({
  'csp-report': cspViolationSchema.optional(),
});

/**
 * POST /api/csp-report
 *
 * Receives CSP violation reports from browsers.
 * Logs violations for security monitoring and policy refinement.
 *
 * @param request - Incoming request with CSP report JSON body
 * @returns 204 No Content on success
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    // Rate limit to prevent log flooding
    const clientIP = getClientIP(request);
    const rateLimitResult = cspReportLimiter.check(clientIP);

    if (!rateLimitResult.success) {
      return createRateLimitResponse(rateLimitResult);
    }

    // Parse and validate the CSP report
    const rawBody: unknown = await request.json();
    const parseResult = cspReportSchema.safeParse(rawBody);

    if (!parseResult.success) {
      // Invalid report format, silently accept (don't expose validation details)
      return new Response(null, { status: 204 });
    }

    const violation = parseResult.data['csp-report'];

    if (!violation) {
      // No violation data, silently accept
      return new Response(null, { status: 204 });
    }

    // Log the violation with structured data
    logger.warn('CSP Violation', {
      type: 'csp-violation',
      documentUri: violation['document-uri'],
      violatedDirective: violation['violated-directive'],
      effectiveDirective: violation['effective-directive'],
      blockedUri: violation['blocked-uri'],
      sourceFile: violation['source-file'],
      lineNumber: violation['line-number'],
      columnNumber: violation['column-number'],
      userAgent: request.headers.get('user-agent'),
    });

    // Return 204 No Content (standard response for report endpoints)
    return new Response(null, { status: 204 });
  } catch {
    // Silently accept malformed reports (don't expose internal errors)
    // Malformed reports could be from:
    // - Old browsers with different report formats
    // - Network issues corrupting the payload
    // - Attackers probing the endpoint
    return new Response(null, { status: 204 });
  }
}

/**
 * OPTIONS /api/csp-report
 *
 * Handle CORS preflight for CSP reports.
 * Browsers may send preflight requests before sending violation reports.
 */
export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      // Allow reports from any origin (browser sends reports automatically)
      'Access-Control-Allow-Origin': '*',
    },
  });
}
