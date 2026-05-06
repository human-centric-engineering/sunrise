/**
 * Embeddable Chat Widget — JavaScript Loader
 *
 * GET /api/v1/embed/widget.js
 *
 * Serves a self-contained JavaScript snippet that renders a chat bubble
 * via Shadow DOM. Configured via data attributes on the script tag and
 * a per-agent appearance config fetched on boot from /widget-config.
 *
 *   <script
 *     src="https://your-app.com/api/v1/embed/widget.js"
 *     data-token="YOUR_EMBED_TOKEN"
 *     data-position="bottom-right"
 *     data-theme="light"
 *   ></script>
 *
 * Public — no authentication required (the token is validated by the
 * widget-config and chat-stream endpoints when called).
 */

import { NextRequest } from 'next/server';

export function GET(request: NextRequest): Response {
  const origin = new URL(request.url).origin;

  const js = `
(function() {
  'use strict';
  var script = document.currentScript;
  var token = script.getAttribute('data-token');
  var position = script.getAttribute('data-position') || 'bottom-right';
  var theme = script.getAttribute('data-theme') || 'light';
  var apiBase = '${origin}/api/v1/embed';
  var originBase = '${origin}';

  if (!token) {
    console.error('[SunriseWidget] data-token attribute is required');
    return;
  }

  var isDark = theme === 'dark';

  // Defaults are also defined server-side (DEFAULT_WIDGET_CONFIG in
  // lib/validations/orchestration.ts). Mirrored here so the widget
  // still mounts coherently if the /widget-config fetch fails.
  var DEFAULTS = {
    primaryColor: '#2563eb',
    surfaceColor: isDark ? '#1f2937' : '#ffffff',
    textColor: isDark ? '#f9fafb' : '#111827',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    headerTitle: 'Chat',
    headerSubtitle: '',
    inputPlaceholder: 'Type a message…',
    sendLabel: 'Send',
    conversationStarters: [],
    footerText: ''
  };

  fetch(apiBase + '/widget-config', { headers: { 'X-Embed-Token': token } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (payload) {
      var server = payload && payload.success && payload.data && payload.data.config;
      var cfg = DEFAULTS;
      if (server) {
        cfg = {};
        for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
        for (var k2 in server) cfg[k2] = server[k2];
      }
      mount(cfg);
    });

  function mount(cfg) {
    var border = isDark ? '#374151' : '#e5e7eb';
    var surfaceMuted = isDark ? '#374151' : '#f3f4f6';
    var inputBg = isDark ? '#111827' : '#ffffff';
    var statusColor = isDark ? '#9ca3af' : '#6b7280';

    // Create host element with Shadow DOM
    var host = document.createElement('div');
    host.id = 'sunrise-chat-widget';
    // Apply CSS custom properties so the Shadow DOM inherits them. Stored
    // on the host (not the panel) so the bubble — which sits outside the
    // panel — also picks them up.
    host.style.setProperty('--sw-primary', cfg.primaryColor);
    host.style.setProperty('--sw-surface', cfg.surfaceColor);
    host.style.setProperty('--sw-text', cfg.textColor);
    host.style.setProperty('--sw-border', border);
    host.style.setProperty('--sw-surface-muted', surfaceMuted);
    host.style.setProperty('--sw-input-bg', inputBg);
    host.style.setProperty('--sw-status', statusColor);
    host.style.setProperty('--sw-font', cfg.fontFamily);
    document.body.appendChild(host);
    var shadow = host.attachShadow({ mode: 'closed' });

    var posRight = position.includes('right');
    var posBottom = position.includes('bottom');

    shadow.innerHTML = \`
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :host { font-family: var(--sw-font); }
        .bubble {
          position: fixed;
          \${posBottom ? 'bottom: 20px' : 'top: 20px'};
          \${posRight ? 'right: 20px' : 'left: 20px'};
          width: 56px; height: 56px; border-radius: 50%;
          background: var(--sw-primary); color: #fff; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 99999;
          border: none; font-size: 24px; transition: transform 0.2s;
        }
        .bubble:hover { transform: scale(1.1); }
        .panel {
          display: none; position: fixed;
          \${posBottom ? 'bottom: 88px' : 'top: 88px'};
          \${posRight ? 'right: 20px' : 'left: 20px'};
          width: 380px; max-height: 520px;
          background: var(--sw-surface); color: var(--sw-text);
          border: 1px solid var(--sw-border); border-radius: 12px;
          box-shadow: 0 8px 30px rgba(0,0,0,0.12);
          z-index: 99999; flex-direction: column;
          font-family: var(--sw-font);
          font-size: 14px; overflow: hidden;
        }
        .panel.open { display: flex; }
        .header {
          padding: 12px 16px; border-bottom: 1px solid var(--sw-border);
          display: flex; align-items: flex-start; gap: 8px;
        }
        .header-text { flex: 1; min-width: 0; }
        .header-title { font-weight: 600; font-size: 15px; display: block; }
        .header-subtitle { font-size: 12px; opacity: 0.7; display: block; margin-top: 2px; }
        .new-chat {
          background: none; border: none; cursor: pointer;
          font-size: 14px; color: inherit; opacity: 0.6;
        }
        .new-chat:hover { opacity: 1; }
        .messages {
          flex: 1; overflow-y: auto; padding: 12px 16px; min-height: 200px;
        }
        .msg { margin-bottom: 8px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
        .msg.user { text-align: right; }
        .msg.user span {
          background: var(--sw-primary); color: #fff;
          padding: 6px 12px; border-radius: 12px 12px 0 12px;
          display: inline-block; max-width: 85%;
        }
        .msg.assistant span {
          background: var(--sw-surface-muted);
          padding: 6px 12px; border-radius: 12px 12px 12px 0;
          display: inline-block; max-width: 85%;
        }
        .cite-marker {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 16px; height: 16px; padding: 0 4px; margin: 0 2px;
          border-radius: 3px; font-size: 10px; font-weight: 600;
          line-height: 1; vertical-align: super;
          /* Tint derived from the configured primary so the chip
             harmonises with custom brand colours instead of staying
             stuck on the original blue. */
          background: color-mix(in srgb, var(--sw-primary) \${isDark ? '18%' : '10%'}, transparent);
          color: var(--sw-primary);
          border: none; cursor: pointer; font-family: inherit;
        }
        button.cite-marker:hover { filter: brightness(1.1); }
        button.cite-marker:focus-visible { outline: 2px solid var(--sw-primary); outline-offset: 1px; }
        .cite-marker.cite-bad {
          background: \${isDark ? 'rgba(217, 119, 6, 0.20)' : 'rgba(245, 158, 11, 0.18)'};
          color: \${isDark ? '#fcd34d' : '#92400e'};
          cursor: default;
        }
        .citations-panel {
          margin-top: 8px; padding-top: 8px;
          border-top: 1px solid var(--sw-border);
          font-size: 12px;
        }
        .citations-heading { font-weight: 600; margin-bottom: 6px; opacity: 0.75; }
        .citations-list { list-style: none; padding: 0; margin: 0; }
        .citations-list li {
          margin-bottom: 6px; padding: 6px 8px;
          border: 1px solid var(--sw-border); border-radius: 6px;
        }
        .cite-name { font-weight: 500; }
        .cite-section { opacity: 0.7; }
        .cite-excerpt { margin-top: 4px; opacity: 0.75; line-height: 1.4; white-space: pre-wrap; }
        .approval-card {
          margin-top: 8px; padding: 10px;
          border: 1px solid var(--sw-border); border-radius: 8px;
          background: var(--sw-surface-muted);
        }
        .approval-card .approval-title { font-weight: 600; font-size: 13px; }
        .approval-card .approval-prompt {
          margin-top: 4px; font-size: 13px;
          white-space: pre-wrap; word-wrap: break-word;
        }
        .approval-card .approval-actions { margin-top: 10px; display: flex; gap: 8px; }
        .approval-card button {
          padding: 6px 12px; border: 1px solid var(--sw-border); border-radius: 6px;
          font-size: 13px; font-weight: 500; font-family: inherit; cursor: pointer;
        }
        .approval-card button.approve {
          background: var(--sw-primary); color: #fff; border-color: var(--sw-primary);
        }
        .approval-card button.reject {
          background: var(--sw-surface); color: var(--sw-text);
        }
        .approval-card button:disabled { opacity: 0.5; cursor: not-allowed; }
        .approval-card .approval-status {
          margin-top: 8px; font-size: 12px; color: var(--sw-status);
        }
        .approval-card .approval-reason {
          width: 100%; margin-top: 6px; padding: 6px 8px;
          border: 1px solid var(--sw-border); border-radius: 6px;
          background: var(--sw-input-bg); color: var(--sw-text);
          font-family: inherit; font-size: 13px; resize: vertical;
        }
        .status { font-size: 12px; color: var(--sw-status); font-style: italic; padding: 0 16px 4px; }
        .starters {
          padding: 0 12px 8px; display: flex; flex-wrap: wrap; gap: 6px;
        }
        .starter {
          padding: 6px 10px; font-size: 12px; cursor: pointer;
          background: var(--sw-surface-muted); color: var(--sw-text);
          border: 1px solid var(--sw-border); border-radius: 999px;
          font-family: inherit;
        }
        .starter:hover { filter: brightness(1.05); }
        .input-area {
          padding: 8px 12px; border-top: 1px solid var(--sw-border); display: flex; gap: 8px;
        }
        .input-area input {
          flex: 1; padding: 8px 12px; border: 1px solid var(--sw-border);
          border-radius: 8px; font-size: 14px; outline: none;
          background: var(--sw-input-bg); color: var(--sw-text);
          font-family: inherit;
        }
        .input-area button {
          padding: 8px 16px; border: none; border-radius: 8px;
          background: var(--sw-primary); color: #fff; cursor: pointer;
          font-size: 14px; font-weight: 500; font-family: inherit;
        }
        .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
        .footer {
          padding: 6px 12px 8px; font-size: 11px; opacity: 0.6;
          text-align: center; border-top: 1px solid var(--sw-border);
        }
      </style>
      <button class="bubble" aria-label="Chat">&#x1F4AC;</button>
      <div class="panel">
        <div class="header">
          <div class="header-text">
            <span class="header-title"></span>
            <span class="header-subtitle"></span>
          </div>
          <button class="new-chat" aria-label="New chat" title="New chat">&#x1F5D1;</button>
        </div>
        <div class="messages"></div>
        <div class="status" style="display:none;"></div>
        <div class="starters" style="display:none;"></div>
        <div class="input-area">
          <input type="text" />
          <button type="button" class="send-btn"></button>
        </div>
        <div class="footer" style="display:none;"></div>
      </div>
    \`;

    // Apply copy via textContent / setAttribute (XSS-safe — model output and
    // admin-saved strings cannot inject HTML through these paths).
    var titleEl = shadow.querySelector('.header-title');
    var subtitleEl = shadow.querySelector('.header-subtitle');
    titleEl.textContent = cfg.headerTitle;
    if (cfg.headerSubtitle) {
      subtitleEl.textContent = cfg.headerSubtitle;
    } else {
      subtitleEl.style.display = 'none';
    }

    var bubble = shadow.querySelector('.bubble');
    var panel = shadow.querySelector('.panel');
    var messagesEl = shadow.querySelector('.messages');
    var input = shadow.querySelector('.input-area input');
    var sendBtn = shadow.querySelector('.send-btn');
    var statusEl = shadow.querySelector('.status');
    var startersEl = shadow.querySelector('.starters');
    var footerEl = shadow.querySelector('.footer');
    var newChatBtn = shadow.querySelector('.new-chat');

    input.setAttribute('placeholder', cfg.inputPlaceholder);
    sendBtn.textContent = cfg.sendLabel;
    if (cfg.footerText) {
      footerEl.textContent = cfg.footerText;
      footerEl.style.display = '';
    }

    var conversationId = null;
    var sending = false;
    var activeAbort = null;

    function renderStarters() {
      // Clear existing chips on every call (cheap; list is at most 4).
      while (startersEl.firstChild) startersEl.removeChild(startersEl.firstChild);
      if (messagesEl.children.length > 0 || !cfg.conversationStarters || !cfg.conversationStarters.length) {
        startersEl.style.display = 'none';
        return;
      }
      for (var i = 0; i < cfg.conversationStarters.length; i++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'starter';
        btn.textContent = cfg.conversationStarters[i];
        (function (text) {
          btn.addEventListener('click', function () {
            input.value = text;
            send();
          });
        })(cfg.conversationStarters[i]);
        startersEl.appendChild(btn);
      }
      startersEl.style.display = '';
    }

    bubble.addEventListener('click', function() {
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        input.focus();
        renderStarters();
      }
    });

    newChatBtn.addEventListener('click', function() {
      if (activeAbort) { activeAbort.abort(); activeAbort = null; }
      conversationId = null;
      messagesEl.innerHTML = '';
      statusEl.style.display = 'none';
      statusEl.textContent = '';
      input.value = '';
      sending = false;
      sendBtn.disabled = false;
      input.focus();
      renderStarters();
    });

    function addMsg(role, content) {
      // Hide starters once any message exists.
      startersEl.style.display = 'none';
      var div = document.createElement('div');
      div.className = 'msg ' + role;
      var span = document.createElement('span');
      span.textContent = content;
      div.appendChild(span);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return span;
    }

    // Re-renders an assistant bubble with [N] markers replaced by superscript
    // nodes and appends a sources panel below the bubble. Uses createElement
    // + textContent throughout so model output cannot inject HTML.
    function renderCitations(span, fullText, citations) {
      // Defensive early-return: empty envelopes should not happen (the
      // server only emits the citations event when length > 0) but if one
      // arrives we must not falsely flag every [N] in fullText as
      // hallucinated.
      if (!citations || citations.length === 0) return;
      var validMarkers = {};
      for (var i = 0; i < citations.length; i++) {
        validMarkers[citations[i].marker] = true;
      }
      span.textContent = '';
      var parts = fullText.split(/(\\[\\d+\\])/g);
      for (var p = 0; p < parts.length; p++) {
        var part = parts[p];
        var match = part.match(/^\\[(\\d+)\\]$/);
        if (match) {
          var n = parseInt(match[1], 10);
          var isValid = !!validMarkers[n];
          // Use <button> for valid markers so they're focusable and tappable;
          // hallucinated markers stay as <span> (non-interactive — there's
          // nothing to navigate to) but get an aria-label for screen readers.
          var sup;
          if (isValid) {
            sup = document.createElement('button');
            sup.type = 'button';
            sup.setAttribute('aria-label', 'Source ' + n);
            sup.title = 'Source ' + n;
            (function (markerN) {
              sup.addEventListener('click', function () {
                var msg = sup.closest('.msg');
                if (!msg) return;
                var target = msg.querySelector('[data-cite-id="' + markerN + '"]');
                if (target && typeof target.scrollIntoView === 'function') {
                  target.scrollIntoView({ block: 'nearest' });
                }
              });
            })(n);
          } else {
            sup = document.createElement('span');
            sup.setAttribute('aria-label', 'Unmatched citation marker ' + n);
            sup.title = 'Marker [' + n + '] has no matching citation';
          }
          sup.className = 'cite-marker' + (isValid ? '' : ' cite-bad');
          sup.textContent = String(n);
          span.appendChild(sup);
        } else if (part) {
          span.appendChild(document.createTextNode(part));
        }
      }

      var msgDiv = span.parentElement;
      if (!msgDiv) return;
      var existing = msgDiv.querySelector('.citations-panel');
      if (existing) existing.remove();

      var panel = document.createElement('div');
      panel.className = 'citations-panel';
      var heading = document.createElement('div');
      heading.className = 'citations-heading';
      heading.textContent = 'Sources (' + citations.length + ')';
      panel.appendChild(heading);
      var list = document.createElement('ol');
      list.className = 'citations-list';
      for (var c = 0; c < citations.length; c++) {
        var cite = citations[c];
        var li = document.createElement('li');
        li.setAttribute('data-cite-id', String(cite.marker));
        var marker = document.createElement('span');
        marker.className = 'cite-marker';
        marker.textContent = String(cite.marker);
        li.appendChild(marker);
        var name = document.createElement('span');
        name.className = 'cite-name';
        name.textContent = ' ' + (cite.documentName || cite.patternName || 'Untitled source');
        li.appendChild(name);
        if (cite.section) {
          var section = document.createElement('span');
          section.className = 'cite-section';
          section.textContent = ' \\u00B7 ' + cite.section;
          li.appendChild(section);
        }
        if (cite.excerpt) {
          var excerpt = document.createElement('div');
          excerpt.className = 'cite-excerpt';
          excerpt.textContent = cite.excerpt;
          li.appendChild(excerpt);
        }
        list.appendChild(li);
      }
      panel.appendChild(list);
      msgDiv.appendChild(panel);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Renders an Approve / Reject card on a synthetic assistant bubble
    // and drives the full state machine: idle → submitting → waiting →
    // completed / failed / expired. Uses createElement + textContent
    // throughout (no innerHTML); inherits the per-agent theme via the
    // host CSS custom properties (--sw-primary, --sw-surface, etc).
    function renderApprovalCard(pa) {
      if (!pa || !pa.executionId || !pa.approveToken || !pa.rejectToken) return;
      // Mount on a brand-new assistant bubble so the card sits below
      // any preceding assistant text, mirroring the admin surface and
      // the streaming-handler's persisted shape.
      var span = addMsg('assistant', '');
      var bubble = span.parentElement;
      if (!bubble) return;
      span.remove(); // empty span — the card is the visible content

      var card = document.createElement('div');
      card.className = 'approval-card';
      var title = document.createElement('div');
      title.className = 'approval-title';
      title.textContent = 'Action requires your approval';
      card.appendChild(title);
      var promptEl = document.createElement('div');
      promptEl.className = 'approval-prompt';
      promptEl.textContent = pa.prompt || 'Please confirm.';
      card.appendChild(promptEl);

      var actions = document.createElement('div');
      actions.className = 'approval-actions';
      var approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'approve';
      approveBtn.textContent = 'Approve';
      approveBtn.setAttribute('aria-label', 'Approve action');
      var rejectBtn = document.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.className = 'reject';
      rejectBtn.textContent = 'Reject';
      rejectBtn.setAttribute('aria-label', 'Reject action');
      actions.appendChild(approveBtn);
      actions.appendChild(rejectBtn);
      card.appendChild(actions);

      var status = document.createElement('div');
      status.className = 'approval-status';
      status.style.display = 'none';
      card.appendChild(status);

      bubble.appendChild(card);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      var POLL_BASE_MS = 2000;
      var POLL_MAX_MS = 5000;
      var POLL_BUDGET_MS = 5 * 60 * 1000;
      var settled = false;

      function setStatus(text) {
        status.style.display = '';
        status.textContent = text;
      }

      function disableActions() {
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
      }

      function pollExecution(action) {
        var startedAt = Date.now();
        var attempt = 0;

        function tick() {
          if (settled) return;
          if (Date.now() - startedAt > POLL_BUDGET_MS) {
            setStatus(
              'This is taking longer than expected. The workflow may still complete\\u2014ask the agent to check.'
            );
            settled = true;
            return;
          }
          var statusUrl =
            originBase +
            '/api/v1/orchestration/approvals/' +
            encodeURIComponent(pa.executionId) +
            '/status?token=' +
            encodeURIComponent(pa.approveToken);
          fetch(statusUrl, { method: 'GET' })
            .then(function (res) {
              if (!res.ok) throw new Error('status ' + res.status);
              return res.json();
            })
            .then(function (json) {
              var data = (json && json.data) || {};
              if (data.status === 'completed') {
                settled = true;
                var output = extractFinalOutput(data.executionTrace);
                var rendered = safeStringify(output);
                var followup =
                  rendered.length > 0
                    ? 'Workflow approved. Result: ' + rendered
                    : 'Workflow approved successfully.';
                setStatus('Approved \\u2014 workflow completed.');
                input.value = followup;
                send();
                return;
              }
              if (data.status === 'cancelled' || data.status === 'failed') {
                settled = true;
                var reason = data.errorMessage || 'Workflow ended';
                var followup2 =
                  action === 'reject'
                    ? 'Workflow rejected: ' + reason
                    : 'Workflow failed: ' + reason;
                setStatus(action === 'reject' ? 'Rejected.' : 'Failed: ' + reason);
                input.value = followup2;
                send();
                return;
              }
              attempt += 1;
              var delay = Math.min(POLL_BASE_MS * Math.pow(1.5, attempt - 1), POLL_MAX_MS);
              setTimeout(tick, delay);
            })
            .catch(function () {
              // Transient — retry until the budget expires.
              attempt += 1;
              var delay2 = Math.min(POLL_BASE_MS * Math.pow(1.5, attempt - 1), POLL_MAX_MS);
              setTimeout(tick, delay2);
            });
        }

        tick();
      }

      function submit(action, body) {
        disableActions();
        setStatus('Submitting ' + (action === 'approve' ? 'approval' : 'rejection') + '\\u2026');
        var url =
          originBase +
          '/api/v1/orchestration/approvals/' +
          encodeURIComponent(pa.executionId) +
          '/' +
          action +
          '/embed?token=' +
          encodeURIComponent(action === 'approve' ? pa.approveToken : pa.rejectToken);
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
          .then(function (res) {
            if (!res.ok) {
              return res.json().then(
                function (j) {
                  throw new Error((j && j.error && j.error.message) || 'Request failed');
                },
                function () {
                  throw new Error('Request failed (' + res.status + ')');
                }
              );
            }
            setStatus('Waiting for the workflow to finish\\u2026');
            pollExecution(action);
          })
          .catch(function (err) {
            settled = true;
            setStatus('Failed: ' + (err && err.message ? err.message : 'Unknown error'));
          });
      }

      approveBtn.addEventListener('click', function () {
        submit('approve', {});
      });

      rejectBtn.addEventListener('click', function () {
        // Reject requires a reason — render a small inline textarea + confirm.
        if (rejectBtn.dataset.confirming === '1') return;
        rejectBtn.dataset.confirming = '1';
        var reasonField = document.createElement('textarea');
        reasonField.className = 'approval-reason';
        reasonField.placeholder = 'Reason for rejecting';
        reasonField.rows = 2;
        var confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'reject';
        confirmBtn.textContent = 'Confirm reject';
        confirmBtn.disabled = true;
        reasonField.addEventListener('input', function () {
          confirmBtn.disabled = !reasonField.value.trim();
        });
        var confirmSubmitted = false;
        confirmBtn.addEventListener('click', function () {
          if (confirmSubmitted) return;
          confirmSubmitted = true;
          confirmBtn.disabled = true;
          reasonField.disabled = true;
          submit('reject', { reason: reasonField.value.trim() });
        });
        actions.appendChild(reasonField);
        actions.appendChild(confirmBtn);
        rejectBtn.disabled = true;
      });
    }

    function extractFinalOutput(trace) {
      if (!Array.isArray(trace) || trace.length === 0) return null;
      for (var i = trace.length - 1; i >= 0; i--) {
        var entry = trace[i];
        if (entry && typeof entry === 'object' && entry.status === 'completed') {
          return entry.output != null ? entry.output : null;
        }
      }
      return null;
    }

    function safeStringify(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch (e) {
        return '[unserializable]';
      }
    }

    function parseSseBlocks(buffer) {
      var blocks = buffer.split('\\n\\n');
      var remaining = blocks.pop() || '';
      var events = [];
      for (var b = 0; b < blocks.length; b++) {
        var block = blocks[b];
        if (!block.trim()) continue;
        var lines = block.split('\\n');
        var eventType = null;
        var dataLines = [];
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.charAt(0) === ':') continue;
          if (line.indexOf('event:') === 0) {
            eventType = line.slice(6).trim();
          } else if (line.indexOf('data:') === 0) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (!eventType || dataLines.length === 0) continue;
        try {
          var data = JSON.parse(dataLines.join('\\n'));
          events.push({ type: eventType, data: data });
        } catch(e) {}
      }
      return { events: events, remaining: remaining };
    }

    function endStream() {
      sending = false;
      sendBtn.disabled = false;
      activeAbort = null;
      statusEl.style.display = 'none';
      statusEl.textContent = '';
    }

    function send() {
      var msg = input.value.trim();
      if (!msg || sending) return;
      sending = true;
      sendBtn.disabled = true;
      input.value = '';
      addMsg('user', msg);
      var assistantSpan = addMsg('assistant', '\\u2026');

      var controller = new AbortController();
      activeAbort = controller;

      fetch(apiBase + '/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Embed-Token': token },
        body: JSON.stringify({ message: msg, conversationId: conversationId || undefined }),
        signal: controller.signal,
      }).then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var fullText = '';

        function read() {
          reader.read().then(function(result) {
            if (result.done) { endStream(); return; }
            buffer += decoder.decode(result.value, { stream: true });
            var parsed = parseSseBlocks(buffer);
            buffer = parsed.remaining;
            for (var i = 0; i < parsed.events.length; i++) {
              var evt = parsed.events[i];
              if (evt.type === 'start') {
                conversationId = evt.data.conversationId;
                fullText = '';
                assistantSpan.textContent = '';
              } else if (evt.type === 'content' && typeof evt.data.delta === 'string') {
                fullText += evt.data.delta;
                assistantSpan.textContent = fullText;
                messagesEl.scrollTop = messagesEl.scrollHeight;
                statusEl.style.display = 'none';
              } else if (evt.type === 'content_reset') {
                fullText = '';
                assistantSpan.textContent = '';
              } else if (evt.type === 'status' && typeof evt.data.message === 'string') {
                statusEl.textContent = evt.data.message;
                statusEl.style.display = '';
              } else if (evt.type === 'citations' && Array.isArray(evt.data.citations)) {
                renderCitations(assistantSpan, fullText, evt.data.citations);
              } else if (evt.type === 'approval_required' && evt.data.pendingApproval) {
                renderApprovalCard(evt.data.pendingApproval);
              } else if (evt.type === 'error') {
                assistantSpan.textContent = fullText || 'Something went wrong.';
                // Drop any citations panel that may have been appended
                // earlier in the stream — keeping it next to a generic
                // error bubble would mislead the user.
                var bubbleDiv = assistantSpan.parentElement;
                var orphanPanel = bubbleDiv && bubbleDiv.querySelector('.citations-panel');
                if (orphanPanel) orphanPanel.remove();
                endStream();
                return;
              } else if (evt.type === 'done') {
                endStream();
                return;
              }
            }
            read();
          }).catch(function(err) {
            if (err && err.name === 'AbortError') return;
            assistantSpan.textContent = fullText || 'Connection lost.';
            endStream();
          });
        }
        read();
      }).catch(function(err) {
        if (err && err.name === 'AbortError') return;
        assistantSpan.textContent = 'Failed to connect.';
        endStream();
      });
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') send();
    });
  }
})();
`;

  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      // Allow embedding from any origin
      'Access-Control-Allow-Origin': '*',
    },
  });
}
