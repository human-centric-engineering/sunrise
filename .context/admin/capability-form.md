# Capability form

Shared create/edit form for `AiCapability`. Four shadcn tabs, one underlying `<form>`, one POST (create) or PATCH (edit). Landed in Phase 4 Session 4.3, using [`agent-form.md`](./agent-form.md) as the reference for the contextual-help voice.

**File:** `components/admin/orchestration/capability-form.tsx`
**Pattern:** raw `react-hook-form` + `zodResolver(capabilityFormSchema)`, same as `agent-form.tsx`.
**Persistence:** one submit writes one request — tabs are layout, not save boundaries.

## Tab structure

| #   | Tab                 | Create | Edit | Notes                                                               |
| --- | ------------------- | ------ | ---- | ------------------------------------------------------------------- |
| 1   | Basic               | ✅     | ✅   | Name, slug, description, category, metadata (JSON), active          |
| 2   | Function definition | ✅     | ✅   | Builder ⟷ JSON editor with live preview                             |
| 3   | Execution           | ✅     | ✅   | Execution type, handler, optional execution config                  |
| 4   | Safety              | ✅     | ✅   | Requires approval, rate limit, "used by N agents" panel (edit only) |

## Tab 1 — Basic

Fields: `name`, `slug`, `description`, `category`, `metadata` (optional JSON), `isActive`.

**Slug auto-generation** — the same shape as `agent-form.tsx`: typing into `name` auto-fills `slug` via `toSlug()` until the user types into the slug input, at which point a local `slugTouched` flag turns off auto-gen. Slug is disabled in edit mode.

**Unlike every other slug in the admin, this one is underscore-separated** (`my_knowledge_search`, not `my-knowledge-search`), and the client regex mirrors `capabilitySlugSchema` in accepting either separator. The capability slug is also **the tool name the LLM is given** — `getCapabilityDefinitions` advertises it, because dispatch resolves the name a model emits back as a slug (#509). Underscores are what every built-in uses. The Function name field on Tab 2 is derived from this value and read-only; see [Tab 2](#tab-2--function-definition).

### Category Select

Populated from the `availableCategories` prop (derived server-side from the current list response). The last option is always **"+ New category…"**; picking it swaps the Select for a free-text `<Input>` (with a small "Use existing" button that reverts). The free-text value is validated client-side with the same `z.string().min(1).max(50).trim()` the backend enforces.

### Help copy (exact strings — source of truth for later sessions)

- **Name** — "A human-readable label. Shown in the admin list and in the agent's capabilities tab. Defaults to empty."
- **Slug** — "A permanent ID for this capability, used in URLs, when attaching it to agents, and **as the tool name the AI calls** — the Function name on the Function tab mirrors it. Auto-generated from the name. Lowercase letters and numbers, separated by underscores or hyphens; underscores are conventional for tool names. Cannot be changed after creation."
- **Function name** (Tab 2) — "The machine-readable identifier the AI uses to call this capability. **Always the same as the slug**, so edit it on the Basics tab. It has to match: when a model calls a tool, the platform looks the capability up by the name it emitted. If the two could differ, a capability would be permission-checked as one tool and executed as another."
- **Description** — "One or two sentences explaining what this capability does. Shown on the list page and next to the attach button in the agent form — keep it short."
- **Category** — "Tag used to group capabilities in the agent form's Capabilities tab. Free-text on the backend, so it's OK to invent new ones — the dropdown lists what's already in use."
- **Metadata** — "Arbitrary key-value pairs for tagging or external system references (e.g. external IDs, feature flags, notes). Values must be strings, numbers, booleans, or null. Maximum 100 keys. Leave empty if not needed."
- **Active** — "Inactive capabilities are not offered to agents on new chats. Execution history is preserved. Default: on."

### System capability banner

When editing a system capability (`isSystem: true`), a blue info banner appears below the sticky header naming the four fields the seeds own — `slug`, `functionDefinition`, `executionType`, `executionHandler` — and stating that changing any of them is refused because a re-seed would overwrite them. The System badge in the header carries the same list in a FieldHelp popover.

Both were rewritten for #598. They previously said the operator "can edit its description, safety settings, and execution config" without naming what was protected, which was the wrong half of the sentence to be specific about: the form does not disable the protected inputs, so the copy is the only thing telling an operator before they type rather than at the 403. If you add a field to `SEED_OWNED_CAPABILITY_FIELDS`, update both strings.

## Tab 2 — Function definition

This is the most involved tab — an admin can edit the OpenAI function-definition shape either visually (default) or as raw JSON, and the two modes round-trip.

### Shape

```ts
// What the backend stores — OpenAI function-calling format
{
  name: 'search_knowledge',
  description: 'Semantic search over the knowledge base.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '…' },
      limit: { type: 'number', description: '…' },
    },
    required: ['query'],
  },
}
```

### Builder mode (default)

- **Top fields** — `fn.name` and `fn.description`.
  - **`fn.name` is read-only and mirrors the slug** (one `useEffect` on the watched `slug`). It has to equal the slug: dispatch resolves the tool name a model emits _as_ the slug, so a divergent pair would be permission-checked as one capability and executed as another. `createCapabilitySchema` / `updateCapabilitySchema` reject the divergence, and the PATCH route re-checks the effective pair against the stored row when only one half is in the body (#509). The field is not editable because the form must not offer a way to author something the API will refuse.
  - Before #509 the two were derived independently from the display name — `toSlug()` for the slug, `toSlug().replace(/-/g, '_')` for the function name — so the default typing produced `search-web` / `search_web` and every UI-created capability diverged.
  - **JSON mode can author a divergent `name`, but the form refuses to submit it** — a pre-submit check names both values rather than letting a bare 400 come back. The server check in `createCapabilitySchema` / `updateCapabilitySchema` remains the real enforcement point for anything that is not this form (the API, the CLI, a script); it is simply no longer what the admin sees. This bullet described the pre-check behaviour for a while after the check landed.
- **Parameters table** — `useState<ParameterRow[]>` outside RHF. Each row has:
  - `name` (text, `[a-z_][a-z0-9_]*`)
  - `type` (Select: `string | number | boolean | object | array`)
  - `description` (text)
  - `required` (Switch)
- **+ Add parameter** appends a blank row. Trash button removes.

Every keystroke recompiles the rows into the OpenAI shape via `compileFunctionDefinition()` and writes the result to `parsedFn` — the single source of truth passed into the submit payload.

#### The builder is a lossy view, so a compile MERGES rather than replaces (#509)

A row holds four things — name, type, description, required — while a stored spec can carry `minimum`, `maxLength`, `format`, `enum`, `items` and nested shapes. Rebuilding each parameter from its row therefore deleted everything the row had no slot for, so editing one description stripped the constraints off the parameter beside it. Not a validation problem: a lossy round-trip, the same shape as opening a formatted document in a plain-text editor and saving.

`compileFunctionDefinition()` takes a **baseline** — the stored spec, refreshed whenever the JSON editor writes a new one — and merges each row over the stored property. The builder owns `type`, `description` and membership of `required`; everything else on the property is carried through, as are keywords on `parameters` itself (`additionalProperties`, `$schema`).

Two rules make it work:

- **A deliberate type change drops the stored keywords.** `minLength` on a field that just stopped being a string is nonsense. This is the one remaining loss, and it is visible and chosen.
- **`integer` counts as unchanged against `number`.** The builder has no integer option, so `tryReverseCompile()` shows integers as `number`; without this exception every integer parameter would look like a deliberate type change and lose its bounds. The stored `integer` is kept rather than the row's approximation, which is what stops a save widening `pattern_number` so a model may send `1.5`.

Two further guards keep an _untouched_ save byte-identical: the recompile effect does not run on mount, and the initial `parsedFn` is the stored definition rather than a compile of it. Both were regressions found in review — before them, merely opening a seeded capability and pressing Save rewrote its schema.

### JSON editor (escape hatch)

- `<Textarea rows=20 class="font-mono">` with a **debounced 200 ms parse**. Valid JSON → writes to `parsedFn` and updates the live preview. Invalid JSON → inline red error, `parsedFn` is not touched, submit is blocked.
- Switching Builder → JSON serializes the current compiled shape into the textarea.
- Switching JSON → Builder attempts `tryReverseCompile()`. If the shape uses features the Builder can't represent **at all** (nested objects, `oneOf`, enums, `items`), the Builder toggle is **disabled** and an amber banner explains why. Extra validation keywords (`minimum`, `format`, …) do _not_ disable it — they no longer have to, since a compile merges over them rather than dropping them. The banner includes a **"Reset to Builder"** button that discards advanced schema features and returns to visual mode with just the function name and description (parameters are cleared). If the admin simplifies the schema in JSON instead, the toggle re-enables automatically. If JSON is simply invalid (syntax error), the switch is blocked with an inline error instead of permanently disabling the toggle.

Both modes parse through `capabilityFunctionDefinitionSchema` (defined in `lib/validations/orchestration.ts:31`) before touching form state — no `as` casts. The `visualDisabled` flag is re-evaluated on every successful JSON parse, so simplifying a complex schema back to a Builder-compatible shape re-enables the toggle without a page reload.

### Live preview

A read-only `<pre>` pretty-prints the current `parsedFn` and is **always visible** below the tab content in both modes. Admins can watch the visual builder compile as they type.

## Tab 3 — Execution

Fields: `executionType`, `executionHandler`, `executionConfig` (optional).

### Execution type

`<Select>` with three options:

- **`internal`** — "Calls a TypeScript class registered in `lib/orchestration/capabilities/built-in/`. Use for tools that run inside this app."
- **`api`** — "POST to an HTTP endpoint. Use for tools hosted in another service on your network."
- **`webhook`** — "Fire-and-forget HTTP POST with no response body expected. Use for notifications or one-way triggers."

### Execution handler

Single text input. The FieldHelp copy **changes with the selected type**:

- `internal` → "Class name registered in `lib/orchestration/capabilities/built-in/index.ts` (e.g. `SearchKnowledgeCapability`)."
- `api` → "Full HTTPS URL the dispatcher will POST to. Must be reachable from the Sunrise server." Validated as a URL on both client and server.
- `webhook` → "Full HTTPS URL that will receive the payload. The dispatcher never waits for a response body." Validated as a URL on both client and server.

### Execution config (optional JSON)

`<Textarea rows=8 class="font-mono">` with the same debounced 200 ms parse as the Function Definition JSON editor. Empty → submits as `undefined`. Invalid JSON blocks submit with an inline error.

## Tab 4 — Safety

Fields: `requiresApproval`, `approvalTimeoutMs`, `rateLimit`.

### Requires approval

Shadcn `<Switch>`. When enabled, the dispatcher pauses on first invocation and writes an `AiCapabilityExecution` row with `status: 'pending_approval'` — a human has to approve before the handler runs.

Help: **"When enabled, the agent will pause and ask a human to approve before running this capability. Use for irreversible actions like sending email, charging cards, or writing to production systems. Default: off."**

### Approval timeout (ms)

Number input, 1–3,600,000 (max 1 hour). **Only visible when "Requires approval" is toggled on.** Overrides the global default timeout from orchestration settings. Leave blank to use the global default.

Help: **"How many milliseconds the system waits for a human to approve or reject this call before falling back to the global default action (deny or allow). Leave blank to use the global default timeout from orchestration settings. Maximum is 3,600,000 ms (1 hour)."**

### Rate limit

Number input, 1–10000, or empty.

Help: **"Maximum calls per minute across all agents. Leave empty for no limit. Default: no limit."**

### "Used by N agents" panel (edit mode only)

When `mode==='edit'` and `usedBy.length > 0`, the tab renders a non-interactive card listing every agent currently attaching this capability. Serves as a reminder that safety changes ripple to every consumer. Data comes from the `usedBy` prop on `<CapabilityForm>` (which the edit page fetches via `GET /capabilities/:id/agents`).

## Submit flow

```ts
// Create
const created = await apiClient.post<AiCapability>(API.ADMIN.ORCHESTRATION.CAPABILITIES, {
  body: {
    ...formData,
    functionDefinition: parsedFn, // compiled from visual builder OR parsed from JSON editor
    executionConfig: execConfigParsed, // parsed from the optional JSON textarea
    metadata: metadataParsed, // parsed from the optional JSON textarea
  },
});
router.push(`/admin/orchestration/capabilities/${created.id}`);

// Edit
await apiClient.patch<AiCapability>(API.ADMIN.ORCHESTRATION.capabilityById(capability.id), {
  body: {
    ...formData,
    functionDefinition: parsedFn,
    executionConfig: execConfigParsed,
    metadata: metadataParsed,
  },
});
reset(formData); // clears dirty state
```

Errors from `apiClient` are caught and rendered as a banner at the top of the form — raw server error text is passed through only after it's already been sanitized by the API layer.

## Execution Metrics panel (edit page only)

`components/admin/orchestration/capability-stats-panel.tsx` — a card rendered **above** `<CapabilityForm>` on `/admin/orchestration/capabilities/[id]` (never on `/new`).

- **Data source:** `GET /capabilities/:id/stats?period=<7d|30d|90d>`. The period selector in the card header re-fetches on change; default is `30d`.
- **Metrics rendered:** Invocations, Success Rate, Avg Latency (with `p50` / `p95` subline), Total Cost (USD, 4dp).
- **Colour rules:** Success rate badges green ≥ 95%, amber ≥ 80%, red otherwise. Cost, latency, and invocations use fixed brand colours.
- **Empty state:** when `invocations === 0`, the description reads "No invocations recorded yet. Metrics appear here when an AI agent uses this capability during a chat conversation." All metric cards still render (with zeroes).
- **Error state:** fetch failures render a generic "Failed to load metrics" inline — the form below still mounts.

## Related

- [Capabilities list page](./orchestration-capabilities.md)
- [Agent form](./agent-form.md) — the reference for the FieldHelp voice
- [Capabilities (runtime)](../orchestration/capabilities.md) — dispatcher, execution handlers, approval flow
- [Admin API reference](../orchestration/admin-api.md)
