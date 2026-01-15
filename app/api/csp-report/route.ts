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
import { logger } from '@/lib/logging';

/**
 * CSP Violation Report structure
 * @see https://w3c.github.io/webappsec-csp/#violation-report
 */
interface CSPReport {
  'csp-report'?: {
    'document-uri'?: string;
    referrer?: string;
    'violated-directive'?: string;
    'effective-directive'?: string;
    'original-policy'?: string;
    'blocked-uri'?: string;
    'status-code'?: number;
    'source-file'?: string;
    'line-number'?: number;
    'column-number'?: number;
  };
}

/**
 * POST /api/csp-report
 *
 * Receives CSP violation reports from browsers.
 * Logs violations for security monitoring and policy refinement.
 *
 * @param request - Incoming request with CSP report JSON body
 * @returns 204 No Content on success
 */
export async function POST(request: NextRequest) {
  try {
    // Parse the CSP report
    const report = (await request.json()) as CSPReport;
    const violation = report['csp-report'];

    if (!violation) {
      // Invalid report format, silently accept
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
export function OPTIONS() {
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
