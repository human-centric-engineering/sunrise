# Capability form

Shared create/edit form for `AiCapability`. Four shadcn tabs, one underlying `<form>`, one POST (create) or PATCH (edit). Landed in Phase 4 Session 4.3, using [`agent-form.md`](./agent-form.md) as the reference for the contextual-help voice.

**File:** `components/admin/orchestration/capability-form.tsx`
**Pattern:** raw `react-hook-form` + `zodResolver(capabilityFormSchema)`, same as `agent-form.tsx`.
**Persistence:** one submit writes one request — tabs are layout, not save boundaries.

## Tab structure

| #   | Tab                 | Create | Edit | Notes                                                               |
| --- | ------------------- | ------ | ---- | ------------------------------------------------------------------- |
| 1   | Basic               | ✅     | ✅   | Name, slug, description, category, active                           |
| 2   | Function definition | ✅     | ✅   | Builder ⟷ JSON editor with live preview                             |
| 3   | Execution           | ✅     | ✅   | Execution type, handler, optional execution config                  |
| 4   | Safety              | ✅     | ✅   | Requires approval, rate limit, "used by N agents" panel (edit only) |

## Tab 1 — Basic

Fields: `name`, `slug`, `description`, `category`, `isActive`.

**Slug auto-generation** — identical to `agent-form.tsx`: typing into `name` auto-fills `slug` via `toSlug()` until the user types into the slug input, at which point a local `slugTouched` flag turns off auto-gen. Slug is disabled in edit mode.

### Category Select

Populated from the `availableCategories` prop (derived server-side from the current list response). The last option is always **"+ New category…"**; picking it swaps the Select for a free-text `<Input>` (with a small "Use existing" button that reverts). The free-text value is validated client-side with the same `z.string().min(1).max(50).trim()` the backend enforces.

### Help copy (exact strings — source of truth for later sessions)

- **Name** — "A human-readable label. Shown in the admin list and in the agent's capabilities tab. Defaults to empty."
- **Slug** — "The stable identifier used by agents and API calls. Auto-generated from the name on first type, but you can edit it. Lowercase letters, numbers, and hyphens only."
- **Description** — "One or two sentences explaining what this capability does. Shown on the list page and next to the attach button in the agent form — keep it short."
- **Category** — "Tag used to group capabilities in the agent form's Capabilities tab. Free-text on the backend, so it's OK to invent new ones — the dropdown lists what's already in use."
- **Active** — "Inactive capabilities are not offered to agents on new chats. Execution history is preserved. Default: on."

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

- **Top fields** — `fn.name` and `fn.description`. Client-side validation prevents empty name; the backend also enforces it via `capabilityFunctionDefinitionSchema`.
- **Parameters table** — `useState<ParameterRow[]>` outside RHF. Each row has:
  - `name` (text, `[a-z_][a-z0-9_]*`)
  - `type` (Select: `string | number | boolean | object | array`)
  - `description` (text)
  - `required` (Switch)
- **+ Add parameter** appends a blank row. Trash button removes.

Every keystroke recompiles the rows into the OpenAI shape via `compileFunctionDefinition()` and writes the result to `parsedFn` — the single source of truth passed into the submit payload.

### JSON editor (escape hatch)

- `<Textarea rows=20 class="font-mono">` with a **debounced 200 ms parse**. Valid JSON → writes to `parsedFn` and updates the live preview. Invalid JSON → inline red error, `parsedFn` is not touched, submit is blocked.
- Switching Builder → JSON serializes the current compiled shape into the textarea.
- Switching JSON → Builder attempts `tryReverseCompile()`. If the shape uses features the Builder can't represent (nested objects, `oneOf`, enums, etc.), the Builder toggle is **disabled** and an amber banner explains why. If the admin simplifies the schema, the toggle re-enables automatically. If JSON is simply invalid (syntax error), the switch is blocked with an inline error instead of permanently disabling the toggle.

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
- `api` → "Full HTTPS URL the dispatcher will POST to. Must be reachable from the Sunrise server."
- `webhook` → "Full HTTPS URL that will receive the payload. The dispatcher never waits for a response body."

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
  },
});
router.push(`/admin/orchestration/capabilities/${created.id}`);

// Edit
await apiClient.patch<AiCapability>(API.ADMIN.ORCHESTRATION.capabilityById(capability.id), {
  body: { ...formData, functionDefinition: parsedFn, executionConfig: execConfigParsed },
});
reset(formData); // clears dirty state
```

Errors from `apiClient` are caught and rendered as a banner at the top of the form — raw server error text is passed through only after it's already been sanitized by the API layer.

## Related

- [Capabilities list page](./orchestration-capabilities.md)
- [Agent form](./agent-form.md) — the reference for the FieldHelp voice
- [Capabilities (runtime)](../orchestration/capabilities.md) — dispatcher, execution handlers, approval flow
- [Admin API reference](../orchestration/admin-api.md)
