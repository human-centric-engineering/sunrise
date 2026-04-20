# Output Guard & Brand Voice

Post-response content policy enforcement for assistant output. Complements the input guard (which scans user messages for prompt injection).

## Output Guard

Scans assistant responses for:

1. **Topic boundary violations** — per-agent forbidden keywords/phrases stored in `AiAgent.topicBoundaries`
2. **PII leaks** — built-in patterns for email addresses, phone numbers, SSNs, and credit card numbers

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

Key export: `scanOutput(content, topicBoundaries) → OutputScanResult`

```typescript
interface OutputScanResult {
  flagged: boolean;
  topicMatches: string[]; // which forbidden topics matched
  builtInMatches: string[]; // which PII patterns matched
}
```

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
