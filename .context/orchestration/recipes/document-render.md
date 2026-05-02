# Recipe: Document Render (PDF / HTML)

Render a document — typically a PDF, sometimes a styled HTML page — via a hosted rendering endpoint. **No PDF library is bundled** (no `pdfkit`, no `puppeteer`); the recipe shows how to drive a hosted service or your own self-hosted Gotenberg instance via plain HTTP.

## 1. When to use this recipe

- Agent needs to produce a one-off document in response to the conversation: a quote, an invoice, a receipt, a confirmation letter, a single-page report
- The document is small (a few pages), generated from data the agent already has, and the user wants a downloadable file or a hosted URL
- The vendor exposes a "give me HTML, get back a PDF" endpoint

**Don't use this recipe for:** template-managed multi-page reports with versioning (use a dedicated reporting tool), bulk batch rendering (use a queue + worker, not an agent tool), or anything where the PDF needs to be auditable / signed (those flows want a dedicated capability with checksum + storage).

## 2. What you ship

- An entry in `ORCHESTRATION_ALLOWED_HOSTS` for the chosen renderer
- One env var with the renderer's API key (or none if self-hosted Gotenberg without auth)
- A binding of `call_external_api` to the agent
- An object-storage bucket the agent can use as the destination for rendered files (recipes assume one already exists; `call_external_api` returns the rendered bytes which the agent can pass to a separate `upload_to_storage` capability — out of recipe scope)

## 3. Allowlist hosts

| Vendor                | Add to `ORCHESTRATION_ALLOWED_HOSTS`                |
| --------------------- | --------------------------------------------------- |
| DocRaptor             | `docraptor.com`                                     |
| PDFShift              | `api.pdfshift.io`                                   |
| Self-hosted Gotenberg | `<your gotenberg host>` (e.g. `gotenberg.internal`) |
| Generic HTML→PDF SaaS | `<vendor host>`                                     |

## 4. Credential setup

| Vendor                  | Env var                                               | Format                           |
| ----------------------- | ----------------------------------------------------- | -------------------------------- |
| DocRaptor               | `DOCRAPTOR_API_KEY`                                   | API key from DocRaptor dashboard |
| PDFShift                | `PDFSHIFT_API_KEY`                                    | API key from PDFShift dashboard  |
| Gotenberg (self-hosted) | none — typically no auth (deploy on internal network) | —                                |

## 5. Capability binding

Worked example: PDFShift — convert HTML to PDF and return the bytes.

```json
{
  "allowedUrlPrefixes": ["https://api.pdfshift.io/v3/convert/pdf"],
  "auth": {
    "type": "basic",
    "secret": "PDFSHIFT_API_KEY"
  },
  "forcedHeaders": {
    "Content-Type": "application/json",
    "Accept": "application/pdf"
  },
  "timeoutMs": 60000,
  "maxResponseBytes": 5242880
}
```

Notes:

- **`maxResponseBytes: 5242880`** (5 MB) — PDFs are bigger than the default 1 MB cap. Bump as needed; reject very large rendered docs at the binding rather than the network
- **`timeoutMs: 60000`** — rendering takes seconds, sometimes 10+. The default 30s timeout is borderline
- **No `defaultResponseTransform`** — the response is binary PDF bytes, which the response transform can't process. The capability returns the raw body (base64-encoded by the response handler if the content-type is non-JSON / non-text). The agent then hands the bytes to a follow-up capability (e.g. `upload_to_storage`)
- **PDFShift uses Basic auth** with the API key as username and an empty password. Set `PDFSHIFT_API_KEY=sk_xxx:` (with trailing colon) for the Basic encoder to produce the right value

> **Binary response handling caveat.** The current HTTP module returns binary responses as a UTF-8-decoded string, which corrupts PDF bytes. **For binary rendering, either (a) use a renderer that returns a hosted URL instead of bytes, or (b) extend the HTTP module to return base64-encoded bodies for non-text content-types — see the follow-up note in [Common variants](#9-common-variants).** Until that's resolved, the recipe's primary path is "renderer returns a URL", not "renderer returns bytes".

### Path that works today: renderer returns a hosted URL

DocRaptor (and PDFShift with `?response_type=url`) can be configured to upload the result to their CDN and return a JSON body with the URL. That works inside the current binary-response constraint.

```json
{
  "allowedUrlPrefixes": ["https://docraptor.com/docs"],
  "auth": { "type": "basic", "secret": "DOCRAPTOR_BASIC" },
  "forcedHeaders": { "Content-Type": "application/json" },
  "defaultResponseTransform": {
    "type": "jmespath",
    "expression": "{url: download_url, status: status}"
  },
  "timeoutMs": 60000,
  "maxResponseBytes": 65536
}
```

DocRaptor body: `{ "user_credentials": "<api key>", "doc": { "document_content": "<html>", "type": "pdf", "name": "<filename>.pdf", "async": true } }` — the `async: true` mode returns a download URL once rendering completes. Polling that URL is a follow-up tool call (or fold into a workflow rather than a chat tool).

## 6. Agent prompt guidance

Append to the agent's system instructions:

```
You can render PDF documents via the `call_external_api` tool. To render an HTML document to PDF, call:
  - url: https://docraptor.com/docs
  - method: POST
  - body: {
      "user_credentials": "(do not include — handled by the tool)",
      "doc": {
        "document_content": "<the full HTML you want rendered>",
        "type": "pdf",
        "name": "<descriptive filename>.pdf",
        "async": false
      }
    }

POLICY:
  - Keep the HTML self-contained — inline all styles. Do not reference external CSS or images that require auth.
  - Cap document size at ~10 pages of normal text — anything larger should be a workflow, not a tool call.
  - Confirm with the user what should appear in the document before rendering.
  - The response will include a download URL — quote it back to the user.
```

(In practice, DocRaptor returns the PDF bytes inline by default; the `async: true` flow returns a URL. Adjust the prompt to match the response shape you've configured.)

## 7. Worked example

User: _"Render a one-page invoice for $250 to alice@example.com."_

Agent confirms the line items, customer details, and any branding, then emits:

```json
{
  "tool": "call_external_api",
  "args": {
    "url": "https://docraptor.com/docs",
    "method": "POST",
    "body": {
      "doc": {
        "document_content": "<html><body><h1>Invoice INV-2026-0042</h1><p>Bill to: Alice</p><table>...</table><p>Total: $250.00</p></body></html>",
        "type": "pdf",
        "name": "invoice-INV-2026-0042.pdf",
        "async": true
      }
    }
  }
}
```

DocRaptor renders asynchronously, returns:

```json
{
  "status": "queued",
  "status_id": "...",
  "download_url": "https://docraptor.com/download/.../invoice-INV-2026-0042.pdf"
}
```

After response transform: `{ status: 200, body: { url: "https://docraptor.com/download/.../invoice-INV-2026-0042.pdf", status: "queued" } }`.

Agent: _"Rendered. The PDF will be available at https://docraptor.com/download/.../invoice-INV-2026-0042.pdf — typically ready in a few seconds."_

## 8. Vendor variants

### Self-hosted Gotenberg

```json
{
  "allowedUrlPrefixes": ["https://gotenberg.internal/forms/chromium/convert/html"],
  "auth": { "type": "none" },
  "forcedHeaders": { "Content-Type": "multipart/form-data" },
  "timeoutMs": 60000,
  "maxResponseBytes": 5242880
}
```

Gotenberg expects multipart form data with an `index.html` file part. **The current `call_external_api` doesn't construct multipart bodies** — the LLM would have to emit a raw multipart string in `body`, which is fragile. For Gotenberg, prefer a small adapter service (a Next.js API route on your own host) that takes JSON `{html}` and forwards as multipart to Gotenberg. Then bind `call_external_api` to your adapter, not Gotenberg directly.

### PDFShift (sync mode, HTML → URL)

```json
{
  "allowedUrlPrefixes": ["https://api.pdfshift.io/v3/convert/pdf"],
  "auth": { "type": "basic", "secret": "PDFSHIFT_API_KEY" },
  "forcedHeaders": { "Content-Type": "application/json" },
  "defaultResponseTransform": { "type": "jmespath", "expression": "{url: url}" },
  "timeoutMs": 60000,
  "maxResponseBytes": 65536
}
```

Body: `{ "source": "<html>", "filename": "...", "use_print": true }`. With the right account plan PDFShift can return a hosted URL instead of bytes.

## 9. Common variants

- **Binary-response support (open follow-up).** Adding base64 encoding for non-text content-types in the HTTP module unlocks the "renderer returns bytes inline" flow. Tracked as a follow-up; until then, prefer hosted-URL responses
- **Multi-page reports.** Beyond ~10 pages the LLM-emitted HTML body becomes too large for a tool call. Move to a workflow that builds the HTML with `llm_call` steps and a final `external_call` step
- **Templated rendering.** DocRaptor and similar accept a `document_url` instead of inline `document_content` — point at a template URL on your own host and pass `data` as variables. Reduces the size of the LLM-emitted body
- **Self-hosted with auth.** If your Gotenberg instance is on a public network, front it with Basic auth or an API key check in your reverse proxy. Then bind `call_external_api` with `auth: { type: 'basic', ... }`

## 10. Anti-patterns

- ❌ **Bundling a PDF library "for convenience".** That defeats the recipe stance entirely. Use a hosted endpoint or your own renderer behind HTTP. PDF libraries pull in megabytes of native deps and break across Node versions
- ❌ **Letting the LLM render arbitrary HTML containing user-provided JavaScript.** Some renderers execute `<script>` blocks. If the HTML body comes (in part) from the user, sanitise before render. Inject a Content-Security-Policy meta tag in the HTML wrapper
- ❌ **Trying to fit large docs into a tool call.** A 50-page report's HTML can easily exceed the LLM's output budget. Use a workflow, not a tool
- ❌ **Treating the renderer's signed download URL as long-lived.** Most expire in minutes. The agent should download the file (via a follow-up capability) and re-host on storage you control if persistence matters
- ❌ **Skipping the storage step.** Renderer URLs expire; if the user wants to keep the PDF, you have to download and re-store it yourself

## 11. Test plan

1. Sign up for a DocRaptor sandbox account; set `DOCRAPTOR_BASIC=<api_key>:` in `.env.local`
2. Add `docraptor.com` to `ORCHESTRATION_ALLOWED_HOSTS`
3. Bind `call_external_api` to a test agent with the §5 binding
4. Update agent prompt per §6
5. Open a chat: _"Render a one-page test PDF that says 'Hello, world'"_
6. **Verify:**
   - The agent's response includes a `docraptor.com/download/...` URL
   - The URL serves a real PDF (open it in a browser)
   - Trace shows the request HTML body and response JSON; **API key not visible**
7. **Negative tests:**
   - Ask the agent to render a 100-page document (should be rejected by prompt or fail the timeout)
   - Ask the agent to render to PDFShift (different host) — should be rejected with `host_not_allowed`
   - Bump `maxResponseBytes` down to 100 and confirm large response gets `response_too_large`

## 12. Related

- [Recipes index](./index.md)
- [`call_external_api` capability](../capabilities.md)
- Sibling: [transactional-email.md](./transactional-email.md) — frequently chained with this recipe (render PDF → email it)
- For multi-step report generation: [Workflows guide](../workflows.md) — better fit than a single tool call past ~10 pages
