# Recipe: Chat Notification

Post a single message to a chat platform's incoming webhook (Slack, Discord, Microsoft Teams). The simplest recipe in the cookbook — pure HTTP POST to a URL that's itself the secret.

## 1. When to use this recipe

- Agent needs to drop a notification into a team channel: an escalation summary, an alert on a threshold, a daily digest, a "the workflow finished" pulse
- Audience is internal (team channel, ops alerts) — not end users
- The message is single-shot — no threading, no reactions, no two-way interaction

**Don't use this recipe for:** building a bot that participates in channel conversations (that wants the platform's full Bot API + event subscriptions, not a webhook), DMs (most webhook URLs target a specific channel), or anything that needs to delete / edit messages.

## 2. What you ship

- An entry in `ORCHESTRATION_ALLOWED_HOSTS` for the platform's webhook host
- One env var holding the webhook URL
- A binding of `call_external_api` to the agent that **forces the URL via `customConfig`** (see §5 — the LLM should not be choosing webhook URLs)
- Optional HMAC signing if the platform supports it (Slack does, signed `x-slack-signature`; Teams does not)

## 3. Allowlist hosts

| Vendor                  | Add to `ORCHESTRATION_ALLOWED_HOSTS`                 |
| ----------------------- | ---------------------------------------------------- |
| Slack incoming webhook  | `hooks.slack.com`                                    |
| Discord webhook         | `discord.com`                                        |
| Microsoft Teams webhook | `<tenant>.webhook.office.com` (per-tenant subdomain) |

## 4. Credential setup

The webhook URL is the credential — anyone who has it can post. Treat it as a secret.

| Vendor  | Env var               | Format                                           |
| ------- | --------------------- | ------------------------------------------------ |
| Slack   | `SLACK_WEBHOOK_URL`   | `https://hooks.slack.com/services/T.../B.../...` |
| Discord | `DISCORD_WEBHOOK_URL` | `https://discord.com/api/webhooks/<id>/<token>`  |
| Teams   | `TEAMS_WEBHOOK_URL`   | `https://<tenant>.webhook.office.com/...`        |

Rotate webhook URLs annually or whenever a team member with access leaves.

## 5. Capability binding

Worked example: Slack incoming webhook.

The webhook URL is the credential — the LLM should not need to know it. Bind it via `forcedUrl` so the agent can call the capability without ever seeing the URL:

```json
{
  "forcedUrl": "https://hooks.slack.com/services/T01.../B02.../xyzabc",
  "forcedHeaders": { "Content-Type": "application/json" },
  "auth": { "type": "none" },
  "defaultResponseTransform": { "type": "template", "expression": "ok" },
  "timeoutMs": 10000,
  "maxResponseBytes": 1024
}
```

When `forcedUrl` is set, the LLM-supplied `url` arg is discarded and the binding-pinned URL is used. The capability function definition allows omitting `url` entirely, so the agent prompt can describe the tool as "post a message" without the LLM needing to pick a URL. The host (`hooks.slack.com`) still has to be in `ORCHESTRATION_ALLOWED_HOSTS` — `forcedUrl` is a binding constraint, not an allowlist bypass.

Storing the actual webhook URL in `customConfig` is acceptable for chat webhooks because the URL itself is the credential and is scoped per-channel. Rotate the webhook URL (and update the binding) annually or when team access changes. If you'd rather keep the URL in env vars only, use the env-templated form below.

### Alternative: env-templated `forcedUrl` (recommended for shared deployments)

If your org requires secrets to live in env vars only and never in DB columns, reference the env var via the `${env:VAR_NAME}` template:

```json
{
  "forcedUrl": "${env:SLACK_WEBHOOK_URL}",
  "forcedHeaders": { "Content-Type": "application/json" },
  "auth": { "type": "none" },
  "defaultResponseTransform": { "type": "template", "expression": "ok" },
  "timeoutMs": 10000,
  "maxResponseBytes": 1024
}
```

The literal template string stays in `customConfig`; the env var is resolved on every call against `process.env`. Same fail-closed posture as `auth.secret` — a missing env var refuses the call rather than silently downgrading. Rotation = change one env var, no binding edit.

The binding-save API surfaces a soft warning (`meta.warnings.missingEnvVars`) when a referenced env var isn't set in the running process — the binding still saves so admins can wire the env var afterwards. See `.context/orchestration/external-calls.md` for the full templating rules.

## 6. Agent prompt guidance

Append to the agent's system instructions:

```
You can post a single notification to the team Slack channel via the `call_external_api` tool. The destination URL is configured by the admin — you don't need to specify it. Call:
  - method: POST
  - body: { "text": "<the message>", "blocks": [optional Slack Block Kit blocks] }

POLICY:
  - Only post to Slack when explicitly asked or when the conversation policy authorises it (e.g. "send the weekly digest").
  - Keep messages short (under 2000 chars) — long messages get truncated.
  - Use blocks for structured layouts; plain text otherwise.
  - Never include API keys, customer PII, or anything that would not be appropriate in a public team channel in the message body.
```

The URL never appears in the agent prompt or the trace — `forcedUrl` keeps it out of LLM context entirely. **If the URL leaks via the binding's `customConfig`, rotate the webhook.**

## 7. Worked example

User: _"Post to the team channel that the daily ingestion job finished — 142 documents processed, 3 errors."_

LLM emits (no URL — bindings supply it via `forcedUrl`):

```json
{
  "tool": "call_external_api",
  "args": {
    "method": "POST",
    "body": {
      "text": "Daily ingestion finished: 142 documents processed, 3 errors.",
      "blocks": [
        {
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": ":white_check_mark: *Daily ingestion finished*\n• Processed: 142\n• Errors: 3"
          }
        }
      ]
    }
  }
}
```

Capability dispatcher resolves the binding's `forcedUrl` and sends:

```http
POST /services/T01.../B02.../xyzabc HTTP/1.1
Host: hooks.slack.com
Content-Type: application/json

{"text":"Daily ingestion finished: 142 documents processed, 3 errors.","blocks":[...]}
```

Slack response: `200 OK` with body `ok`.

After response transform: `{ status: 200, body: "ok" }`.

Agent: _"Posted to the team channel."_

## 8. Vendor variants

### Discord

```json
{
  "forcedUrl": "https://discord.com/api/webhooks/<id>/<token>",
  "forcedHeaders": { "Content-Type": "application/json" },
  "defaultResponseTransform": { "type": "template", "expression": "posted: {{id}}" },
  "timeoutMs": 10000,
  "maxResponseBytes": 4096
}
```

Discord body: `{ "content": "the message", "username": "optional override", "embeds": [...] }`. Discord returns 204 No Content (or 200 with the message JSON if `?wait=true` query is appended).

### Microsoft Teams (Connector webhooks)

```json
{
  "forcedUrl": "https://<tenant>.webhook.office.com/...",
  "forcedHeaders": { "Content-Type": "application/json" },
  "defaultResponseTransform": { "type": "template", "expression": "posted" },
  "timeoutMs": 10000,
  "maxResponseBytes": 1024
}
```

Teams body: MessageCard schema or Adaptive Card. Returns `1` on success.

### Slack signed webhooks (HMAC verification by Slack on inbound — N/A here)

Outbound webhooks don't sign. If you migrate to Slack's chat.postMessage Web API, that's a different shape (requires bearer auth) — see the auth.type: 'bearer' path with `https://slack.com/api/chat.postMessage`.

## 9. Common variants

- **Threading.** Slack incoming webhooks don't support threading (you can't pass `thread_ts`). For threads, use `chat.postMessage` with bearer auth — different recipe / capability binding
- **Mentions.** Slack: `<@USER_ID>` in `text` notifies the user. Discord: `<@user_id>`. Teams: `<at>...</at>` inside an Adaptive Card
- **Throttling.** Slack rate-limits incoming webhooks at ~1/sec per webhook URL with bursts. Set `ORCHESTRATION_OUTBOUND_RATE_LIMIT` low for Slack-heavy agents
- **Env-templated `forcedUrl`.** `forcedUrl: "${env:SLACK_WEBHOOK_URL}"` resolves on every call so the URL stays in env vars only. See §5 (Alternative)
- **Multi-channel.** Bind `call_external_api` once per channel (each with its own `customConfig` and `forcedUrl`). The LLM picks which channel by which capability slug it calls — give them descriptive names like `notify_eng_channel` if you wrap them, or just rely on prompt guidance

## 10. Anti-patterns

- ❌ **Hardcoding the webhook URL in `forcedHeaders` as a plaintext value.** Use the `${env:VAR}` substitution or `allowedUrlPrefixes: ["${env:VAR}"]` so the URL stays in env vars
- ❌ **Letting the LLM compose the channel URL from parts the user supplies.** If the agent reads "post to channel X" and constructs a URL, an attacker can make X be a Slack admin URL or a phishing URL. Always lock the URL via the binding
- ❌ **Posting customer PII, secrets, or financial data.** Slack channels are searchable by everyone in the channel. Audit what the agent might emit before binding
- ❌ **Sending the same notification on every retry.** Agent loops + tool retries can flood a channel. Use idempotency by attaching a deduplication ID in the message body and have the receiver dedupe (Slack doesn't dedupe natively)
- ❌ **Treating the response as actionable signal.** Slack returns `200 ok` for nearly everything; the message might still be invisible due to channel archival, app uninstall, etc. Don't have the agent treat 200 as "user definitely saw it"

## 11. Test plan

1. Create a test webhook in your Slack workspace (Slack → Apps → Incoming Webhooks → Add to channel `#test-bot-output`)
2. Set `SLACK_WEBHOOK_URL=<the URL>` in `.env.local`
3. Add `hooks.slack.com` to `ORCHESTRATION_ALLOWED_HOSTS`
4. Bind `call_external_api` to a test agent with the §5 binding, embedding the URL in the agent prompt
5. Open a chat: _"Post 'hello from sunrise' to the team channel"_
6. **Verify:**
   - Message appears in `#test-bot-output`
   - Trace shows the request body
   - Response is `ok`
7. **Negative tests:**
   - Ask the agent to post to `https://evil.com/log` — should be rejected with `host_not_allowed` (different host) or `url_not_allowed` (right host, wrong path)
   - Ask the agent to post to a different Slack URL (use a placeholder) — should be rejected with `url_not_allowed`
   - Set `SLACK_WEBHOOK_URL=` empty — binding-save should fail or the call should fail with `host_not_allowed` (the prefix becomes empty string which matches nothing)

## 12. Related

- [Recipes index](./index.md)
- [`call_external_api` capability](../capabilities.md)
- Sibling: [transactional-email.md](./transactional-email.md) — same single-shot send pattern but for email
- Related: [Webhook events](../hooks.md) — for the **other** direction (Sunrise emitting webhooks to listeners)
