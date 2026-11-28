# PII Redaction at the Capability Layer

The conversation provenance bundle persists capability call arguments and result previews on every assistant message. That gives admins a defensible audit trail, but it also expands the PII surface: an LLM call like `send_email({ to: 'alice@example.com', body: '...' })` would land Alice's email and the body verbatim in `AiMessage.provenance.capabilityCalls[].arguments` on every conversation that uses the capability.

This is a write-time redaction architecture: each capability declares whether it handles PII, and PII-handling capabilities provide an explicit `redactProvenance()` method that returns what's safe to persist. The LLM still sees the un-redacted values (it needs them to do its job); only the durable audit record uses the redacted form.

## The contract

Two members on `BaseCapability` (`lib/orchestration/capabilities/base-capability.ts`):

```typescript
readonly processesPii: boolean;        // default: false

redactProvenance(
  args: TArgs,
  result: CapabilityResult<TData>
): { args: unknown; resultPreview: string };
```

The default implementation passes args through verbatim and produces a JSON-stringified, 480-char-truncated preview of the result — same as the pre-redactor behavior, so non-PII capabilities don't need an override.

PII-handling capabilities **must** opt in by setting `processesPii = true` AND overriding `redactProvenance()`. The registry enforces this pairing — `capabilityDispatcher.register()` throws at server startup if `processesPii` is true and `redactProvenance` is not overridden:

```
Capability "X" declares processesPii=true but does not override
redactProvenance(). PII-handling capabilities must implement
explicit redaction. See .context/security/pii-redaction.md
```

There is no silent fallback. Forgotten redactors fail fast, before any conversation lands on the row.

## The redaction primitives

`lib/security/redact.ts` ships a small set of stateless masking helpers:

| Helper                                      | Output shape                                             |
| ------------------------------------------- | -------------------------------------------------------- |
| `maskEmail('alice@example.com')`            | `'a***@e***.com'` (preserves shape + TLD)                |
| `maskPhone('+44 7700 901234')`              | `'***-***-1234'` (preserves last 4)                      |
| `maskBearerToken('Bearer eyJ...')`          | `'Bearer ****'` (preserves scheme)                       |
| `maskKeysInObject(obj, keys, replacement?)` | Recursive, case-insensitive deep redaction of named keys |
| `redactedString(reason?)`                   | `'<redacted>'` or `'<redacted: reason>'` sentinel        |

Hashing is intentionally not in the kit — a hash of `bob@x.com` is still linkable across rows, which defeats half the point of redacting. Use `redactedString()` when even shape leakage is unwanted.

## A worked example

`call_external_api` carries the highest PII risk in the built-in set: args contain arbitrary HTTP request bodies, headers may carry auth secrets, response bodies routinely contain customer records. The override (excerpt):

```typescript
const AUTH_HEADER_NAMES = [
  'Authorization',
  'Proxy-Authorization',
  'X-Api-Key',
  'Api-Key',
  'X-Auth-Token',
  'X-Access-Token',
  'Cookie',
];

export class CallExternalApiCapability extends BaseCapability<Args, Data> {
  readonly slug = 'call_external_api';
  readonly processesPii = true;

  redactProvenance(args: Args, result: CapabilityResult<Data>) {
    const safeArgs = {
      url: args.url,
      method: args.method,
      headers: args.headers ? maskKeysInObject(args.headers, AUTH_HEADER_NAMES) : undefined,
      body: args.body !== undefined ? redactedString('body') : undefined,
      multipart: args.multipart !== undefined ? redactedString('multipart') : undefined,
      responseExtract: args.responseExtract,
    };
    // Result preview keeps status, drops body
    // ...
  }
}
```

What gets persisted on an assistant message that fires this capability:

```json
{
  "slug": "call_external_api",
  "arguments": {
    "url": "https://api.stripe.com/v1/charges",
    "method": "POST",
    "headers": { "Authorization": "<redacted>", "Content-Type": "application/json" },
    "body": "<redacted: body>"
  },
  "resultPreview": "{\"success\":true,\"data\":{\"status\":200,\"body\":\"<redacted: body>\"}}"
}
```

The url + method are kept verbatim because they're structurally useful for audit ("a payment was attempted at endpoint X"); the body and the response body are removed because they carry the actual customer data.

## Which built-ins ship with overrides

| Capability                                                                                                                 | `processesPii` | What's redacted                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------- |
| `call_external_api`                                                                                                        | `true`         | auth-style headers; body; multipart; response body                     |
| `escalate_to_human`                                                                                                        | `true`         | `reason` (free-text); `metadata`                                       |
| `run_workflow`                                                                                                             | `true`         | `input`; result `output`                                               |
| `read_user_memory`                                                                                                         | `true`         | each memory `value`                                                    |
| `write_user_memory`                                                                                                        | `true`         | `value`                                                                |
| `upload_to_storage`                                                                                                        | `true`         | base64 file bytes                                                      |
| `search_knowledge_base`                                                                                                    | `false`        | (query is already on the conversation; results are citation envelopes) |
| `add_provider_models`, `deactivate_provider_models`, `apply_audit_changes`, `estimate_workflow_cost`, `get_pattern_detail` | `false`        | structural / system args only                                          |

## Authoring a new capability

If your capability handles PII in any of:

- **Arguments** the LLM constructs from user input (emails, phone numbers, names, addresses, IDs, free-text)
- **Results** that echo customer data back from a downstream system
- **Secrets** in headers or auth payloads (you should not be putting these in args anyway — see `customConfig` for the binding-level pattern in `call_external_api`)

…then:

1. Set `readonly processesPii = true` on the class.
2. Override `redactProvenance(args, result)`. Return `{ args, resultPreview }` — the redacted args object and a JSON-stringified preview of the redacted result.
3. Use `lib/security/redact.ts` primitives — domain-aware masking gives the audit row useful shape without leaking the value. `redactedString('field-name')` is the safe default for free-text fields.
4. Add a unit test in `tests/unit/lib/orchestration/capabilities/built-in/` asserting (a) `processesPii === true`, (b) PII fields are redacted, (c) structural fields pass through.

The registry will catch a missing override at startup. The test will catch an over-redacted override that loses audit value.

## What redaction does not cover

This is the capability-layer story. Three sibling PII surfaces sit elsewhere and are handled (or deferred) separately:

(One surface `processesPii` does reach beyond provenance: the MCP audit log withholds a declaring tool's arguments entirely. See [`orchestration/mcp.md`](../orchestration/mcp.md#what-the-audit-log-keeps-of-a-tool-calls-arguments).)

- **KB citation excerpts** (`Citation.excerpt`, up to 400 chars per citation). If the knowledge base contains personal data, excerpts can leak it. Mitigation lives at the document level — see the deferred item for a `containsPii` flag on `AiKnowledgeDocument`.
- **Workflow source snippets** (`ProvenanceItem.snippet`, LLM-emitted). Different shape, different surface; needs its own redactor design.
- **Message content itself**. If the user typed their phone number into the conversation, that's on `AiMessage.content`. Mitigation is a chat-handler-level input scanner, not a capability redactor.

## Audit-of-audits

Every provenance download (JSON or Markdown) is recorded in `AiAdminAuditLog` with action `conversation.provenance_export`. Compliance can answer "who exported this conversation's audit trail, when, in which format" from a single SQL query — see `.context/admin/orchestration-conversations.md` for the download UI and the resulting audit-log entries.
