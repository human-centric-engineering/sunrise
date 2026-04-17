# Setup Wizard

Five-step guided flow that walks a new admin from "fresh install" to "I have a working agent I can chat with". Mounted from the Orchestration Dashboard header via the `Setup Guide` button.

**Component:** `components/admin/orchestration/setup-wizard.tsx`
**Launcher:** `components/admin/orchestration/setup-wizard-launcher.tsx`
**Storage key:** `sunrise.orchestration.setup-wizard.v1`

## Steps

| #   | Title                   | Purpose                                                                  | Auto-skip?                         |
| --- | ----------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| 1   | What are you building?  | Pattern advisor chat — recommends patterns/workflows based on use case   | Always skippable                   |
| 2   | Configure a provider    | Probes `/providers?limit=1`. Inline create form if empty.                | Auto-complete when providers exist |
| 3   | Create your first agent | Inline form → `POST /agents`                                             | Auto-complete when agents exist    |
| 4   | Test your agent         | Embeds `<AgentTestChat>` — same SSE consumer used by the agent edit page | —                                  |
| 5   | What's next             | Static links; `Finish` clears localStorage and closes the dialog         | —                                  |

## Behaviour

- **Probe on open.** The wizard fans out `GET /providers?limit=1` and `GET /agents?limit=1` on first open. If either `meta.total >= 1`, it jumps to the first incomplete step (so repeat visits don't re-ask what the user already answered).
- **Resume.** Step index + draft form values are persisted under the versioned localStorage key. Closing and reopening the dialog resumes at the same step. `Finish` clears the key.
- **Versioned key.** `sunrise.orchestration.setup-wizard.v1`. If the stored shape ever changes in a breaking way, bump the version (`.v2`) so stale drafts are silently ignored rather than crashing the parser.
- **Friendly errors only.** Server errors are never forwarded verbatim. The wizard shows a generic message ("Could not create the provider. Check the name, slug, and env var and try again.") and the underlying API route logs the real error. See `.context/orchestration/chat.md` for the matching server-side sanitization.
- **Abort on unmount.** The SSE chat step holds an `AbortController` and calls `.abort()` on unmount to clean up in-flight reads. As of Session 4.2 this logic lives in the shared `<AgentTestChat>` component (`components/admin/orchestration/agent-test-chat.tsx`), which is also consumed by the agent edit page's Test tab — a regression in one place is caught by both the wizard test and the test-chat unit test.

## Hooks used

- `useLocalStorage<WizardState>(STORAGE_KEY, DEFAULT_STATE)` — persistence. See [`.context/ui/hooks.md`](../ui/hooks.md).
- `useWizard({ totalSteps: 5 })` — step state machine.

## Contextual help

Every form field in the wizard has a `<FieldHelp>` ⓘ popover. This is the reference implementation of the cross-cutting contextual help directive — see [`.context/ui/contextual-help.md`](../ui/contextual-help.md).

## Adding a new step

1. Bump `TOTAL_STEPS` and add a label to `STEP_LABELS`.
2. Add a new sub-component (`StepX`) alongside the others.
3. Render it inside the step switch in `SetupWizard`.
4. If the new step introduces additional state, extend `WizardState` and `DEFAULT_STATE`, then consider bumping the localStorage key version so existing users with old drafts don't trip on the new fields.

## Step 1 — Pattern Advisor

Step 1 embeds `<ChatInterface agentSlug="pattern-advisor" embedded />` so admins can describe their use case and receive pattern/workflow recommendations. When the advisor outputs a `workflow-definition` fenced code block, a "Create this workflow" CTA appears that navigates to the workflow builder with the definition pre-populated. The skip button remains for users who prefer manual configuration.

The `extractWorkflowDefinition` utility at `lib/orchestration/utils/extract-workflow-definition.ts` is shared with the Learning Hub's advisor tab.

## Related

- [Orchestration Dashboard](./orchestration-dashboard.md)
- [Contextual help directive](../ui/contextual-help.md)
- [Hooks reference](../ui/hooks.md)
