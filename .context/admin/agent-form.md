# Agent form

Shared create/edit form for `AiAgent`. Eight shadcn tabs, one underlying `<form>`, one POST (create) or PATCH (edit). Landed in Phase 4 Session 4.2; this is the **reference implementation** of the `<FieldHelp>` contextual-help directive — later sessions copy the voice, not just the structure.

**File:** `components/admin/orchestration/agent-form.tsx`
**Pattern:** raw `react-hook-form` + `zodResolver(agentFormSchema)`, no shadcn Form wrapper (mirrors `components/admin/feature-flag-form.tsx`).
**Persistence:** one submit writes one request — tabs are layout, not save boundaries.

## Tab structure

| #   | Tab           | Create | Edit | Notes                                                                                                                                                                                                                  |
| --- | ------------- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | General       | ✅     | ✅   | Name, slug, description, **inherit from profile**, active, **visibility**, retention days                                                                                                                              |
| 2   | Model         | ✅     | ✅   | Provider, **fallback providers**, model, temperature, max tokens, budget, **rate limit RPM**, test conn                                                                                                                |
| 3   | Instructions  | ✅     | ✅   | **Persona**, system instructions, **guardrails**, **brand voice** (all three inheritable from profile with override/append mode), **effective prompt preview**, knowledge, topic boundaries, history panel (edit only) |
| 4   | Capabilities  | 🚫     | ✅   | Attach/detach, isEnabled, customConfig                                                                                                                                                                                 |
| 5   | Invite tokens | 🚫     | ✅\* | Token CRUD table; only enabled when `visibility = 'invite_only'`                                                                                                                                                       |
| 6   | Versions      | 🚫     | ✅   | Full config version history with restore                                                                                                                                                                               |
| 7   | Test          | 🚫     | ✅   | Embeds the shared admin `<ChatInterface>` against this agent                                                                                                                                                           |
| 8   | Embed         | 🚫     | ✅   | `<EmbedConfigPanel>` stacks two cards: **Appearance & copy** (per-agent widget colours / fonts / copy / starters) + **Tokens** (create, copy `<script>` snippet, toggle active, manage origins)                        |

Tabs 4–8 are `disabled` in create mode — they require a persisted `agent.id`. Tab 5 additionally requires `visibility = 'invite_only'` — it is disabled for other visibility modes.

## Tab 1 — General

Fields: `name`, `slug`, `description`, `isActive`, `visibility`.

### Visibility select

Select with three options: `internal` (default), `public`, `invite_only`. Controls who can access the agent via the consumer chat API. Placed after the Active toggle.

**Slug auto-generation:** In create mode, typing into `name` auto-fills `slug` via `toSlug()` (lowercase, hyphenate, strip non-`[a-z0-9-]`). The moment the user types into the slug input, a local `slugTouched` flag turns off auto-gen. In edit mode, slug auto-generation is disabled (`slugTouched = true` on mount), but the field remains editable. System agent slugs are protected server-side — the PATCH handler rejects slug changes when `isSystem` is true. Both the form and the duplicate dialog validate slugs client-side with `slugSchema` (lowercase alphanumeric with single hyphens).

### Help copy

- **Name** — "A human-readable label. This is what admins and end-users see in lists and in the chat UI."
- **Slug** — "The stable identifier used in URLs and the chat stream endpoint. Auto-generated from the name on first type, but you can edit it. Lowercase letters, numbers, and hyphens only."
- **Description** — "One or two sentences explaining what this agent is for. Shown to other admins on the list page — keep it short."
- **Active** — "Inactive agents are hidden from consumer lists and reject new chats. Existing conversations, cost logs, and history are preserved. Default: on."

## Tab 2 — Model

### Provider select

Hydrated from `GET /providers` on the server. Each option shows the provider name plus a `● key set` / `● no key` badge (derived from `apiKeyEnvVar` being set). If server-side hydration fails, the Select is replaced with a free-text `<Input>` and an amber warning banner appears at the top of the tab — the form never throws.

### Model select

Hydrated from `GET /models`, filtered to the selected provider. Options are labelled `${id} — ${tier}`. Same free-text fallback on hydration failure.

### Dynamic resolution: empty provider/model

The 5 system-seeded agents (pattern-advisor, quiz-master, mcp-system, provider-model-auditor, audit-report-writer) ship with **empty `provider`/`model` strings**. At runtime, `lib/orchestration/llm/agent-resolver.ts` fills the binding from the operator's first active provider plus the system default-chat model in `AiOrchestrationSettings.defaultModels.chat`. The agent form's Zod schema still requires non-empty strings on user-driven creates — this contract applies only to system seeds, which bypass Zod via direct `prisma.aiAgent.upsert`. See `.context/admin/setup-wizard.md` for how the wizard populates the system default-chat model.

### Temperature slider

shadcn `<Slider>` from 0 to 2 with step 0.05. Readout shows the current value to two decimals. Default is 0.7.

### Max tokens

Number input. Default 4096. Validation min 1, max 200_000.

### Reasoning effort

Radix `<Select>` (`AiAgent.reasoningEffort`). Controls how much internal reasoning the model does before producing visible output. Values: `auto` (form sentinel, persists as null) · `minimal` · `low` · `medium` · `high`.

Honoured only by reasoning-capable models:

- **OpenAI o-series / gpt-5** (`paramProfile === 'openai-reasoning'`) — sends `reasoning_effort` with the chosen bucket.
- **Anthropic Claude 4 Opus and Sonnet 4.5+** — enables extended thinking with a token budget derived from the bucket (low = 1024, medium = 4096, high = 16384 tokens). Anthropic enforces two hard rules: `budget_tokens` must be ≥ 1024, and `budget_tokens + visible output` must fit inside `max_tokens`. The provider class therefore requires `maxTokens ≥ 2048` (1024 minimum budget + 1024 visible-output floor) before sending `thinking` at all — below that, thinking is dropped silently. When sent, the budget is clamped to `min(requested, maxTokens − 1024)` so visible output always has room. `minimal` on Anthropic deliberately means "no extended thinking" (the field is omitted entirely).
- **Everything else** — silently dropped. No 400. The caller intent is still recorded on `LlmRequestParamsSnapshot.reasoningEffort` so a misconfigured agent shows up in the execution trace's request-envelope line.

When set on a thinking-capable Anthropic model, the provider class also strips thinking blocks from the response content (callers see only the answer). Streaming `chatStream()` applies the same filter — thinking-delta events are not yielded as text. See `lib/orchestration/llm/anthropic.ts` and `lib/orchestration/llm/model-heuristics.ts → supportsReasoningEffort()` / `anthropicThinkingBudget()`.

### Max history tokens

Optional number input (`AiAgent.maxHistoryTokens`). Overrides the context-window budget when building the prompt. Leave blank to use the model's full context window. Validation min 1 000, max 2 000 000. **This is the token knob** — it protects the model's context window from overflow.

### Memory length (messages)

Optional number input (`AiAgent.maxHistoryMessages`). Per-agent override for the message-count cap on conversation history. Validation min 0, max 500. Leave blank to use the platform default (`MAX_HISTORY_MESSAGES`, currently 50). **This is the behavioural knob** — distinct from _Max history tokens_ above. Use it to control how far back the agent remembers verbatim, even when the context window has plenty of room. `0` means "stateless agent: no prior history re-sent each turn"; older context still survives via the rolling summary that the streaming handler maintains on `AiConversation.summary`.

### Monthly budget (USD)

Optional number input. When set, the chat handler rejects new turns once MTD spend exceeds the cap. Leave blank to disable.

### Per-turn cost cap (USD)

Optional number input (`AiAgent.maxCostPerTurnUsd`). Caps the total LLM cost of a single chat turn — the runaway-loop guard from improvement #39. A reflect / orchestrator / tool loop that doesn't converge is the case this protects against: a single bad question becomes a few cents instead of a few dollars. Min 0.01, max 10,000. Leave blank to inherit the org-wide default (Settings → Orchestration → "Per-turn cap default"). When that is also blank, no per-turn cap applies — only the monthly budget above. On breach, the chat surface renders a friendly "stopped early" message and the requested tools for that iteration are NOT dispatched. The conversation row keeps the partial assistant message with an `endedReason: 'budget_exceeded'` marker so reloads render the cap-breach state correctly. See `.context/orchestration/chat.md` for the loop semantics.

### Fallback providers

Multi-checkbox list populated from the provider list. When the primary provider's circuit breaker is open, the chat handler falls back through these in order. Maximum 5 entries.

### Rate limit RPM

Optional number input. Per-agent rate limit in requests per minute. When set, overrides the global `chatLimiter` default for this agent. Leave blank for the global default.

### Enable voice input

Switch toggle (`AiAgent.enableVoiceInput`, default off). When on, every chat surface tied to this agent renders a microphone button in the input area:

- The embedded `<ChatInterface>` in the form's Test tab
- The Learning Hub chat tabs (`/admin/orchestration/learn` — Pattern Advisor and Quiz Master) when this agent backs the tab
- Any embed widget bound to this agent

Recorded audio is streamed to the configured speech-to-text provider (e.g. OpenAI Whisper) and discarded; only the transcript becomes part of the conversation. Effective state also depends on the org-wide kill switch in **Settings → Orchestration**, which defaults to on.

The form sends `enableVoiceInput: boolean` on the standard PATCH update. The toggle is unconditional in the UI — there's no gating against "no audio provider configured" because the same agent can be moved between deployments and the right surface for that signal is the embed widget's `/widget-config` (which hides the mic button when no provider exists).

The effective maximum recording length depends on the deployment platform — Sunrise caps at 25 MB (~50 minutes of Opus audio) but Vercel Hobby/Pro reject anything over 4.5 MB at the platform edge. See `.context/orchestration/embed.md#platform-body-size-limits` for the comparison table.

### Enable image input

Switch toggle (`AiAgent.enableImageInput`, default off). When on, the chat surfaces bound to this agent render a paperclip control in the input area for image attachments (JPEG, PNG, WebP, GIF):

- The embedded `<ChatInterface>` in the form's Test tab
- Any embed widget bound to this agent

Images are forwarded to the LLM as multimodal `ContentPart` entries and discarded after the turn — bytes are not persisted. Per-attachment cap ~5 MB binary (`MAX_CHAT_ATTACHMENT_BASE64_CHARS = 7_500_000` base64 chars); per-turn combined cap ~25 MB across all attachments; maximum of 10 attachments per turn.

Three orthogonal gates must all pass before the LLM is called:

1. This toggle (`agent.enableImageInput=true`)
2. Org-wide switch `imageInputGloballyEnabled` in **Settings → Orchestration → Image & document input** (default on)
3. The resolved chat model carries the `'vision'` capability — capability assignment lives on `AiProviderModel.capabilities` and is admin-curated. Open the provider-models matrix to see which seeded rows qualify.

Mismatch produces a discrete SSE error code (`IMAGE_DISABLED` / `IMAGE_NOT_SUPPORTED`) so the chat surface can map to specific UI copy. A `CostOperation = 'vision'` row is written to `AiCostLog` on every successful turn that carried at least one image, with `imageCount` / `pdfCount` in metadata. Toggle changes are tracked in `VERSIONED_FIELDS` and produce a snapshot/restore audit entry.

**Form-level constraint.** The toggle is disabled in the agent form when the currently-selected model lacks the `'vision'` capability — the description copy switches to "Switch to a `vision`-capable model in the Model tab to enable." The saved on/off value is preserved when disabled, so swapping back to a vision-capable model later restores the operator's previous intent. Models without a matrix row (registry-only entries) default-allow — the runtime gate is the authoritative check.

### Enable document (PDF) input

Switch toggle (`AiAgent.enableDocumentInput`, default off). Same architecture as image input but gates on the `'documents'` capability — operators control which provider-model rows carry it in the matrix. Native-PDF support varies by upstream provider; models without the capability are rejected at the gate with `PDF_NOT_SUPPORTED` rather than silently dropped, so the user gets a clear "switch the model" prompt instead of an LLM that pretends to have read the file.

PDFs share the per-attachment and per-turn caps with images. The picker UI is the same paperclip control — `application/pdf` joins the `accept` list automatically when either toggle is on.

**Form-level constraint.** Same as image input — when the selected model lacks `'documents'`, the toggle is disabled with copy directing the operator to the Model tab. Saved state is preserved across model swaps. The current seed carries `'documents'` on Anthropic Claude 4.x (incl. Bedrock), OpenAI GPT-4o family + GPT-4.1 + GPT-5, Azure GPT-4o, and OpenRouter (best-effort, route-dependent). Gemini, Grok, Mistral, Cohere, and other OpenAI-compatible providers remain off until their adapters accept the relevant PDF wire format.

### Connectivity check card

**Component:** `<AgentTestCard>` at `components/admin/orchestration/agent-test-card.tsx`.

A card with a `<FieldHelp>` explainer and a single **Run check** button that runs two steps in sequence:

1. **Provider connection** — POSTs `/providers/:id/test`. On success: green check + `{modelCount} models available`. On failure: red × + friendly message. If this step fails the model step is skipped.
2. **Model response** — POSTs `/providers/:id/test-model` with `{ model }`. On success: green check + round-trip latency in ms. On failure: red × + generic message.

Each step shows an idle dot, spinner, green check, or red × to the left of its label. When no provider config is saved, step 1 fails immediately with a "save it first" message. When no model is selected, step 2 fails with "No model selected."

The standalone `<ProviderTestButton>` and `<ModelTestButton>` components remain available for use in `<ProviderForm>` and elsewhere.

### Help copy

- **Provider** — "Which upstream API answers prompts for this agent. Each provider has its own API key set in the Providers page — agents that reference a provider with no key attached will fail at chat time. No default — pick one of the providers configured via the setup wizard or the Providers page."
- **Model** — "The exact model identifier your provider exposes. Changing this switches which model actually answers — cost, latency, and quality all shift. No default — pick one from the dropdown filtered to the chosen provider."

The model dropdown is sourced from the **operator-curated provider matrix** (`AiProviderModel` rows with `isActive: true`), filtered to capabilities an agent can chat through (`chat` OR `reasoning`). Mirrors the discipline already used by the `/admin/orchestration/settings` Default Models picker. Selecting a model the deployment hasn't actually added is not possible — avoids the runtime "provider unavailable" trap the previous merged-registry source allowed.

Implementation: `getAgentModels()` in `lib/orchestration/prefetch-helpers.ts` fires two parallel `GET /provider-models` requests (one per capability filter), merges + dedups by `(provider, modelId)`, and shapes into `ModelOption[]`. Failure modes mirror `getModels()` — partial failure (one fetch ok, one fails) returns whatever rows the successful call produced; full failure returns `null` and the form falls back to a free-text input with a warning banner.

**Legacy model fallback.** When editing an agent whose saved model is no longer in the matrix (matrix row deactivated or deleted since the agent was last saved), the form synthesises a one-off SelectItem for the saved model with a "no longer in matrix" amber badge — both in the dropdown option list and in the SelectValue trigger (Radix mirrors selected children). Stops the auto-reset effect from silently swapping the operator's selection on first edit. Tested in `tests/unit/components/admin/orchestration/agent-form-model.test.tsx` (`describe('legacy model fallback on edit')`).

- **Temperature** — "How much the model varies its wording. 0 = always picks the most likely next word (good for deterministic tasks). 1 = balanced. 2 = very creative, sometimes incoherent. Default: `0.7`."
- **Max output tokens** — "Upper bound on how long one reply can be. Defaults to `4096`. Only raise this if replies are getting cut off — higher values cost more on every turn."
- **Monthly budget (USD)** — "Hard spend cap for this agent, in USD. When month-to-date spend exceeds the cap, new chats are rejected until the calendar month rolls over or you raise the limit. Leave blank to disable the cap."
- **Per-turn cost cap (USD)** — "Caps the total LLM cost of a single chat turn (the messages exchanged before the model returns a final answer). Protects against a tool loop that keeps round-tripping without converging — a single bad question becomes a few cents instead of a few dollars. When the cap is hit mid-turn, the loop stops and the chat shows a friendly 'response stopped early' message. Leave blank to inherit the org-wide default (Settings → Orchestration). When that is also blank, no per-turn cap applies — only the monthly budget above."
- **Enable voice input** — "When enabled, users can record audio messages that are automatically transcribed before sending to the agent. Audio is forwarded to the configured speech-to-text provider (e.g. OpenAI Whisper) and discarded after transcription — only the transcript is stored as a normal user message. Voice input also requires the platform-wide switch in Settings → Orchestration to be on. Default: off."

## Tab 3 — Instructions

The Instructions tab composes the LLM's `system` message from four sections in this fixed order:

```
[Persona] → systemInstructions → [Guardrails] → [Brand Voice]
```

**Persona**, **Guardrails**, and **Brand voice** are _inheritable_ from the [agent profile](./orchestration-agent-profiles.md) selected on the General tab. **System instructions** is always agent-only — it's the task description, the reason the agent exists separately. See [`.context/orchestration/agent-profiles.md`](../orchestration/agent-profiles.md) for the resolution rules.

### Inheritable fields (Persona / Guardrails / Brand voice)

Each renders a `<Textarea>` plus an "Append to profile" checkbox that appears only when both a profile is attached AND the agent has populated the field:

- **Empty agent text** → inherits the profile's value. Placeholder shows `Profile says: …` so the operator sees what they're inheriting.
- **Populated agent text, checkbox off (default)** → agent value overrides the profile.
- **Populated agent text, checkbox on** → agent value appends to the profile (`${profile}\n\n${agent}`), composed as a single joined section in the system message.

When no profile is selected, the checkbox is hidden and the field behaves exactly as today (agent-only).

### System instructions

`<Textarea rows={16}>` bound to `systemInstructions`, with a character count in the footer. Never inheritable.

### Knowledge categories

Comma-separated text input. Tags that scope the agent to specific knowledge base categories. Transformed to `string[]` on submit.

### Topic boundaries

Comma-separated text input. Topics the output guard checks against. If the LLM response touches these topics, the output guard fires. Transformed to `string[]` on submit.

Below the textarea, in edit mode only, `<InstructionsHistoryPanel>` renders a collapsible audit log.

### Effective prompt preview

A collapsible card at the bottom of the tab shows the **merged system message** the LLM will actually receive — composed via the same `resolveEffectivePrompt` + `composeSystemPromptString` helpers used by the chat streaming handler and the workflow `agent_call` executor. Per-section source badges label each part as:

- `from profile "X"` — inherited verbatim
- `override` — the agent replaces the profile value
- `profile + agent additions` — append mode joined both
- `unset` — neither side contributed
- `agent-only` — system instructions (always agent-only)

The preview re-renders live as the operator types or flips a mode checkbox. What you see is what the model gets.

### History panel

`components/admin/orchestration/instructions-history-panel.tsx`.

- **Lazy fetch** — the panel only calls `GET /agents/:id/instructions-history` on first expand, not on mount. Subsequent expand/collapse cycles reuse the cached data.
- **Rows** — newest-first. Each row shows `changedBy`, `changedAt`, and the first 120 chars of the instructions. Two actions per row: **Diff** and **Revert**.
- **Diff dialog** — inline ~30-line LCS-based line diff, no new dep. Added lines get a green background, removed lines get red. Good enough for ~16-row system prompts.
- **Revert** — AlertDialog confirm → `POST /agents/:id/instructions-revert` with `{ versionIndex }`. The display is newest-first but the server expects oldest=0, so the panel maps `versionIndex = history.length - 1 - displayIndex`. On success the panel refetches and the parent form re-pulls the agent to update the textarea.

## Tab 4 — Capabilities

**Create mode:** renders an empty-state card pointing at "save first". The tab trigger is also disabled.

**Edit mode:** `<AgentCapabilitiesTab>` renders a two-column layout:

- **Left (Attached)** — rows from `GET /agents/:id/capabilities` (the pivot list endpoint added in this session). Each row has a `<Switch>` bound to `isEnabled`, a **Configure** button (opens a dialog with a JSON editor for `customConfig` and a number input for `customRateLimit`), and a **Detach** button.
- **Right (Available)** — every `AiCapability` from `GET /capabilities` that's not already attached. Each row has an **Attach** button.

Mutations:

| Action    | Call                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ |
| Attach    | `POST /agents/:id/capabilities` with `{ body: { capabilityId } }`                          |
| Detach    | `DELETE /agents/:id/capabilities/:capId`                                                   |
| Toggle    | `PATCH /agents/:id/capabilities/:capId` with `{ body: { isEnabled } }`                     |
| Configure | `PATCH /agents/:id/capabilities/:capId` with `{ body: { customConfig, customRateLimit } }` |

All four refetch the left column on success. Errors surface as an inline banner above the two columns. The `customRateLimit` input enforces `min={1}` in the UI and rejects non-positive values on submit.

### Rate limit usage badges

Each attached capability shows a live usage badge next to its name, fetched from `GET /agents/:id/capabilities/usage` (queries `AiCostLog` for `tool_call` operations in the last 60 seconds). Auto-refreshes every 15 seconds. Format: `12 / 60 /min` (amber at ≥80%, red at ≥100%). When no rate limit is configured, shows `5 calls/min` without a denominator. Zero usage with no limit renders no badge.

## Tab 5 — Invite tokens

**Component:** `components/admin/orchestration/agent-invite-tokens-tab.tsx`

Edit mode only, and only enabled when the agent's `visibility` is `invite_only`. For other visibility modes the tab trigger is disabled.

### Token table

Columns: label, truncated token (with copy-to-clipboard), status badge, usage / limit, expiry date, created date.

**Status badges** are derived, not stored:

| Badge       | Condition                                     |
| ----------- | --------------------------------------------- |
| `active`    | Not revoked, not expired, not exhausted       |
| `revoked`   | `revokedAt` is set                            |
| `expired`   | `expiresAt` is in the past                    |
| `exhausted` | `useCount >= maxUses` (when `maxUses` is set) |

### Create dialog

Opens from a "Create token" button above the table. Fields: **label** (optional text), **max uses** (optional number), **expiry** (optional date picker). POSTs to `agentInviteTokens(id)`. On success the table refetches and the new token is shown — the full token value is only visible at creation time.

### Revoke action

Per-row action. Calls `DELETE agentInviteTokenById(id, tokenId)`. Sets `revokedAt` server-side; the row's badge updates to `revoked` on refetch.

### API endpoints

| Action | Call                                       |
| ------ | ------------------------------------------ |
| List   | `GET agentInviteTokens(id)`                |
| Create | `POST agentInviteTokens(id)`               |
| Revoke | `DELETE agentInviteTokenById(id, tokenId)` |

### Help copy

- **Invite tokens** — "Invite tokens control access to invite-only agents. Common use cases: restricting access to specific clients, gating beta features, managing partner integrations, and creating paid tiers with separate tokens per customer."

## Tab 6 — Versions

**File:** `components/admin/orchestration/agent-version-history-tab.tsx` (client component, lazy-loaded).

Displays the `AiAgentVersion` timeline — every save creates a full config snapshot. Each row shows version number (badge), change summary, and formatted date. Expanding a row shows the creator tooltip.

### Restore

All rows except the latest version show a **Restore** button. Clicking opens an `AlertDialog` confirming the action. Restoring calls `POST agentVersionRestore(id, versionId)`, which pushes the pre-restore `systemInstructions` onto `systemInstructionsHistory` (keeping the JSONB history in sync with the version table) and creates a _new_ version entry so the action is auditable. The restore dialog clears any previous error on close. After restore, the parent form re-fetches the agent and calls `reset()` to update all fields.

### API endpoints

| Action  | Call                                      |
| ------- | ----------------------------------------- |
| List    | `GET agentVersions(id)?limit=50`          |
| Restore | `POST agentVersionRestore(id, versionId)` |

### Help copy

- **Version history** — "When you save changes to configuration fields (model, instructions, temperature, guard modes, `enableVoiceInput`, etc.), a snapshot of the full configuration is stored. Changes to name or description alone do not create a version. You can view what changed and restore any previous version. Restoring creates a new version entry so the action is auditable."

## Tab 7 — Test

Edit mode only. Embeds the shared admin `<ChatInterface>` (from `@/components/admin/orchestration/chat/chat-interface`) bound to this agent so the author can talk to it without leaving the form. Disabled until the agent has been saved (an `agent.id` is required).

```tsx
<ChatInterface
  agentSlug={agent.slug}
  agentId={agent.id}
  voiceInputEnabled={currentVoiceInput}
  imageInputEnabled={currentImageInput}
  documentInputEnabled={currentDocumentInput}
  showClearButton
  persistenceKey={`agent-test-chat:${agent.id}`}
  showInlineTrace
  className="h-[500px]"
/>
```

Notable prop choices for this surface:

- `showInlineTrace` — surfaces tool-call diagnostics inline so the author can see which capabilities the model invoked and inspect their arguments. The embed widget and end-user chats leave this off.
- `persistenceKey` is scoped per-agent so switching agents in the admin doesn't bleed messages between conversations.
- The three `*InputEnabled` props mirror the current form state (not the saved `agent.*` columns) so toggling, e.g., image input shows the paperclip immediately — without waiting for a save round-trip.

See [`orchestration-chat-interface.md`](./orchestration-chat-interface.md) for the full `<ChatInterface>` contract (SSE framing, error handling, abort semantics, persistence).

## Submit flow

```ts
// Create
const created = await apiClient.post<AiAgent>(API.ADMIN.ORCHESTRATION.AGENTS, { body: data });
router.push(`/admin/orchestration/agents/${created.id}`);

// Edit
await apiClient.patch<AiAgent>(API.ADMIN.ORCHESTRATION.agentById(agent.id), { body: data });
reset(data); // clears dirty state
```

Every PATCH to `systemInstructions` auto-snapshots the previous value onto `AiAgent.systemInstructionsHistory` server-side (see `admin-api.md`). Version restore also pushes the pre-restore instructions onto history, keeping the JSONB trail in sync with the `AiAgentVersion` table. The version snapshot and agent update run inside a single `prisma.$transaction` so an update failure doesn't leave orphaned version entries. System agent slugs are protected from mutation — the PATCH handler rejects slug changes when `isSystem` is true.

**Dirty state scope:** The form's `isDirty` tracking (via react-hook-form) only covers the main form fields on Tabs 1–3 (Identity, Model, Instructions). Tabs 4–8 (Capabilities, Invite tokens, Versions, Test, Embed) perform mutations directly via `apiClient` calls and save immediately — they don't mark the form as dirty. The `beforeunload` unsaved-changes warning only fires for unsaved Tab 1–3 changes.

## Related

- [Agents list page](./orchestration-agents.md)
- [Setup wizard](./setup-wizard.md)
- [Contextual help directive](../ui/contextual-help.md)
- [Admin API reference](../orchestration/admin-api.md)
- [Chat handler](../orchestration/chat.md)
