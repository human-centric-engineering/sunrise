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
- **Either** (a) a renderer plan that returns a hosted URL, **or** (b) a binding of `upload_to_storage` to persist the rendered bytes in your S3 / Vercel Blob bucket — see §5 for which to choose

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

Two persistence patterns. Pick by **how long the file needs to live**, not by which is easier.

| Pattern                             | When to choose                                                                                                                   | Tool calls per render |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **A — Vendor-hosted URL**           | One-time download, the user opens it now or never (preview, ephemeral receipt). Vendor links typically expire in minutes to days | 1                     |
| **B — Bytes → `upload_to_storage`** | User expects the link to keep working ("here's your invoice — save this"). You control retention, deletion, and signed-URL TTL   | 2                     |

### Pattern A — vendor-hosted URL

If your renderer plan supports it (DocRaptor's `async: true` mode, PDFShift with `?response_type=url`), have the vendor host the rendered file and return a JSON body with the URL. The agent gets a URL string back from `call_external_api` and quotes it to the user — no storage capability needed.

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

### Pattern B — bytes → `upload_to_storage`

The renderer returns the file bytes, the agent then calls `upload_to_storage` to persist them on your bucket. Requires both capabilities bound to the agent.

**Step 1 — `call_external_api` (PDFShift bytes mode):**

```json
{
  "allowedUrlPrefixes": ["https://api.pdfshift.io/v3/convert/pdf"],
  "auth": { "type": "basic", "secret": "PDFSHIFT_API_KEY" },
  "forcedHeaders": {
    "Content-Type": "application/json",
    "Accept": "application/pdf"
  },
  "timeoutMs": 60000,
  "maxResponseBytes": 5242880
}
```

**Step 2 — `upload_to_storage`:**

```json
{
  "keyPrefix": "agent-uploads/<agent-id>/invoices/",
  "allowedContentTypes": ["application/pdf"],
  "maxFileSizeBytes": 5242880,
  "signedUrlTtlSeconds": 604800
}
```

Notes:

- **`maxResponseBytes: 5242880`** (5 MB) on Step 1 — PDFs are bigger than the default 1 MB cap. Reject oversized rendered docs at the binding, not the network
- **`timeoutMs: 60000`** — rendering takes seconds, sometimes 10+. The default 30s is borderline
- **Binary response shape.** PDFShift returns `application/pdf`; the HTTP module wraps the body as `{ encoding: 'base64', contentType: 'application/pdf', data: '<base64>' }` rather than UTF-8-decoding (which would corrupt the bytes). The agent passes the `data` field directly to `upload_to_storage` — never try to interpret base64 inline
- **`allowedContentTypes` on Step 2** restricts the binding to PDFs only. Without it the agent could upload any content type to the same prefix
- **`signedUrlTtlSeconds: 604800`** (7 days) returns a time-limited signed URL instead of a public one. Only S3 supports signed URLs; on Vercel Blob / local the call fails closed with `signed_url_not_supported`. Drop the field for a public URL
- **No `defaultResponseTransform` on Step 1** — JMESPath only makes sense for structured (JSON) responses. Skip the transform for binary
- **PDFShift uses Basic auth** with the API key as username and an empty password. Set `PDFSHIFT_API_KEY=sk_xxx:` (with trailing colon) for the Basic encoder to produce the right value

## 6. Agent prompt guidance

Append to the agent's system instructions. Use the prompt that matches the persistence pattern you bound.

### Pattern A prompt (vendor-hosted URL)

```
You can render PDF documents via the `call_external_api` tool. To render an HTML
document to PDF, call:
  - url: https://docraptor.com/docs
  - method: POST
  - body: {
      "doc": {
        "document_content": "<the full HTML you want rendered>",
        "type": "pdf",
        "name": "<descriptive filename>.pdf",
        "async": true
      }
    }

POLICY:
  - Keep the HTML self-contained — inline all styles. Do not reference external CSS or images that require auth.
  - Cap document size at ~10 pages of normal text — anything larger should be a workflow, not a tool call.
  - Confirm with the user what should appear in the document before rendering.
  - The response will include a download URL — quote it back to the user.
  - The URL is hosted by the renderer and may expire — tell the user to download promptly.
```

### Pattern B prompt (bytes → storage)

```
To render and persist a PDF, call two tools in sequence:

1. `call_external_api` with the renderer endpoint and HTML body. The response body
   will be `{ encoding: "base64", contentType: "application/pdf", data: "<base64>" }`.
2. `upload_to_storage` with:
     - data: <the `data` field from step 1's response>
     - contentType: "application/pdf"
     - filename: "<descriptive filename>.pdf"
     - description: "<one-line summary of what's in the document>"

POLICY:
  - Keep the HTML self-contained — inline all styles. Do not reference external CSS or images that require auth.
  - Cap document size at ~10 pages of normal text — anything larger should be a workflow.
  - Confirm with the user what should appear in the document before rendering.
  - After upload_to_storage returns, quote the `url` field back to the user. If the result includes `expiresAt`, tell the user when the link expires.
  - Do not attempt to interpret the base64 `data` field — pass it through unchanged.
```

## 7. Worked example

User: _"Render a one-page invoice for $250 to alice@example.com."_

### Pattern A — vendor-hosted URL

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

Agent: _"Rendered. The PDF will be available at https://docraptor.com/download/.../invoice-INV-2026-0042.pdf — typically ready in a few seconds. Save a copy if you need it long-term."_

### Pattern B — bytes → storage

Same prompt; the agent emits two tool calls in sequence.

**Call 1 — render to bytes:**

```json
{
  "tool": "call_external_api",
  "args": {
    "url": "https://api.pdfshift.io/v3/convert/pdf",
    "method": "POST",
    "body": {
      "source": "<html><body><h1>Invoice INV-2026-0042</h1>...</body></html>",
      "filename": "invoice-INV-2026-0042.pdf"
    }
  }
}
```

Response: `{ status: 200, body: { encoding: "base64", contentType: "application/pdf", data: "JVBERi0xLjQK..." } }`.

**Call 2 — persist:**

```json
{
  "tool": "upload_to_storage",
  "args": {
    "data": "JVBERi0xLjQK...",
    "contentType": "application/pdf",
    "filename": "invoice-INV-2026-0042.pdf",
    "description": "Invoice INV-2026-0042 for Alice — $250"
  }
}
```

Response: `{ key: "agent-uploads/<agent-id>/invoices/3f...e1.pdf", url: "https://<bucket>.s3.amazonaws.com/...", size: 38421, contentType: "application/pdf", signed: true, expiresAt: "2026-05-13T10:24:00Z" }`.

Agent: _"Done. Your invoice is at https://&lt;bucket&gt;.s3.amazonaws.com/... — the link works for 7 days."_

## 8. Vendor variants

### Self-hosted Gotenberg

```json
{
  "allowedUrlPrefixes": ["https://gotenberg.internal/forms/chromium/convert/html"],
  "auth": { "type": "none" },
  "timeoutMs": 60000,
  "maxResponseBytes": 5242880
}
```

Gotenberg expects multipart form data with an `index.html` file part. The capability accepts a `multipart` arg directly — the LLM emits structured `{ files, fields }`, the HTTP module assembles the FormData, and `fetch()` sets the `multipart/form-data; boundary=…` Content-Type itself. No adapter service required. The agent prompt should describe the call shape:

```
To render HTML to PDF, call call_external_api with:
  - url: https://gotenberg.internal/forms/chromium/convert/html
  - method: POST
  - multipart:
      files:
        - { name: "index.html", contentType: "text/html", data: "<base64 of the HTML>" }
      fields:
        paperWidth: "8.5"
        paperHeight: "11"
```

Per-file size cap is 8 MB base64; total request body cap is 25 MB. HMAC auth is rejected with multipart bodies (multipart can't be HMAC-signed deterministically) — pair Gotenberg with `none` or `basic` auth. The PDF response comes back via the binary auto-wrap (`{ encoding: "base64", contentType: "application/pdf", data: "…" }`) and chains naturally into `upload_to_storage`.

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

- **Multi-page reports.** Beyond ~10 pages the LLM-emitted HTML body becomes too large for a tool call. Move to a workflow that builds the HTML with `llm_call` steps and a final `external_call` step (then an `external_call` to `upload_to_storage` if you want Pattern B retention)
- **Templated rendering.** DocRaptor and similar accept a `document_url` instead of inline `document_content` — point at a template URL on your own host and pass `data` as variables. Reduces the size of the LLM-emitted body
- **Self-hosted with auth.** If your Gotenberg instance is on a public network, front it with Basic auth or an API key check in your reverse proxy. Then bind `call_external_api` with `auth: { type: 'basic', ... }`
- **Public vs signed URLs in Pattern B.** Drop `signedUrlTtlSeconds` for a permanent public URL (suitable for sharing on a public site). Keep it set for time-limited private access (suitable for invoices, receipts, anything user-specific). Signed URLs are S3-only — Vercel Blob URLs are publish-once-public and can be deleted but not signed; local storage has no signing concept
- **Multipart bodies.** Gotenberg expects `multipart/form-data` with file parts. The capability's `multipart` arg covers this directly — no adapter service required. See [`external-calls.md` → Multipart bodies](../external-calls.md) for the full spec.

## 10. Anti-patterns

- ❌ **Bundling a PDF library "for convenience".** That defeats the recipe stance entirely. Use a hosted endpoint or your own renderer behind HTTP. PDF libraries pull in megabytes of native deps and break across Node versions
- ❌ **Letting the LLM render arbitrary HTML containing user-provided JavaScript.** Some renderers execute `<script>` blocks. If the HTML body comes (in part) from the user, sanitise before render. Inject a Content-Security-Policy meta tag in the HTML wrapper
- ❌ **Trying to fit large docs into a tool call.** A 50-page report's HTML can easily exceed the LLM's output budget. Use a workflow, not a tool
- ❌ **Treating Pattern A's vendor URL as long-lived.** Most expire in minutes to days. If the user expects the link to keep working, use Pattern B
- ❌ **Pattern B with a wide-open `keyPrefix`.** Always set `keyPrefix` and `allowedContentTypes` per binding — without them, an agent could write any file type to any path under the bucket. The default prefix `agent-uploads/<agentId>/` is fine for a single-purpose binding; for shared buckets, scope further (`agent-uploads/<agentId>/invoices/`)
- ❌ **Asking the LLM to interpret the base64 `data` field.** Pass it through verbatim. Models will sometimes attempt to "decode" or "summarise" base64 — that's a hallucination, not a real operation

## 11. Test plan

### Pattern A (vendor-hosted URL)

1. Sign up for a DocRaptor sandbox account; set `DOCRAPTOR_BASIC=<api_key>:` in `.env.local`
2. Add `docraptor.com` to `ORCHESTRATION_ALLOWED_HOSTS`
3. Bind `call_external_api` to a test agent with the Pattern A binding
4. Update agent prompt per §6 (Pattern A)
5. Open a chat: _"Render a one-page test PDF that says 'Hello, world'"_
6. **Verify:**
   - The agent's response includes a `docraptor.com/download/...` URL
   - The URL serves a real PDF (open it in a browser)
   - Trace shows the request HTML body and response JSON; **API key not visible**
7. **Negative tests:**
   - Ask the agent to render a 100-page document (should be rejected by prompt or fail the timeout)
   - Ask the agent to render to PDFShift (different host) — should be rejected with `host_not_allowed`
   - Bump `maxResponseBytes` down to 100 and confirm large response gets `response_too_large`

### Pattern B (bytes → storage)

1. Sign up for a PDFShift sandbox; set `PDFSHIFT_API_KEY=<key>:` (trailing colon) in `.env.local`
2. Add `api.pdfshift.io` to `ORCHESTRATION_ALLOWED_HOSTS`
3. Configure storage: set `STORAGE_PROVIDER=s3` (or `local` for dev) plus the relevant credentials
4. Bind both `call_external_api` (Pattern B Step 1) and `upload_to_storage` (Step 2) to a test agent
5. Update agent prompt per §6 (Pattern B)
6. Open a chat: _"Render a one-page test PDF that says 'Hello, world'"_
7. **Verify:**
   - Trace shows two tool calls in sequence — `call_external_api` returning a base64 wrapper, then `upload_to_storage`
   - The final agent message includes a URL on your S3 bucket / Vercel Blob / `localhost:3000/uploads/...`
   - The URL serves a real PDF
   - Storage path matches `keyPrefix` + `<uuid>.pdf` — no LLM-controlled segments
8. **Negative tests:**
   - Drop `signedUrlTtlSeconds` and switch `STORAGE_PROVIDER=local`; the upload returns a public URL (not signed)
   - Set `STORAGE_PROVIDER=vercel-blob` with `signedUrlTtlSeconds` still set — the call fails with `signed_url_not_supported`
   - Restrict `allowedContentTypes` to `["image/png"]` and try the PDF flow — fails with `content_type_not_allowed`
   - Set `maxFileSizeBytes: 1024` and render a large PDF — fails with `file_too_large`

## 12. Related

- [Recipes index](./index.md)
- [`call_external_api` capability](../capabilities.md)
- Sibling: [transactional-email.md](./transactional-email.md) — frequently chained with this recipe (render PDF → email it)
- For multi-step report generation: [Workflows guide](../workflows.md) — better fit than a single tool call past ~10 pages
