/**
 * Unit Test: Embed Widget JavaScript Loader
 *
 * GET /api/v1/embed/widget.js
 *
 * Public route — no authentication. Serves a self-contained JS widget
 * configured via data attributes on the script tag.
 *
 * @see app/api/v1/embed/widget.js/route.ts
 */

import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/v1/embed/widget.js/route';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGetRequest(url = 'https://example.com/api/v1/embed/widget.js'): NextRequest {
  return new NextRequest(url);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/v1/embed/widget.js', () => {
  it('returns Content-Type application/javascript', () => {
    const response = GET(makeGetRequest());

    expect(response.headers.get('Content-Type')).toContain('application/javascript');
  });

  it('returns Cache-Control with max-age=300', () => {
    const response = GET(makeGetRequest());

    expect(response.headers.get('Cache-Control')).toContain('max-age=300');
  });

  it('returns Access-Control-Allow-Origin: *', () => {
    const response = GET(makeGetRequest());

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('response body includes "use strict"', async () => {
    const response = GET(makeGetRequest());
    const body = await response.text();

    expect(body).toContain("'use strict'");
  });

  it('response body includes the request origin as apiBase', async () => {
    const response = GET(makeGetRequest('https://myapp.example.com/api/v1/embed/widget.js'));
    const body = await response.text();

    expect(body).toContain('https://myapp.example.com/api/v1/embed');
  });

  it('response body includes data-token attribute reference', async () => {
    const response = GET(makeGetRequest());
    const body = await response.text();

    expect(body).toContain('data-token');
  });

  it('response body includes X-Embed-Token header reference', async () => {
    const response = GET(makeGetRequest());
    const body = await response.text();

    expect(body).toContain('X-Embed-Token');
  });

  it('returns 200 status', () => {
    const response = GET(makeGetRequest());

    expect(response.status).toBe(200);
  });
});
