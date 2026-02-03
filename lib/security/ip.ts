/**
 * Client IP Extraction
 *
 * Consolidated utility for extracting client IP addresses from requests.
 * Used primarily for rate limiting and security logging.
 *
 * Validates extracted values to prevent arbitrary string injection
 * that could bypass rate limiting (e.g., attacker sends a unique
 * X-Forwarded-For value with each request to get a fresh rate limit bucket).
 *
 * IMPORTANT: In production, ensure your reverse proxy (nginx, Cloudflare, etc.)
 * strips and re-sets the X-Forwarded-For header to prevent client spoofing.
 * Without this, clients can still send valid-looking IPs to bypass rate limits.
 *
 * @example
 * ```typescript
 * import { getClientIP } from '@/lib/security/ip';
 *
 * export async function POST(request: NextRequest) {
 *   const clientIP = getClientIP(request);
 *   const result = rateLimiter.check(clientIP);
 *   // ...
 * }
 * ```
 */

import type { NextRequest } from 'next/server';

/** Fallback IP for development / when no valid IP is found */
const DEFAULT_IP = '127.0.0.1';

/**
 * Basic IPv4 format validation.
 * Matches patterns like "192.168.1.1" or "10.0.0.1".
 * Does not validate octet ranges (0-255) — this is intentional since
 * the goal is to reject non-IP strings, not validate routable addresses.
 */
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Basic IPv6 format validation.
 * Matches hex groups separated by colons, including compressed forms (::).
 */
const IPV6_PATTERN = /^[0-9a-fA-F:]+$/;

/**
 * Validate that a string looks like an IP address.
 *
 * Prevents arbitrary strings (e.g., "malicious-payload") from being
 * used as rate limit keys, which would give each crafted value its
 * own rate limit bucket.
 */
export function isValidIP(value: string): boolean {
  return IPV4_PATTERN.test(value) || IPV6_PATTERN.test(value);
}

/**
 * Extract client IP address from a NextRequest.
 *
 * Checks common proxy headers in priority order:
 * 1. `X-Forwarded-For` — most common (load balancers, reverse proxies)
 * 2. `X-Real-IP` — nginx default
 *
 * Falls back to `127.0.0.1` if no valid IP is found in headers.
 *
 * @param request - The incoming NextRequest
 * @returns Client IP address string
 */
export function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // X-Forwarded-For format: "client, proxy1, proxy2"
    // The first entry is the original client IP
    const ip = forwarded.split(',')[0].trim();
    if (isValidIP(ip)) return ip;
  }

  const realIP = request.headers.get('x-real-ip');
  if (realIP) {
    const ip = realIP.trim();
    if (isValidIP(ip)) return ip;
  }

  return DEFAULT_IP;
}
