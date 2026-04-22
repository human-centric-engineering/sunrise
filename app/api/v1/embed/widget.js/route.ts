/**
 * Embeddable Chat Widget — JavaScript Loader
 *
 * GET /api/v1/embed/widget.js
 *
 * Serves a self-contained JavaScript snippet that renders a chat bubble
 * via Shadow DOM. Configured via data attributes on the script tag:
 *
 *   <script
 *     src="https://your-app.com/api/v1/embed/widget.js"
 *     data-token="YOUR_EMBED_TOKEN"
 *     data-position="bottom-right"
 *     data-theme="light"
 *   ></script>
 *
 * Public — no authentication required (the token is validated by the
 * streaming endpoint when the user sends a message).
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

  if (!token) {
    console.error('[SunriseWidget] data-token attribute is required');
    return;
  }

  var isDark = theme === 'dark';
  var bg = isDark ? '#1f2937' : '#ffffff';
  var text = isDark ? '#f9fafb' : '#111827';
  var border = isDark ? '#374151' : '#e5e7eb';
  var bubbleBg = '#2563eb';

  // Create host element with Shadow DOM
  var host = document.createElement('div');
  host.id = 'sunrise-chat-widget';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'closed' });

  var posRight = position.includes('right');
  var posBottom = position.includes('bottom');

  shadow.innerHTML = \`
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .bubble {
        position: fixed;
        \${posBottom ? 'bottom: 20px' : 'top: 20px'};
        \${posRight ? 'right: 20px' : 'left: 20px'};
        width: 56px; height: 56px; border-radius: 50%;
        background: \${bubbleBg}; color: #fff; cursor: pointer;
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
        background: \${bg}; color: \${text};
        border: 1px solid \${border}; border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.12);
        z-index: 99999; flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 14px; overflow: hidden;
      }
      .panel.open { display: flex; }
      .header {
        padding: 12px 16px; font-weight: 600; font-size: 15px;
        border-bottom: 1px solid \${border};
      }
      .messages {
        flex: 1; overflow-y: auto; padding: 12px 16px; min-height: 200px;
      }
      .msg { margin-bottom: 8px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
      .msg.user { text-align: right; }
      .msg.user span { background: \${bubbleBg}; color: #fff; padding: 6px 12px; border-radius: 12px 12px 0 12px; display: inline-block; max-width: 85%; }
      .msg.assistant span { background: \${isDark ? '#374151' : '#f3f4f6'}; padding: 6px 12px; border-radius: 12px 12px 12px 0; display: inline-block; max-width: 85%; }
      .input-area {
        padding: 8px 12px; border-top: 1px solid \${border}; display: flex; gap: 8px;
      }
      .input-area input {
        flex: 1; padding: 8px 12px; border: 1px solid \${border};
        border-radius: 8px; font-size: 14px; outline: none;
        background: \${isDark ? '#111827' : '#fff'}; color: \${text};
      }
      .input-area button {
        padding: 8px 16px; border: none; border-radius: 8px;
        background: \${bubbleBg}; color: #fff; cursor: pointer;
        font-size: 14px; font-weight: 500;
      }
      .input-area button:disabled { opacity: 0.5; cursor: not-allowed; }
    </style>
    <button class="bubble" aria-label="Chat">&#x1F4AC;</button>
    <div class="panel">
      <div class="header">Chat</div>
      <div class="messages"></div>
      <div class="input-area">
        <input type="text" placeholder="Type a message\u2026" />
        <button type="button">Send</button>
      </div>
    </div>
  \`;

  var bubble = shadow.querySelector('.bubble');
  var panel = shadow.querySelector('.panel');
  var messagesEl = shadow.querySelector('.messages');
  var input = shadow.querySelector('.input-area input');
  var sendBtn = shadow.querySelector('.input-area button');
  var conversationId = null;
  var sending = false;

  bubble.addEventListener('click', function() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  });

  function addMsg(role, content) {
    var div = document.createElement('div');
    div.className = 'msg ' + role;
    var span = document.createElement('span');
    span.textContent = content;
    div.appendChild(span);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return span;
  }

  function send() {
    var msg = input.value.trim();
    if (!msg || sending) return;
    sending = true;
    sendBtn.disabled = true;
    input.value = '';
    addMsg('user', msg);
    var assistantSpan = addMsg('assistant', '\\u2026');

    fetch(apiBase + '/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Embed-Token': token },
      body: JSON.stringify({ message: msg, conversationId: conversationId || undefined }),
    }).then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var fullText = '';

      function read() {
        reader.read().then(function(result) {
          if (result.done) { sending = false; sendBtn.disabled = false; return; }
          buffer += decoder.decode(result.value, { stream: true });
          var lines = buffer.split('\\n');
          buffer = lines.pop() || '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.startsWith('data: ')) {
              try {
                var evt = JSON.parse(line.slice(6));
                if (evt.type === 'start') {
                  conversationId = evt.conversationId;
                  fullText = '';
                  assistantSpan.textContent = '';
                } else if (evt.type === 'content') {
                  fullText += evt.delta;
                  assistantSpan.textContent = fullText;
                  messagesEl.scrollTop = messagesEl.scrollHeight;
                } else if (evt.type === 'error') {
                  assistantSpan.textContent = 'Error: ' + evt.message;
                }
              } catch(e) {}
            }
          }
          read();
        }).catch(function() { sending = false; sendBtn.disabled = false; });
      }
      read();
    }).catch(function(err) {
      assistantSpan.textContent = 'Failed to connect.';
      sending = false;
      sendBtn.disabled = false;
    });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') send();
  });
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
