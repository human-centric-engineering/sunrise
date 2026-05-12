# Setup Wizard

Six-step guided flow that walks a new admin from "fresh install" to "I have a working agent I can chat with". Mounted from the Orchestration Dashboard header via the `Setup Guide` button. On a fresh install (no providers configured), the dashboard auto-opens the wizard via the `forceOpen` prop and renders a `SetupRequiredBanner` above the page content.

**Component:** `components/admin/orchestration/setup-wizard.tsx`
**Launcher:** `components/admin/orchestration/setup-wizard-launcher.tsx`
**Banner:** `components/admin/orchestration/setup-required-banner.tsx`
**Setup probe:** `lib/orchestration/setup-state.ts` (`getSetupState()`)
**Storage key:** `sunrise.orchestration.setup-wizard.v2`

## Steps

| #   | Title                   | Purpose                                                                                            | Auto-skip?                                       |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | What are you building?  | Pattern advisor chat — recommends patterns/workflows based on use case                             | Always skippable                                 |
| 2   | Configure a provider    | Calls `/providers/detect` to surface env-var detection cards. Manual flavour picker as fallback.   | Auto-complete when providers exist               |
| 3   | Confirm default models  | Picks chat + embedding defaults written to `AiOrchestrationSettings.defaultModels`                 | —                                                |
| 4   | Create your first agent | Inline form with provider/model dropdowns sourced from `/providers` and `/models` → `POST /agents` | Auto-complete (jump to step 5) when agents exist |
| 5   | Test your agent         | Embeds `<AgentTestChat>` — same SSE consumer used by the agent edit page                           | —                                                |
| 6   | What's next             | Static links; `Finish` clears localStorage and closes the dialog                                   | —                                                |

## Provider detection (Step 2)

`GET /api/v1/admin/orchestration/providers/detect` scans `process.env` for known LLM API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`) and returns `apiKeyPresent: boolean` plus suggested defaults from `lib/orchestration/llm/known-providers.ts`. Env-var values are never returned — only the names.

When a key is detected, the operator clicks the matching card and the wizard:

1. POSTs the provider config (slug, providerType, baseUrl, apiKeyEnvVar) to `/providers`.
2. PATCHes the suggested chat + embedding model into `AiOrchestrationSettings.defaultModels` — only if the slot is unset, never overwriting operator edits.

When no keys are detected (`anyKeyPresent === false`), the wizard renders an amber hard-block card: "No LLM API keys detected in your environment." The card lists the env-var names the operator should set (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and the message varies by context — if a provider row already exists but its key is missing, the copy warns that the existing provider can't authenticate. The manual form and detection cards are not shown in this state; the operator must set an env var and restart before proceeding.

When at least one key is detected, the detection cards render. Operators can also opt into manual mode from the detection screen via "Configure manually instead →".

## Default-model step (Step 3)

The wizard reads `AiOrchestrationSettings` and renders two selectors:

- **Default chat model** — populated from `/models` (the merged static/OpenRouter/per-provider catalogue). Used by the 5 system-seeded agents when their `provider`/`model` are empty strings.
- **Default embedding model** — free-text input for now, defaulting to whatever the provider step suggested.

Both writes go through `PATCH /api/v1/admin/orchestration/settings` and invalidate the in-memory settings cache.

## Behaviour

- **Probe on open.** The wizard fans out `GET /providers?limit=1` and `GET /agents?limit=1` on first open. If `agents.total >= 1`, it jumps to step 5 (test). If only `providers.total >= 1`, it jumps to step 3 (confirm default models). Step indexes match the 6-step layout: `0 intro · 1 provider · 2 default models · 3 agent · 4 test · 5 done`.
- **Resume.** Step index + draft form values are persisted under the versioned localStorage key. Closing and reopening the dialog resumes at the same step. `Finish` clears the key.
- **Versioned key.** `sunrise.orchestration.setup-wizard.v2`. The bump from `v1` was driven by the layout change (5 → 6 steps) and the removal of hardcoded `provider: 'anthropic'` / `model: 'claude-opus-4-6'` defaults from the agent draft.
- **Friendly errors only.** Server errors are never forwarded verbatim — see `.context/orchestration/chat.md` for the matching server-side sanitization.
- **Abort on unmount.** The SSE chat step holds an `AbortController` (in shared `<AgentTestChat>` component, `components/admin/orchestration/agent-test-chat.tsx`).

## Fresh-install gate

`app/admin/orchestration/page.tsx` calls `getSetupState()` from `lib/orchestration/setup-state.ts`, which returns `{ hasProvider, hasAgent, hasDefaultChatModel }`. The dashboard:

- Renders `<SetupRequiredBanner hasProvider={…} />` (informational card) — hides itself when `hasProvider` is true.
- Passes `forceOpen={!setupState.hasProvider}` to `<SetupWizardLauncher>` so the wizard auto-opens on a fresh install.

`getSetupState()` falls back to the safest "everything-set-up" state on DB failure so a transient blip doesn't pop the banner.

## Hooks used

- `useLocalStorage<WizardState>(STORAGE_KEY, DEFAULT_STATE)` — persistence. See [`.context/ui/hooks.md`](../ui/hooks.md).
- `useWizard({ totalSteps: 6 })` — step state machine.

## Contextual help

Every form field in the wizard has a `<FieldHelp>` ⓘ popover. See [`.context/ui/contextual-help.md`](../ui/contextual-help.md).

## Adding a new step

1. Bump `TOTAL_STEPS` and add a label to `STEP_LABELS`.
2. Add a new sub-component (`StepX`) alongside the others.
3. Render it inside the step switch in `SetupWizard`.
4. If the new step introduces additional state, extend `WizardState` and `DEFAULT_STATE`, then bump the localStorage key version so existing users with old drafts don't trip on the new fields.

## Related

- [Orchestration Dashboard](./orchestration-dashboard.md)
- [Provider Form](./provider-form.md)
- [Contextual help directive](../ui/contextual-help.md)
- [Hooks reference](../ui/hooks.md)
- [Provider selection matrix](../orchestration/provider-selection-matrix.md)
