# Recipe: Transactional Email

Send a single transactional email (booking confirmation, password reset, receipt, escalation summary) via a hosted email provider's REST API. No SDK bundled — the recipe wires `call_external_api` directly against Postmark / SendGrid / Resend / AWS SES REST endpoints.

## 1. When to use this recipe

- Agent needs to send one transactional email at a time, triggered by the conversation (e.g. "email me the summary", "confirm the booking to the guest", "send the escalation report to the on-call inbox")
- One-recipient or small-list (≤10) sends from a single sender identity
- Provider has a JSON REST endpoint that returns a message ID

**Don't use this recipe for:** marketing campaigns, list management, A/B-tested templates, scheduled drip sequences. Those want a marketing-automation tool with its own UI, not an LLM tool call.

## 2. What you ship

- An entry in `ORCHESTRATION_ALLOWED_HOSTS` for the chosen provider
- One env var with the provider's API token
- A binding of `call_external_api` to the agent with the recipe's `customConfig`
- A short addition to the agent's system instructions

No new code, no migrations, no UI changes.

## 3. Allowlist hosts

Add **only** the host(s) for the provider(s) you actually use. Do not blanket-allow vendor domains.

| Vendor         | Add to `ORCHESTRATION_ALLOWED_HOSTS`                                  |
| -------------- | --------------------------------------------------------------------- |
| Postmark       | `api.postmarkapp.com`                                                 |
| SendGrid       | `api.sendgrid.com`                                                    |
| Resend         | `api.resend.com`                                                      |
| AWS SES (REST) | `email.<region>.amazonaws.com` (e.g. `email.eu-west-1.amazonaws.com`) |

## 4. Credential setup

| Vendor         | Env var (name is your choice; the binding references it) | Value format                                                                                                   |
| -------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Postmark       | `POSTMARK_SERVER_TOKEN`                                  | Server token from Postmark → Servers → API Tokens                                                              |
| SendGrid       | `SENDGRID_API_KEY`                                       | API key with `mail.send` scope only — do not use a full-access key                                             |
| Resend         | `RESEND_API_KEY`                                         | API key from Resend dashboard                                                                                  |
| AWS SES (REST) | `AWS_SES_BASIC`                                          | Either pre-signed SigV4 credentials (advanced) or use SES SMTP creds via Basic auth: `<smtp-user>:<smtp-pass>` |

Set the var in `.env.local` for dev and through your secret manager in prod. The binding references the **env var name**, never the value.

## 5. Capability binding

Worked example: Postmark. Save this as the `customConfig` on the `AiAgentCapability` row.

```json
{
  "allowedUrlPrefixes": ["https://api.postmarkapp.com/email"],
  "auth": {
    "type": "api-key",
    "secret": "POSTMARK_SERVER_TOKEN"
  },
  "forcedHeaders": {
    "Accept": "application/json",
    "X-Postmark-Server-Token-Auth": "ignored-postmark-uses-api-key-header"
  },
  "defaultResponseTransform": {
    "type": "jmespath",
    "expression": "{messageId: MessageID, to: To, errorCode: ErrorCode}"
  },
  "timeoutMs": 15000,
  "maxResponseBytes": 32768
}
```

Postmark uses an `X-Postmark-Server-Token` header for auth; the recipe maps `auth.type: 'api-key'` to that header by setting `forcedHeaders` to the right header name (Postmark validates the header name precisely). For providers that use `Authorization: Bearer ...` (SendGrid, Resend), use `auth.type: 'bearer'` and remove the `X-Postmark-...` line — see [Vendor variants](#8-vendor-variants).

> **Note on Postmark's auth header.** Postmark uses `X-Postmark-Server-Token` rather than the generic `X-API-Key`. The HTTP module's built-in `api-key` mode sets `X-API-Key`. To match Postmark's expected header name, set the auth via `forcedHeaders: { "X-Postmark-Server-Token": "<value>" }` — but that requires putting the secret in config. **Better:** use `auth.type: 'bearer'` only when the vendor uses `Authorization: Bearer`, and for vendors with custom header names like Postmark, raise an issue / extend the HTTP module's auth options. **For Postmark specifically, the simplest correct binding is to use `forcedHeaders` with a templated value via env-var resolution at admin-binding time** — see the workaround in the next subsection.

### Postmark-specific workaround

Until the HTTP module supports custom-named single-secret-header auth, bind Postmark via `forcedHeaders` referencing an env-resolved value at admin save time. The simplest correct binding:

```json
{
  "allowedUrlPrefixes": ["https://api.postmarkapp.com/email"],
  "auth": { "type": "none" },
  "forcedHeaders": {
    "X-Postmark-Server-Token": "${env:POSTMARK_SERVER_TOKEN}",
    "Accept": "application/json"
  },
  "defaultResponseTransform": {
    "type": "jmespath",
    "expression": "{messageId: MessageID, to: To, errorCode: ErrorCode}"
  },
  "timeoutMs": 15000,
  "maxResponseBytes": 32768
}
```

The `${env:VAR}` template syntax is resolved at binding-save time by the admin API, not at request time, so the resolved secret value is stored in DB. This is acceptable for Postmark because their server tokens are scoped per-server. For vendors with broader-scoped tokens (SendGrid, Resend) prefer the `auth.type: 'bearer'` path which keeps secrets out of the DB entirely.

## 6. Agent prompt guidance

Append to the agent's system instructions:

```
You can send transactional emails via the `call_external_api` tool. To send an email, call the tool with:
  - url: https://api.postmarkapp.com/email
  - method: POST
  - body: { "From": "<your verified sender>", "To": "<recipient>", "Subject": "<subject>", "TextBody": "<plain text>", "HtmlBody": "<optional html>" }

Only send emails when the user has clearly asked for one or when the conversation policy explicitly authorises it. Confirm the recipient address before sending. After sending, tell the user the email has been sent and quote the messageId from the response.
```

Adjust the policy guardrails to match your deployment — most pilots want explicit user confirmation before any email leaves.

## 7. Worked example

User: _"Please email me a summary of this conversation. My address is alice@example.com."_

Agent decides to call the tool. The LLM emits:

```json
{
  "tool": "call_external_api",
  "args": {
    "url": "https://api.postmarkapp.com/email",
    "method": "POST",
    "body": {
      "From": "agent@yourcompany.com",
      "To": "alice@example.com",
      "Subject": "Conversation summary",
      "TextBody": "Here is the summary you requested:\n\n…"
    }
  }
}
```

Capability dispatcher merges the binding's `customConfig`, builds the request:

```http
POST /email HTTP/1.1
Host: api.postmarkapp.com
Content-Type: application/json
Accept: application/json
X-Postmark-Server-Token: <resolved from POSTMARK_SERVER_TOKEN>

{"From":"agent@yourcompany.com","To":"alice@example.com","Subject":"Conversation summary","TextBody":"Here is the summary you requested:\n\n…"}
```

Postmark response (200):

```json
{
  "To": "alice@example.com",
  "SubmittedAt": "2026-05-02T10:34:21.123Z",
  "MessageID": "abc-123-def",
  "ErrorCode": 0,
  "Message": "OK"
}
```

After the binding's `defaultResponseTransform` runs, the LLM sees:

```json
{
  "status": 200,
  "body": { "messageId": "abc-123-def", "to": "alice@example.com", "errorCode": 0 }
}
```

The agent replies: _"I've sent the summary to alice@example.com (message ID `abc-123-def`)."_

## 8. Vendor variants

### SendGrid

```json
{
  "allowedUrlPrefixes": ["https://api.sendgrid.com/v3/mail/send"],
  "auth": { "type": "bearer", "secret": "SENDGRID_API_KEY" },
  "forcedHeaders": { "Content-Type": "application/json" },
  "defaultResponseTransform": { "type": "template", "expression": "messageId: {{x-message-id}}" },
  "timeoutMs": 15000,
  "maxResponseBytes": 4096
}
```

Body shape changes — SendGrid uses `personalizations`, `from`, `subject`, `content[]`. SendGrid returns 202 with no JSON body and the message ID in the `x-message-id` header; the response transform extracts it.

### Resend

```json
{
  "allowedUrlPrefixes": ["https://api.resend.com/emails"],
  "auth": { "type": "bearer", "secret": "RESEND_API_KEY" },
  "defaultResponseTransform": { "type": "jmespath", "expression": "id" },
  "timeoutMs": 15000,
  "maxResponseBytes": 4096
}
```

Body: `{ "from": "...", "to": ["..."], "subject": "...", "html": "..." }`. Returns `{ id: "..." }`.

### AWS SES (REST)

```json
{
  "allowedUrlPrefixes": ["https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails"],
  "auth": { "type": "basic", "secret": "AWS_SES_BASIC" },
  "timeoutMs": 15000,
  "maxResponseBytes": 4096
}
```

Body shape follows the SES v2 API. Auth via SES SMTP credentials in Basic format — for full SigV4 use a sidecar signing proxy or migrate to a dedicated `AwsSesCapability` (out of recipe scope).

## 9. Common variants

- **HTML + plain-text together.** Always include both `TextBody` and `HtmlBody` (Postmark) / `text` and `html` (SendGrid, Resend). Improves deliverability and is required for some clients
- **CC / BCC.** Most providers accept comma-separated `Cc` / `Bcc` strings. Cap the count at 10 to stay inside the recipe's small-list scope
- **Attachments.** Inline base64 attachments work for sub-100KB files (Postmark `Attachments`, SendGrid `attachments`). For larger attachments, upload to object storage first and link to a download URL — the LLM-bound tool call should not handle large binary payloads
- **Templated emails.** Postmark templates (`/email/withTemplate`), SendGrid Dynamic Templates, and Resend templates are all another POST endpoint with a different `allowedUrlPrefixes` value. Bind a separate `call_external_api` instance if you want both transactional and templated paths

## 10. Anti-patterns

- ❌ **Putting the API key in `body` or `headers` from the LLM args.** Use `customConfig.auth` so the LLM never sees the secret. Anything in `args` is visible in the conversation transcript and trace
- ❌ **Skipping the `allowedUrlPrefixes` guard.** Without it, the LLM could POST to `/server/<id>` (admin endpoints) on the same host. Always set it
- ❌ **Letting the LLM choose the `From:` address freely.** Hardcode it via `forcedHeaders` or a `body` template at binding time. Otherwise the agent can spoof any sender
- ❌ **Sending the same message twice on retries.** Email APIs are not natively idempotent. If you set the workflow / chat handler to retry on transient failures, attach an `idempotencyKey` (only Resend honours it; for others, deduplicate at your application layer)
- ❌ **No rate limit consideration.** Postmark allows 300/sec, SendGrid 600/sec — but a chatty agent looping over a list will hit it. Use the global outbound rate limiter (`ORCHESTRATION_OUTBOUND_RATE_LIMIT`) to cap

## 11. Test plan

1. Set `ORCHESTRATION_ALLOWED_HOSTS=api.postmarkapp.com` in `.env.local`
2. Set `POSTMARK_SERVER_TOKEN=<your sandbox token>` (Postmark provides a sandbox server that returns success responses without delivering)
3. Bind `call_external_api` to a test agent with the binding from §5
4. Update the agent's system instructions per §6
5. Open a chat with the agent: _"Send a test email to test@example.com"_
6. **Verify:**
   - The agent's response includes a Postmark message ID
   - The trace viewer shows the tool call with `body` → `{From, To, Subject, TextBody}`
   - The trace viewer shows the response with `MessageID`
   - **The trace viewer does NOT show the API token anywhere** — neither in `args`, in `headers`, nor in the response. The token is resolved server-side and stripped from logs
7. **Negative tests:** ask the agent to send to an obviously invalid address, ask it to POST to `/server/123` (should be blocked by `allowedUrlPrefixes`), set `POSTMARK_SERVER_TOKEN=` to empty and confirm the call fails with `auth_failed` rather than sending unauthenticated

## 12. Related

- [Recipes index](./index.md)
- [`call_external_api` capability](../capabilities.md)
- [Outbound rate limit](../external-calls.md) — how to cap egress to a vendor
- Sibling: [chat-notification.md](./chat-notification.md) — also a "send a single message" pattern, but for chat platforms instead of email
