# Output Guard & Brand Voice

Post-response content policy enforcement for assistant output. Complements the input guard (which scans user messages for prompt injection).

## Output Guard

Scans assistant responses for:

1. **Topic boundary violations** — per-agent forbidden keywords/phrases stored in `AiAgent.topicBoundaries`
2. **Identifier leaks** — email addresses, phone numbers, NI and NHS numbers, card and bank details, passports, keys and the rest of the LLM privacy layer's tier A rules (`core.rules`), run through the privacy registry. An identifier the conversation itself supplied — the user's own email repeated back, a phone number a tool returned, a value the privacy layer restored — is not flagged. Labels are `pii_<type>` (`pii_email`, `pii_uk_nino`, `pii_card_number`, …). See [LLM Privacy Layer](../privacy/llm-privacy-layer.md).

### Configuration

**Per-agent** (`AiAgent` model):

| Field                    | Type       | Default | Description                                   |
| ------------------------ | ---------- | ------- | --------------------------------------------- |
| `topicBoundaries`        | `String[]` | `[]`    | Forbidden keywords/phrases (case-insensitive) |
| `brandVoiceInstructions` | `String?`  | `null`  | Brand voice prompt appended to system prompt  |

**Global** (`AiOrchestrationSettings`):

| Field             | Type     | Default    | Description                              |
| ----------------- | -------- | ---------- | ---------------------------------------- |
| `outputGuardMode` | `String` | `log_only` | `log_only`, `warn_and_continue`, `block` |

### Modes

| Mode                | Behaviour                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `log_only`          | Log the violation, deliver the response unchanged                                                     |
| `warn_and_continue` | Log + emit a `warning` SSE event alongside the response                                               |
| `block`             | Log + emit an `error` SSE event after streaming completes; client should discard the flagged response |

### How It Works

The guard runs after each complete assistant response in `StreamingChatHandler`, before the `done` event:

```
User message → Input guard → LLM → Assistant text → Output guard → Done
```

In `block` mode, the assistant text has already been streamed to the client (SSE is real-time), but the final `error` event signals the client to discard or flag the response. The message is still persisted for audit purposes.

### Module

```
lib/orchestration/chat/output-guard.ts
```

Key exports: `scanOutput(content, topicBoundaries, supplied?) → Promise<OutputScanResult>` and `scanCitations(content, citations) → CitationScanResult`.

`supplied` is the messages the call sent the model (system prompt, user turns, tool results); an identifier found in them is not flagged in the reply. `options.ignoredEntityTypes` is the LLM privacy settings' `privacyIgnoredEntityTypes`, which the chat handler passes so one admin choice governs both. A value counts as supplied when one message contains it as people write it — case ignored, spaces and `- . ( ) /` allowed between its characters, so `07911 123 456` matches `07911123456` — standing on its own: no letter or digit right before or after it. Each message is checked on its own, so a sort code is not "supplied" because its digits sit inside an order reference or run across two messages.

**Which detector runs.** Only `core.rules`, or the app detector registered with `replace: 'core.rules'` (`runPrivacyDetectors(text, { detectorIds })`), so an app's replacement applies here too — unless that replacement's egress is `external`. The guard runs in every privacy mode, `off` included, so an external detector would receive every reply without any setting having sent it there; the identifier check is then skipped. Names (tier C) are not checked: a famous name would be flagged, and `block` discards the reply. A US SSN-shaped number is no longer flagged; the old four patterns were US-centric. A scan that runs out of time (2 s), or whose detector fails, flags nothing rather than hold the turn, and logs `output-guard: identifier scan incomplete` with the detector's id.

```typescript
interface OutputScanResult {
  flagged: boolean;
  topicMatches: string[]; // which forbidden topics matched
  builtInMatches: string[]; // pii_<type> for each identifier type the conversation did not supply
}

interface CitationScanResult {
  flagged: boolean;
  underCited: boolean; // citations exist but no [N] marker in the text
  hallucinatedMarkers: number[]; // markers referenced that have no citation
}
```

## Citation Guard

When a turn produces citations (currently `search_knowledge_base`), the handler runs a second guard that validates marker hygiene against the accumulated citation envelope. Two failure modes are detected:

- **Under-citation** — citations exist but no `[N]` marker appears in the response. The model retrieved sources and ignored them.
- **Hallucinated marker** — a `[N]` marker appears in the response but no citation in the envelope carries that marker. The model invented a reference.

The guard is **vacuously passing** when no citations were produced — non-RAG turns are never flagged.

### Configuration

**Per-agent** (`AiAgent` model):

| Field               | Type      | Default | Description                                                           |
| ------------------- | --------- | ------- | --------------------------------------------------------------------- |
| `citationGuardMode` | `String?` | `null`  | `log_only`, `warn_and_continue`, `block`, or `null` to inherit global |

**Global** (`AiOrchestrationSettings`):

| Field               | Type     | Default    | Description                              |
| ------------------- | -------- | ---------- | ---------------------------------------- |
| `citationGuardMode` | `String` | `log_only` | `log_only`, `warn_and_continue`, `block` |

### Modes

| Mode                | Behaviour                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `log_only`          | Log the violation, emit citations + done unchanged (default)                                                       |
| `warn_and_continue` | Log + emit a `warning` SSE event with `code: 'citation_missing'` or `'citation_hallucinated'` before `done`        |
| `block`             | Log + emit a terminal `error` SSE event with `code: 'citation_required'`; the response is not surfaced to the user |

The check runs on the **terminal** assistant turn only (no pending tool calls), since the model has not yet consumed the augmented tool results on interim turns.

### Heuristic limitations

The marker scan is intentionally simple — a global regex against the full text. Known limitations:

- `[N]` patterns inside fenced code blocks are treated as ordinary markers. A future iteration may add code-fence-aware skipping.
- The check verifies _presence_ of at least one valid marker, not the _density_ of citations relative to claims. A response that quotes one source but makes five claims passes. Tighter checks (sentence-level marker density, semantic faithfulness scoring) belong in the named-evaluation suite, not in this regex pass.

## Brand Voice

The `brandVoiceInstructions` field on `AiAgent` is appended to the system prompt as a `[Brand Voice]` section. This is injected by the message builder before the LLM sees the conversation.

Example value:

```
Always respond in a warm, professional tone. Use "we" instead of "I".
Avoid jargon — explain technical concepts in simple terms.
Never use exclamation marks.
```

This becomes part of the system prompt:

```
{agent's system instructions}

[Brand Voice]
Always respond in a warm, professional tone. Use "we" instead of "I".
...
```

## Design Notes

- The output guard is a **heuristic safety net**, not a hard security boundary. The primary defense is always the system prompt (via `systemInstructions` and `brandVoiceInstructions`).
- Topic boundary matching is substring-based and case-insensitive. This catches obvious violations but won't detect paraphrased or euphemistic references.
- PII patterns are conservative — they may produce false positives on content that legitimately discusses email formats or phone number patterns.
- The guard never logs message content, only the labels of matched patterns.
- The citation guard is opt-in via `citationGuardMode` and degrades to a no-op when no citations were produced — it does not penalise general-knowledge responses or chit-chat.
