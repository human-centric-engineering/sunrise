# Outbound Channel Adapters

Sister framework to [inbound-triggers](./inbound-triggers.md). Where inbound adapters parse vendor-specific webhooks into Sunrise's normalised shape, **outbound adapters** translate Sunrise's normalised "send this message" request into vendor-specific HTTP dispatches.

The only caller is the [`send_message_to_channel`](./capabilities.md#send_message_to_channel) capability. The capability owns cross-vendor guards (STOP-flag, WhatsApp 24h window, length cap, throttle, idempotency, PII redaction, cost logging); each adapter owns one vendor's REST translation only.

## Provider model

Each provider gets a **paired inbound + outbound adapter** keyed on env vars. When the inbound side of a provider is configured, the outbound side is too — operators don't have to think about which halves to wire.

| Provider | Inbound adapter slug | Outbound adapter `provider` slug | Semantic channels | Required env vars                               |
| -------- | -------------------- | -------------------------------- | ----------------- | ----------------------------------------------- |
| Twilio   | `twilio`             | `twilio`                         | `sms`, `whatsapp` | `TWILIO_AUTH_TOKEN`                             |
| Meta     | `whatsapp_cloud`     | `meta`                           | `whatsapp`        | `WHATSAPP_VERIFY_TOKEN` + `WHATSAPP_APP_SECRET` |

The semantic channel (`sms`, `whatsapp`, future `email`, `slack`, `chat`) is stored on `AiConversation.channel`. The provider slug is stored on `AiConversation.provider`. The capability looks up the registered `OutboundAdapter` by `provider`.

## Adapter interface

```ts
interface OutboundAdapter {
  readonly provider: string;
  readonly supportedChannels: readonly ConversationChannel[];
  readonly configSchema: z.ZodTypeAny;
  send(
    req: OutboundMessageRequest,
    conversation: ConversationContext,
    config: unknown
  ): Promise<OutboundSendResult>;
}
```

`send` MUST throw `OutboundSendError` (with a typed `code`) on any failure — the capability translates the throw into a typed error result for the LLM. Returning `{ status: 4xx }` is a contract violation.

## Capability customConfig shape

The capability's `customConfig` carries one block per provider keyed by provider slug. Each block is validated against that adapter's `configSchema` at dispatch time.

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
      "phoneNumberId": "PHONE_NUMBER_ID_FROM_META_DASHBOARD",
      "costPerMessageUsd": 0.005
    }
  },
  "throttle": { "perConversationPerHour": 5 },
  "allowForceProvider": false
}
```

`accountSidEnv` / `authTokenEnv` / `accessTokenEnv` are **env var names**, not values. Secrets only live in `process.env`; rotation = change one env var.

## Adding a new provider

Adding Vonage / MessageBird / Plivo / ... is **two adapter files + two bootstrap conditionals** — no capability change.

1. **Inbound adapter** under `lib/orchestration/inbound/adapters/vonage.ts`:
   - Implement `InboundAdapter` (channel slug `'vonage'`, `verify`, `normalise`).
   - Set `conversationChannel: 'sms'`, `conversationProvider: 'vonage'`, `fromAddress` (E.164 via `normaliseToE164`) on the `NormalisedTriggerPayload`.
2. **Outbound adapter** under `lib/orchestration/outbound/adapters/vonage.ts`:
   - Implement `OutboundAdapter` (provider slug `'vonage'`, `supportedChannels: ['sms']`, Zod `configSchema`, `send`).
   - Use `executeHttpRequest()` from `lib/orchestration/http` for the actual HTTP call (auth, allowlist, idempotency header, response cap all handled).
   - Throw `OutboundSendError` with the right `code` on failures.
3. **Inbound bootstrap** (`lib/orchestration/inbound/bootstrap.ts`):
   ```ts
   if (process.env.VONAGE_API_SIGNATURE_SECRET) {
     registerInboundAdapter(new VonageAdapter(process.env.VONAGE_API_SIGNATURE_SECRET));
     enabled.push('vonage');
   }
   ```
4. **Outbound bootstrap** (`lib/orchestration/outbound/bootstrap.ts`):
   ```ts
   if (process.env.VONAGE_API_KEY && process.env.VONAGE_API_SECRET) {
     registerOutboundAdapter(new VonageOutboundAdapter());
     enabled.push('vonage');
   }
   ```

That's it. No changes to:

- `send_message_to_channel` capability (provider-agnostic — looks up `getOutboundAdapter(provider)`).
- `AiConversation` schema (the `provider` column is `String?` — accepts any slug).
- `AiOutboundMessage` ledger (same).
- The conversation-resolver (it just passes through the provider slug the inbound adapter set).
- Any workflow definitions.

Operators wire the new provider on a per-agent binding by adding a `providers.vonage` block to their `send_message_to_channel` customConfig.

## Error code mapping

`OutboundSendError.code` values surface verbatim through the capability's `error()` result:

| Code                  | When                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `config_invalid`      | customConfig block fails the adapter's Zod schema, OR the env-var secret is unset    |
| `vendor_unauthorized` | 401 / 403 from the vendor (likely revoked credential)                                |
| `vendor_rate_limited` | 429 from the vendor                                                                  |
| `vendor_unavailable`  | 5xx from the vendor                                                                  |
| `vendor_rejected`     | 4xx (other than auth / rate-limit) or 2xx without the expected transaction id field  |
| `allowlist_blocked`   | The vendor host is not in `ORCHESTRATION_ALLOWED_HOSTS` (raised by the HTTP fetcher) |
| `unknown`             | Any non-`OutboundSendError` exception bubbling out of the adapter                    |

## Anti-patterns

- **Don't bypass the registry.** Looking up a vendor by hard-coded `if (provider === 'twilio')` inside the capability is the lock-in the registry exists to prevent. Always `getOutboundAdapter(provider)`.
- **Don't put credentials in customConfig.** Use env-var names (`accountSidEnv`, `authTokenEnv`) — the secret value lives in `process.env`. The recipe documents this; admin form UX should warn if a user types a value containing characters that look like a real secret.
- **Don't bundle vendor SDKs** (`twilio`, `@whatsapp/business-platform`, ...) — item #3 in the priorities doc explains why. The HTTP fetcher + a thin adapter covers ~all of any vendor's send-message surface in <100 lines.

## Related

- [Inbound triggers](./inbound-triggers.md) — the sister framework for receiving messages.
- [HTTP fetcher](./external-calls.md) — the shared `executeHttpRequest` underneath every adapter.
- [Capabilities](./capabilities.md) — `send_message_to_channel` operator documentation.
- [Recipes: SMS / WhatsApp inbound reply](./recipes/sms-whatsapp-inbound-reply.md) — end-to-end worked example.
