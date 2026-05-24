# Recipe — SMS / WhatsApp inbound reply

End-to-end recipe for receiving a message from a user via SMS or WhatsApp and replying on the same channel. Covers both Twilio (SMS + Twilio-WhatsApp) and Meta WhatsApp Cloud — one workflow handles all three without per-vendor branching.

## 1. When to use this recipe

Reach for this when your agent needs to **respond to a user who contacted us via a third-party messaging channel** — tenant-rights enquiries via SMS, customer support via WhatsApp, proactive outreach replies, complaint threads. Anything where the embed widget isn't the right surface because the user lives in a messaging app, not on a partner site.

Not for: outbound-only notifications (use `call_external_api` with a Twilio recipe), or chat surfaces on your own website (use the embed widget).

## 2. What you ship

- Inbound webhook(s) on Twilio and/or Meta pointing at Sunrise's `/api/v1/inbound/<adapter>/<trigger-slug>` URL.
- An `AiWorkflowTrigger` row per inbound channel, with `metadata.conversationAgentId` set to the agent that owns the resulting conversations.
- A `send_message_to_channel` capability binding on that agent, with `customConfig.providers` blocks for each provider you support.

## 3. Allowlist hosts

Add the vendor API hosts to `ORCHESTRATION_ALLOWED_HOSTS` (comma-separated). Without this the HTTP fetcher fails clean with `host_not_allowed`.

```bash
ORCHESTRATION_ALLOWED_HOSTS=api.twilio.com,graph.facebook.com
```

For Twilio MMS / Meta media downloads (if you wire vision later), add `api.twilio.com` (already covered) and `lookaside.fbsbx.com` / `mmg.whatsapp.net` for Meta media URLs.

## 4. Credential setup

### Twilio

- **`TWILIO_AUTH_TOKEN`** — Twilio Console → Account Info → Auth Token. Used by the inbound adapter for HMAC-SHA1 verification + the outbound adapter for Basic auth alongside the Account SID.
- **`TWILIO_ACCOUNT_SID`** — Twilio Console → Account Info → Account SID. Referenced by name in the customConfig (`accountSidEnv: 'TWILIO_ACCOUNT_SID'`).
- **(optional) `TWILIO_EXTERNAL_BASE_URL`** — set if your proxy/CDN doesn't set `X-Forwarded-Proto` / `X-Forwarded-Host` headers, or if you need to override them.
- **Twilio phone numbers** — buy SMS-capable and/or WhatsApp-enabled numbers in the Twilio Console. WhatsApp numbers require a Meta-approved sender profile (the Twilio onboarding flow handles this; it can take a few business days).

### Meta WhatsApp Cloud

- **`WHATSAPP_VERIFY_TOKEN`** — a random string you choose. Configured both in your `.env` and in the Meta App Dashboard → WhatsApp → Configuration. Used for the GET subscription handshake.
- **`WHATSAPP_APP_SECRET`** — Meta App Dashboard → Settings → Basic → App Secret. Used for HMAC-SHA256 verification of POST bodies.
- **`WHATSAPP_ACCESS_TOKEN`** — Meta App Dashboard → WhatsApp → API Setup → Permanent Access Token (System User). Referenced by name in customConfig.
- **WhatsApp Phone Number ID** — Meta App Dashboard → WhatsApp → API Setup. A numeric id, not the phone number itself.

## 5. Capability binding

Bind `send_message_to_channel` to the agent. In `AiAgentCapability.customConfig`:

```json
{
  "providers": {
    "twilio": {
      "accountSidEnv": "TWILIO_ACCOUNT_SID",
      "authTokenEnv": "TWILIO_AUTH_TOKEN",
      "fromNumberSms": "+12025550100",
      "fromNumberWhatsapp": "+14155550100",
      "costPerMessageUsd": 0.0075
    },
    "meta": {
      "accessTokenEnv": "WHATSAPP_ACCESS_TOKEN",
      "phoneNumberId": "100123456789012",
      "costPerMessageUsd": 0.005
    }
  },
  "throttle": { "perConversationPerHour": 5 },
  "allowForceProvider": false
}
```

You only need a `providers.<slug>` block for channels you actually use. A binding with only `twilio` ignores Meta inbound traffic and vice versa.

`throttle.perConversationPerHour` caps outbound dispatches per `conversationId` in a trailing hour (default 5). `allowForceProvider` enables the admin `forceProvider` override (false by default — must be explicitly opted in).

## 6. Inbound trigger setup

For each inbound channel, create an `AiWorkflowTrigger`:

```ts
await prisma.aiWorkflowTrigger.create({
  data: {
    name: 'SMS inbound',
    channel: 'twilio', // adapter slug — also 'whatsapp_cloud' for Meta direct
    workflowId: '<your-workflow-id>',
    isEnabled: true,
    createdBy: '<admin-user-id>',
    metadata: {
      conversationAgentId: '<your-agent-id>', // required for conversation enrichment
      eventTypes: ['message'], // filter out status_callback by default
    },
  },
});
```

Without `conversationAgentId` the workflow still runs but no `AiConversation` row is created, and your outbound replies will return `no_inbound_channel`.

Then point the vendor at:

- **Twilio:** `https://<your-sunrise>/api/v1/inbound/twilio/<trigger-slug>` (Twilio Console → phone number → Messaging Configuration → Webhook).
- **Meta:** `https://<your-sunrise>/api/v1/inbound/whatsapp_cloud/<trigger-slug>` (Meta App Dashboard → WhatsApp → Configuration → Callback URL + Verify Token). Meta sends a `GET` first to verify URL ownership.

## 7. Agent prompt guidance

Add to the agent's system instructions:

> You can reply to users who contacted us via SMS or WhatsApp. The platform automatically routes your reply to whichever channel the user used. Use `send_message_to_channel` with the `conversationId` from `triggerMeta.conversationId` in the workflow input. Keep replies under 1600 characters for SMS; under 4096 for WhatsApp. If you need to send a structured message outside the WhatsApp 24-hour conversation window, pass a `template` with an approved Meta template name.

The capability description handles the discovery side — the LLM sees: "Reply to the end-user on whichever channel they originally contacted us on (SMS, WhatsApp, or future channels). The platform automatically routes the message to the correct provider based on the conversation's recorded inbound channel."

## 8. Worked example — inbound triage → reply

A user texts your Twilio number: "Hi, I need help with my booking from yesterday."

1. Twilio POSTs the form-encoded webhook to `/api/v1/inbound/twilio/<slug>`.
2. The TwilioAdapter verifies HMAC-SHA1 over URL + sorted form params, normalises to `{from: '+447400123456', text: 'Hi, I need help...', subChannel: 'sms', conversationChannel: 'sms', conversationProvider: 'twilio', fromAddress: '+447400123456'}`.
3. The route runs `resolveConversation` — find-or-create an `AiConversation` keyed on `(agentId, channel='sms', fromAddress='+447400123456')`, updates `lastInboundAt`.
4. The route inserts `AiWorkflowExecution` with `inputData.triggerMeta.conversationId` set.
5. The workflow fires. The recommended shape (used by the `tpl-inbound-conversation-handler` template) is two steps:
   - **`chat_turn`** — loads prior `AiMessage` rows for this conversation (empty array on the first inbound; populated on every subsequent one), composes `[system, ...history, user]`, calls the agent's provider, persists the new user + assistant turns back to `AiMessage`. Returns the assistant text as the step output.
   - **`tool_call` invoking `send_message_to_channel`** with `conversationId: '{{trigger.conversationId}}'` and `message: '{{respond_to_inbound.output}}'`. The capability call looks like:
     ```json
     {
       "conversationId": "<conv-id>",
       "message": "Hi! I can help with that. Which booking — could you share the reference?"
     }
     ```
6. The capability loads the conversation (channel `sms`, provider `twilio`), runs guards (not opted-out ✓, length OK ✓, throttle 0/5 ✓), creates an `AiOutboundMessage` row with a `dedupKey`, resolves the `twilio` outbound adapter from the registry, delegates `send`.
7. The Twilio outbound adapter POSTs to `https://api.twilio.com/2010-04-01/Accounts/<SID>/Messages.json` with Basic auth, form body `From=+12025550100&To=+447400123456&Body=Hi! I can help...`. Returns 201 with the `MessageSid`.
8. The capability marks the ledger row `sent`, logs cost under `CostOperation.OUTBOUND_MESSAGE` with `metadata: {channel: 'sms', provider: 'twilio', transactionId: 'SM...'}`.
9. Twilio delivers the SMS. The user sees the agent's reply in their messages app.

When the user replies "the reference is XYZ-12345", the next inbound goes through the same pipe but this time the `chat_turn` step loads the prior turns from `AiMessage` first — the agent sees "Hi, I need help with my booking" + "Hi! I can help with that..." + the new "the reference is XYZ-12345" and responds with full context.

If the same user later starts a WhatsApp Cloud conversation (after Meta is wired up), they get a fresh conversation row because the `channel` is different (`whatsapp` vs `sms`), even though the `fromAddress` is the same phone number.

## 9. Vendor variants

### Twilio SMS vs Twilio-WhatsApp

Both flow through the same inbound webhook URL and the same TwilioAdapter. The `whatsapp:` prefix on `From` is the discriminator. The outbound side adds the prefix back when `channel === 'whatsapp'` and uses the `fromNumberWhatsapp` config (vs `fromNumberSms` for SMS).

Twilio's WhatsApp also enforces the 24-hour conversation window — but Twilio handles the template message dispatch differently from Meta. v1 of this recipe documents the Meta-direct template path; Twilio-WhatsApp templates can be sent by passing the template in the `body` field (Twilio-side syntax — see Twilio docs). This adapter currently emits free-text only for Twilio; if you hit the window-expired wall on Twilio-WA, switch the agent to Meta direct (`provider: meta`) for that conversation.

### Meta WhatsApp Cloud — 24-hour window + template approval

Meta enforces that **outbound messages outside a 24-hour conversation window must use a pre-approved template**. Templates are approved in Meta Business Manager → WhatsApp → Message Templates (the approval flow takes hours-to-days).

When the window has expired AND no template is provided, the capability returns `whatsapp_window_expired_template_required`. The agent should:

1. Pass a `template: {name, languageCode, components?}` argument with an approved template.
2. The Meta outbound adapter sends a `type: 'template'` payload instead of `type: 'text'`.

Approved template categories: utility (transactional), authentication (OTP), marketing. Start with utility — Meta's review process is fastest there.

### Adding a third provider (Vonage, MessageBird, Plivo, ...)

See [outbound-adapters.md](../outbound-adapters.md) — three-step process: new inbound adapter file, new outbound adapter file, two bootstrap env-var conditionals. The capability does not change; the customConfig gains a new `providers.<slug>` block per agent binding.

## 10. Common variants

- **MMS images → vision capability.** Twilio sends MMS attachments as `MediaUrl0`, `MediaUrl1`, ... URLs that require Basic auth to fetch. A workflow can chain `send_message_to_channel`'s sister capability (vision) to fetch + classify the image and reply with grounded analysis.
- **Status callbacks.** Twilio fires status callbacks (delivered / failed) on the same URL with `MessageStatus` set. These produce `eventType: 'status_callback'` and are filtered by default (`metadata.eventTypes: ['message']`). To act on delivery failures, add `'status_callback'` to the allow-list and branch in the workflow.
- **Per-conversation outbound history.** `AiOutboundMessage` rows are FK'd to `AiConversation` — query the conversation row's `outboundMessages` for the full thread of platform-side dispatches.

## 11. Anti-patterns

- **Don't auto-chunk long messages.** SMS multi-segment sends are charged per segment and arrive out of order on some carriers. The capability returns `message_too_long` for >1600-char SMS or >4096-char WhatsApp. Have the agent summarise instead.
- **Don't ignore STOP / UNSUBSCRIBE.** TCPA (US) and PECR (UK) require honouring the standard keywords. The conversation-resolver flips `smsOptedOut = true` on first-token match (STOP / UNSUBSCRIBE / CANCEL / END / QUIT) and the outbound capability refuses further dispatches. **Do not** code around this by sending via `call_external_api` directly.
- **Don't hardcode phone numbers in workflow conditions.** Use `triggerMeta.conversationId` to route — the capability handles the address lookup. Workflows that branch on specific phone numbers don't survive provider swaps and leak PII into workflow definitions (which are versioned, exportable, etc.).
- **Don't hardcode a provider in workflow conditions either.** The capability dispatches based on `AiConversation.provider`. A workflow that says `if provider === 'twilio'` defeats the point of the OutboundAdapter abstraction.
- **Don't put credentials in `customConfig`.** Use env-var **names** (`accountSidEnv: 'TWILIO_ACCOUNT_SID'`). The actual secret lives in `process.env`. Rotation = change one env var; no admin form edits.

## 12. Test plan

End-to-end manual smoke (per channel):

1. **Twilio SMS**: text your Twilio number from a real phone → check `AiWorkflowExecution` for a new row → check `AiConversation` for `channel='sms', provider='twilio', fromAddress='+...'` → check the agent replied (the SMS arrives on your phone within seconds).
2. **Twilio WhatsApp**: same flow but from a WhatsApp-enabled number, message your Twilio WhatsApp sender → `AiConversation.channel='whatsapp'` + `provider='twilio'`.
3. **Meta WhatsApp Cloud verification**: Meta App Dashboard → Configuration → click "Verify and Save" on the webhook → expect `200` + the challenge echoed back.
4. **Meta WhatsApp Cloud inbound**: message your Meta-direct WhatsApp number → `AiConversation.channel='whatsapp'` + `provider='meta'`.
5. **STOP keyword**: text `STOP` to your Twilio number → `AiConversation.smsOptedOut` flips to `true` → next outbound returns `recipient_opted_out`. Text `START` → flips back.
6. **WhatsApp 24h window**: wait > 24 hours, try to send free-text → expect `whatsapp_window_expired_template_required`. Pass a `template` → succeeds.

Integration: `tests/integration/api/v1/inbound/[channel]/[slug]/route.test.ts` exercises the cross-workflow dedup, GET handshake, and conversation enrichment paths against a mocked Prisma. Adapter and capability unit tests live under `tests/unit/lib/orchestration/{inbound,outbound,capabilities/built-in}/`.

## 13. Related

- [Outbound adapters framework](../outbound-adapters.md) — how to add a new provider.
- [Inbound triggers](../inbound-triggers.md) — channel slug vs semantic channel, payload tables.
- [Capabilities](../capabilities.md) — `send_message_to_channel` operator reference.
- [External calls](../external-calls.md) — the underlying HTTP fetcher.
- Item #25 in [improvement priorities](../meta/improvement-priorities.md) — email-out threading, the symmetric piece for Postmark inbound.
- Item #28 — live agent handover, pairs naturally with this for regulated-vertical pilots.
