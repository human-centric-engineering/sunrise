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

describe('Embed widget per-agent config (Phase 2)', () => {
  it('fetches /widget-config on boot before mounting', async () => {
    const body = await GET(makeGetRequest()).text();
    // Loader posts X-Embed-Token to /widget-config and waits for the
    // response before calling mount(). Without this the widget would
    // ignore admin-configured colours and copy.
    expect(body).toContain("fetch(apiBase + '/widget-config'");
    expect(body).toContain("'X-Embed-Token': token");
    expect(body).toContain('mount(cfg)');
  });

  it('falls back to DEFAULTS when /widget-config fetch fails', async () => {
    const body = await GET(makeGetRequest()).text();
    // .catch on the fetch chain returns null; mount is still called
    // with DEFAULTS so the widget never silently fails to render.
    expect(body).toContain('var DEFAULTS = {');
    expect(body).toContain('.catch(function () { return null; })');
    expect(body).toContain('cfg = DEFAULTS;');
  });

  it('applies CSS custom properties on the host element', async () => {
    const body = await GET(makeGetRequest()).text();
    // The Shadow DOM inherits these from the host. Inline <style> uses
    // var(--sw-*) so a single property assignment cascades through the
    // tree without re-templating CSS strings per agent.
    expect(body).toContain("host.style.setProperty('--sw-primary', cfg.primaryColor)");
    expect(body).toContain("host.style.setProperty('--sw-surface', cfg.surfaceColor)");
    expect(body).toContain("host.style.setProperty('--sw-text', cfg.textColor)");
    expect(body).toContain("host.style.setProperty('--sw-font', cfg.fontFamily)");
    expect(body).toContain('var(--sw-primary)');
    expect(body).toContain('var(--sw-surface)');
  });

  it('substitutes copy strings via textContent / setAttribute (no innerHTML for user copy)', async () => {
    const body = await GET(makeGetRequest()).text();
    expect(body).toContain('titleEl.textContent = cfg.headerTitle');
    expect(body).toContain('subtitleEl.textContent = cfg.headerSubtitle');
    expect(body).toContain("input.setAttribute('placeholder', cfg.inputPlaceholder)");
    expect(body).toContain('sendBtn.textContent = cfg.sendLabel');
    expect(body).toContain('footerEl.textContent = cfg.footerText');
  });

  it('hides subtitle and footer rows when their config strings are empty', async () => {
    const body = await GET(makeGetRequest()).text();
    expect(body).toContain("subtitleEl.style.display = 'none'");
    // footer is hidden by default markup; only un-hidden when text is set.
    expect(body).toContain('class="footer" style="display:none;"');
  });

  it('declares a renderStarters helper that paints chips before the first message', async () => {
    const body = await GET(makeGetRequest()).text();
    expect(body).toContain('function renderStarters()');
    // Auto-hides once any message exists.
    expect(body).toContain('messagesEl.children.length > 0');
    // Click on a chip drops the text into the input and fires send().
    expect(body).toContain('input.value = text');
    expect(body).toContain('send();');
  });

  it('hides starters as soon as the first message is added', async () => {
    const body = await GET(makeGetRequest()).text();
    // addMsg() always sets startersEl.style.display = 'none' so the
    // chip row vanishes the moment the conversation begins (whether
    // the user typed or clicked a starter).
    expect(body).toContain("startersEl.style.display = 'none'");
  });

  it('cite-marker chip background derives from --sw-primary via color-mix', async () => {
    const body = await GET(makeGetRequest()).text();
    // The chip used to be hardcoded blue rgba; once admins customise
    // primary to (say) green, the chip would have looked off. Tint
    // now follows whatever --sw-primary the loader assigned.
    expect(body).toContain('color-mix(in srgb, var(--sw-primary)');
  });

  // ─── Approval card (Phase 4 of consumer-chat-approvals) ───────────────────

  it('handles approval_required SSE event by calling renderApprovalCard', async () => {
    const body = await GET(makeGetRequest()).text();
    expect(body).toContain("evt.type === 'approval_required'");
    expect(body).toContain('renderApprovalCard');
  });

  it('approval card uses Shadow-DOM-safe DOM construction (no innerHTML in renderer)', async () => {
    const body = await GET(makeGetRequest()).text();
    // renderApprovalCard slice — must build with createElement/textContent only.
    const start = body.indexOf('function renderApprovalCard');
    expect(start).toBeGreaterThan(-1);
    const end = body.indexOf('function extractFinalOutput', start);
    const slice = body.slice(start, end > start ? end : start + 4000);
    expect(slice).not.toContain('innerHTML');
    expect(slice).toContain('createElement');
    expect(slice).toContain('textContent');
  });

  it('approval card POSTs to /<action>/embed with the channel-specific token', async () => {
    const body = await GET(makeGetRequest()).text();
    // URL is concatenated at runtime: ".../<id>/" + action + "/embed?token=...",
    // so assert on the suffix and the channel-specific token field name.
    expect(body).toContain("'/embed?token='");
    expect(body).toContain('pa.approveToken');
    expect(body).toContain('pa.rejectToken');
  });

  it('approval card polls /orchestration/approvals/<id>/status', async () => {
    const body = await GET(makeGetRequest()).text();
    expect(body).toContain("'/api/v1/orchestration/approvals/'");
    expect(body).toContain("'/status?token='");
  });

  it('approval card synthesises a follow-up message via input.value + send()', async () => {
    const body = await GET(makeGetRequest()).text();
    // After terminal poll state, the card writes the follow-up into the
    // existing input field and triggers the existing send() path so the
    // LLM gets a fresh turn carrying the workflow output.
    expect(body).toContain('Workflow approved.');
    expect(body).toContain('Workflow rejected:');
  });

  it('approval-card CSS uses theme custom properties (--sw-primary, etc)', async () => {
    const body = await GET(makeGetRequest()).text();
    expect(body).toContain('.approval-card');
    expect(body).toContain('var(--sw-surface-muted)');
    expect(body).toContain('var(--sw-primary)');
  });
});
