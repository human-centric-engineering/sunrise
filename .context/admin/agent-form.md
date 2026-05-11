# Agent form

Shared create/edit form for `AiAgent`. Eight shadcn tabs, one underlying `<form>`, one POST (create) or PATCH (edit). Landed in Phase 4 Session 4.2; this is the **reference implementation** of the `<FieldHelp>` contextual-help directive — later sessions copy the voice, not just the structure.

**File:** `components/admin/orchestration/agent-form.tsx`
**Pattern:** raw `react-hook-form` + `zodResolver(agentFormSchema)`, no shadcn Form wrapper (mirrors `components/admin/feature-flag-form.tsx`).
**Persistence:** one submit writes one request — tabs are layout, not save boundaries.

## Tab structure

| #   | Tab           | Create | Edit | Notes                                                                                                                                                                                           |
| --- | ------------- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | General       | ✅     | ✅   | Name, slug, description, active, **visibility**, retention days                                                                                                                                 |
| 2   | Model         | ✅     | ✅   | Provider, **fallback providers**, model, temperature, max tokens, budget, **rate limit RPM**, test conn                                                                                         |
| 3   | Instructions  | ✅     | ✅   | Textarea, **brand voice**, **knowledge categories**, **topic boundaries**, character count, history panel (edit only)                                                                           |
| 4   | Capabilities  | 🚫     | ✅   | Attach/detach, isEnabled, customConfig                                                                                                                                                          |
| 5   | Invite tokens | 🚫     | ✅\* | Token CRUD table; only enabled when `visibility = 'invite_only'`                                                                                                                                |
| 6   | Versions      | 🚫     | ✅   | Full config version history with restore                                                                                                                                                        |
| 7   | Test          | 🚫     | ✅   | Embeds `<AgentTestChat>`                                                                                                                                                                        |
| 8   | Embed         | 🚫     | ✅   | `<EmbedConfigPanel>` stacks two cards: **Appearance & copy** (per-agent widget colours / fonts / copy / starters) + **Tokens** (create, copy `<script>` snippet, toggle active, manage origins) |

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

### Monthly budget (USD)

Optional number input. When set, the chat handler rejects new turns once MTD spend exceeds the cap. Leave blank to disable.

### Fallback providers

Multi-checkbox list populated from the provider list. When the primary provider's circuit breaker is open, the chat handler falls back through these in order. Maximum 5 entries.

### Rate limit RPM

Optional number input. Per-agent rate limit in requests per minute. When set, overrides the global `chatLimiter` default for this agent. Leave blank for the global default.

### Enable voice input

Switch toggle (`AiAgent.enableVoiceInput`, default off). When on, every chat surface tied to this agent renders a microphone button in the input area:

- `AgentTestChat` in the form's Test tab
- The Learning Hub chat tabs (`/admin/orchestration/learn` — Pattern Advisor and Quiz Master) when this agent backs the tab
- Any embed widget bound to this agent

Recorded audio is streamed to the configured speech-to-text provider (e.g. OpenAI Whisper) and discarded; only the transcript becomes part of the conversation. Effective state also depends on the org-wide kill switch in **Settings → Orchestration**, which defaults to on.

The form sends `enableVoiceInput: boolean` on the standard PATCH update. The toggle is unconditional in the UI — there's no gating against "no audio provider configured" because the same agent can be moved between deployments and the right surface for that signal is the embed widget's `/widget-config` (which hides the mic button when no provider exists).

The effective maximum recording length depends on the deployment platform — Sunrise caps at 25 MB (~50 minutes of Opus audio) but Vercel Hobby/Pro reject anything over 4.5 MB at the platform edge. See `.context/orchestration/embed.md#platform-body-size-limits` for the comparison table.

### Enable image input

Switch toggle (`AiAgent.enableImageInput`, default off). When on, the chat surfaces bound to this agent render a paperclip control in the input area for image attachments (JPEG, PNG, WebP, GIF):

- `AgentTestChat` in the form's Test tab
- Any embed widget bound to this agent (image input is wired in Phase 4 of the rollout)

Images are forwarded to the LLM as multimodal `ContentPart` entries and discarded after the turn — bytes are not persisted. Per-attachment cap ~5 MB binary (`MAX_CHAT_ATTACHMENT_BASE64_CHARS = 7_500_000` base64 chars); per-turn combined cap ~25 MB across all attachments; maximum of 10 attachments per turn.

Three orthogonal gates must all pass before the LLM is called:

1. This toggle (`agent.enableImageInput=true`)
2. Org-wide switch `imageInputGloballyEnabled` in **Settings → Orchestration → Image & document input** (default on)
3. The resolved chat model carries the `'vision'` capability — seeded for GPT-4o family, GPT-4.1, GPT-5, Gemini 2.5 Pro/Flash, Grok 3, Azure GPT-4o, Bedrock Claude, and Claude 4.x

Mismatch produces a discrete SSE error code (`IMAGE_DISABLED` / `IMAGE_NOT_SUPPORTED`) so the chat surface can map to specific UI copy. A `CostOperation = 'vision'` row is written to `AiCostLog` on every successful turn that carried at least one image, with `imageCount` / `pdfCount` in metadata. Toggle changes are tracked in `VERSIONED_FIELDS` and produce a snapshot/restore audit entry.

### Enable document (PDF) input

Switch toggle (`AiAgent.enableDocumentInput`, default off). Same architecture as image input but gates on the `'documents'` capability, which is currently seeded only for the Claude 4.x family (incl. Bedrock Claude). OpenAI Chat Completions does not yet accept native PDF parts, so PDFs to a GPT-\* agent are rejected at the gate with `PDF_NOT_SUPPORTED` rather than silently dropped.

PDFs share the per-attachment and per-turn caps with images. The picker UI is the same paperclip control — `application/pdf` joins the `accept` list automatically when either toggle is on.

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
- **Temperature** — "How much the model varies its wording. 0 = always picks the most likely next word (good for deterministic tasks). 1 = balanced. 2 = very creative, sometimes incoherent. Default: `0.7`."
- **Max output tokens** — "Upper bound on how long one reply can be. Defaults to `4096`. Only raise this if replies are getting cut off — higher values cost more on every turn."
- **Monthly budget (USD)** — "Hard spend cap for this agent, in USD. When month-to-date spend exceeds the cap, new chats are rejected until the calendar month rolls over or you raise the limit. Leave blank to disable the cap."
- **Enable voice input** — "When enabled, users can record audio messages that are automatically transcribed before sending to the agent. Audio is forwarded to the configured speech-to-text provider (e.g. OpenAI Whisper) and discarded after transcription — only the transcript is stored as a normal user message. Voice input also requires the platform-wide switch in Settings → Orchestration to be on. Default: off."

## Tab 3 — Instructions

Single `<Textarea rows={16}>` bound to `systemInstructions`, with a character count in the footer.

### Brand voice instructions

Textarea (4 rows) for brand-voice guidance. Injected into the system prompt as a separate section so the LLM follows tone/style rules consistently. Example: "Always respond in a professional, concise tone. Avoid slang."

### Knowledge categories

Comma-separated text input. Tags that scope the agent to specific knowledge base categories. Transformed to `string[]` on submit.

### Topic boundaries

Comma-separated text input. Topics the output guard checks against. If the LLM response touches these topics, the output guard fires. Transformed to `string[]` on submit.

Below the textarea, in edit mode only, `<InstructionsHistoryPanel>` renders a collapsible audit log.

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

Edit mode only. Embeds `<AgentTestChat agentSlug={agent.slug} minHeight="min-h-[200px]" />`. This is the **same component** the Setup Wizard's Step 4 uses — see [`setup-wizard.md`](./setup-wizard.md).

### `<AgentTestChat>` contract

File: `components/admin/orchestration/agent-test-chat.tsx`.

- POSTs to `/api/v1/admin/orchestration/chat/stream` via `fetch` with `ReadableStream.getReader()`. The body includes `{ message, agentSlug, conversationId?, ... }` — note that the endpoint requires `agentSlug` (not `agentId`), which is passed from the agent object's `slug` field.
- Parses standard SSE frames (`event:` / `data:` lines separated by `\n\n`).
- Renders `content` deltas into a growing reply; stops on `done`.
- `error` frame → **"The agent ran into a problem. Check the server logs for details."** The raw `data.message` is never forwarded to the DOM. The wizard test pins this behaviour; any regression is caught by two unit tests (wizard + direct chat component).
- Holds an `AbortController` and calls `.abort()` on unmount or on a new send.

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
