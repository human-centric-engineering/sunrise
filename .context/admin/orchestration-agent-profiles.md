# Agent profile management pages

Admin list/create/edit flows for `AiAgentProfile`. A **profile** is a reusable bundle of
**persona**, **brand voice**, and **guardrails** text that one or more agents can inherit from.
Change a profile once — every attached agent picks it up.

Profiles exist so a product family that runs several agents (e.g. "support team", "VIP concierge",
"billing triage") can keep a single source of truth for identity / tone / refusals, instead of
copy-pasting the same paragraphs into every agent and watching them drift.

## What gets inherited

| Field                    | Inheritable | Source of truth                                                                    |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------- |
| `persona`                | Yes         | Profile if set; agent overrides per its `personaMode` (override/append)            |
| `brandVoiceInstructions` | Yes         | Profile if set; agent overrides per `voiceMode`                                    |
| `guardrails`             | Yes         | Profile if set; agent overrides per `guardrailsMode`                               |
| `systemInstructions`     | No          | Always agent-only — the task description is the reason the agent exists separately |

See `.context/orchestration/agent-profiles.md` for the per-field resolution rules and the
composition order in the rendered LLM system message.

## Pages

| Route                                      | File                                                   | Role                                   |
| ------------------------------------------ | ------------------------------------------------------ | -------------------------------------- |
| `/admin/orchestration/agent-profiles`      | `app/admin/orchestration/agent-profiles/page.tsx`      | Table list with attached-agent counts  |
| `/admin/orchestration/agent-profiles/new`  | `app/admin/orchestration/agent-profiles/new/page.tsx`  | Create shell                           |
| `/admin/orchestration/agent-profiles/[id]` | `app/admin/orchestration/agent-profiles/[id]/page.tsx` | Edit shell, `notFound()` on missing id |

All three are async server components via `serverFetch()` + `parseApiResponse()`. Fetch failures
fall back to empty state and log via `logger.error`.

## List page

```
┌──────────────────────────────────────────────────────────────┐
│ Agent Profiles                              [+ New profile]  │
├──────────────────────────────────────────────────────────────┤
│ Name              Slug              Description       Agents │
│ Support Family    support-family    Shared persona…    3     │
│ VIP Concierge     vip-concierge     White-glove…       1     │
└──────────────────────────────────────────────────────────────┘
```

- **Name** links to the edit page.
- **Slug** in monospace — URL identifier, fixed after create.
- **Agents** column comes from `_count.agents` on the list endpoint; it tells operators how many
  agents are currently inheriting the row before they edit it.
- Rows are ordered by `updatedAt desc` so recently edited profiles surface first.
- Empty state shows a hint: _"Create a profile to share persona / brand voice / guardrails across
  several agents."_

## Form (create + edit)

**Component:** `components/admin/orchestration/agent-profile-form.tsx` — raw RHF + Zod, sticky
action bar, every field wrapped in `<FieldHelp>` per `.context/ui/contextual-help.md`.

| Field                    | Help copy summary                                                       |
| ------------------------ | ----------------------------------------------------------------------- |
| `name`                   | Short label shown in the agent form's profile dropdown                  |
| `slug`                   | URL identifier; auto-derived on create, locked on edit                  |
| `description`            | Optional internal note — operator-facing only, never sent to the LLM    |
| `persona`                | Who the agent is (identity / role / backstory). Max 10 000 chars.       |
| `brandVoiceInstructions` | How the agent should sound (tone / register / style). Max 10 000 chars. |
| `guardrails`             | What the agent must not do (refusals / escalations). Max 10 000 chars.  |

Slug is intentionally **not patchable**. Rename = create a new profile and re-point agents.
Keeps URL identifiers stable for bookmarks and `gh issue` references.

On edit, the form also renders an "Agents using this profile" panel below the fields, with
deep-links to each agent's edit page. Operators can see at a glance what their change is about
to affect.

## API surface

| Method | Path                                             | Notes                                                        |
| ------ | ------------------------------------------------ | ------------------------------------------------------------ |
| GET    | `/api/v1/admin/orchestration/agent-profiles`     | Paginated, `agentCount`: attached agents in every org        |
| POST   | `/api/v1/admin/orchestration/agent-profiles`     | Validates via `agentProfileFormSchema`                       |
| GET    | `/api/v1/admin/orchestration/agent-profiles/:id` | Includes `agents: [{ id, slug, name, isActive }]`            |
| PATCH  | `/api/v1/admin/orchestration/agent-profiles/:id` | Slug is not in `updateAgentProfileSchema` — silently dropped |
| DELETE | `/api/v1/admin/orchestration/agent-profiles/:id` | Hard delete; FK `SET NULL` on `ai_agent.profileId`           |

All routes wrap `withAdminAuth`, mutating verbs hit `adminLimiter`, every mutation writes a
`logAdminAction` audit entry with `entityType: 'agent_profile'` and one of `agent_profile.create`,
`agent_profile.update`, `agent_profile.delete`.

## Deletion semantics

DELETE is **hard**, not soft. The FK on `ai_agent.profileId` is `ON DELETE SET NULL`, so any
attached agents are cleanly detached — their own override texts (if any) remain unchanged; the
only effect is that they stop inheriting the profile's persona / voice / guardrails.

The response body includes `detachedAgentCount` so the UI can confirm scope. A profile is global config, so the count covers every org's attached agents, not just the caller's (§107 t-731):

```json
{ "success": true, "data": { "id": "…", "deleted": true, "detachedAgentCount": 3 } }
```

The audit log entry carries the same number in `metadata`.

## Where to read next

- [Agent profiles — resolver & composition](../orchestration/agent-profiles.md) — the per-field
  inheritance rules, composition order, and integration points.
- [Agent form](./agent-form.md) — the General-tab profile selector and the Instructions-tab
  Effective-prompt preview.
- [Chat / message composition](../orchestration/chat.md) — how the resolved fields turn into the
  `system` message.
