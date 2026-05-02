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

  // ─── SSE Parser & Event Handling ────────────────────────────────────────────

  it('uses block-based SSE parsing (split on \\n\\n)', async () => {
    const body = await GET(makeGetRequest()).text();

    // Must split by \n\n (block separator), not just \n (line separator)
    expect(body).toContain("buffer.split('\\n\\n')");
    // Must join data lines before JSON.parse
    expect(body).toContain("dataLines.join('\\n')");
  });

  it('extracts event type from event: header line', async () => {
    const body = await GET(makeGetRequest()).text();

    // Must read the event: line to determine type
    expect(body).toContain("line.indexOf('event:') === 0");
    expect(body).toContain('line.slice(6).trim()');
  });

  it('handles content_reset event for provider fallback', async () => {
    const body = await GET(makeGetRequest()).text();

    expect(body).toContain("evt.type === 'content_reset'");
  });

  it('handles done event for explicit stream completion', async () => {
    const body = await GET(makeGetRequest()).text();

    expect(body).toContain("evt.type === 'done'");
  });

  it('handles status event for progress indication', async () => {
    const body = await GET(makeGetRequest()).text();

    expect(body).toContain("evt.type === 'status'");
  });

  it('reads delta from evt.data.delta (not evt.delta)', async () => {
    const body = await GET(makeGetRequest()).text();

    // Must access data.delta from the parsed block, not raw evt.delta
    expect(body).toContain('evt.data.delta');
  });

  it('supports AbortController for stream cancellation', async () => {
    const body = await GET(makeGetRequest()).text();

    expect(body).toContain('new AbortController()');
    expect(body).toContain('signal: controller.signal');
  });

  it('new chat button resets sending state', async () => {
    const body = await GET(makeGetRequest()).text();

    // The new-chat handler must reset sending state to avoid stuck UI
    expect(body).toContain('sending = false');
    expect(body).toContain('sendBtn.disabled = false');
    // Must also abort active stream
    expect(body).toContain('activeAbort.abort()');
  });

  it('shows error on mid-stream reader failure', async () => {
    const body = await GET(makeGetRequest()).text();

    // Reader catch must show user-facing text, not silently fail
    expect(body).toContain('Connection lost.');
  });

  it('includes status element in widget HTML', async () => {
    const body = await GET(makeGetRequest()).text();

    expect(body).toContain('class="status"');
  });
});

describe('Embed widget citation rendering', () => {
  it('binds a handler for the `citations` SSE event', async () => {
    const response = GET(makeGetRequest());
    const body = await response.text();
    expect(body).toContain("evt.type === 'citations'");
    expect(body).toContain('renderCitations(assistantSpan, fullText, evt.data.citations)');
  });

  it('declares the renderCitations helper that builds marker chips and a sources panel', async () => {
    const response = GET(makeGetRequest());
    const body = await response.text();
    expect(body).toContain('function renderCitations(span, fullText, citations)');
    expect(body).toContain("className = 'citations-panel'");
    expect(body).toContain("className = 'cite-marker'");
  });

  it('uses createElement + textContent (no innerHTML) for citation rendering', async () => {
    const response = GET(makeGetRequest());
    const body = await response.text();
    // Locate the renderCitations function body — assertion is on the
    // sub-function only, since the surrounding widget code already
    // avoids innerHTML on user-controlled paths.
    const start = body.indexOf('function renderCitations');
    const end = body.indexOf('messagesEl.scrollTop = messagesEl.scrollHeight;', start);
    expect(start).toBeGreaterThan(-1);
    const fnBody = body.slice(start, end);
    expect(fnBody).toContain('document.createElement');
    expect(fnBody).toContain('textContent');
    expect(fnBody).not.toContain('innerHTML');
  });

  it('renders valid citation markers as focusable buttons with aria-label and scroll-on-click', async () => {
    const body = await GET(makeGetRequest()).text();
    // Valid markers use <button> so keyboard and screen-reader users
    // can reach them; invalid (hallucinated) markers stay as <span>
    // because there's no source to navigate to.
    expect(body).toContain("createElement('button')");
    expect(body).toContain("setAttribute('aria-label', 'Source ' + n)");
    expect(body).toContain("setAttribute('aria-label', 'Unmatched citation marker ' + n)");
    expect(body).toContain('scrollIntoView');
    // Each citation li carries a data-cite-id attribute matching the
    // marker so the button's click handler can locate it.
    expect(body).toContain("setAttribute('data-cite-id', String(cite.marker))");
  });

  it('does not transform [N] when the citations envelope is empty (defensive guard)', async () => {
    const body = await GET(makeGetRequest()).text();
    // Server never emits an empty citations event, but if it did, the
    // helper must not flag every [N] in fullText as hallucinated.
    expect(body).toContain('if (!citations || citations.length === 0) return;');
  });

  it('removes any orphaned citations panel when an error event fires after citations', async () => {
    const body = await GET(makeGetRequest()).text();
    // If `done` throws after citations were emitted, the error handler
    // re-fires; the bubble's textContent is reset but the panel must
    // also be removed so the user does not see "Something went wrong"
    // sitting next to a hanging sources list.
    expect(body).toContain("bubbleDiv.querySelector('.citations-panel')");
    expect(body).toContain('orphanPanel.remove()');
  });
});
