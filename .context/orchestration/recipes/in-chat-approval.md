# In-chat user approval before action

A different shape from the rest of the recipes — this one doesn't wrap an outbound HTTP call. It uses the `run_workflow` capability to surface a workflow's `human_approval` step inline in the chat as an Approve / Reject card, so the **end user themselves** confirms the action before it happens. Useful when the agent is about to do something costly or irreversible and the user is the right authoriser (utility billing confirmation, e-commerce refund, planning pre-screening submission, regulatory acknowledgement).

## When to use this recipe

- The action requires user consent before execution and the consent has to live in the same conversation (no out-of-band email or Slack click).
- The action is multi-step or has post-approval branching that fits a workflow more cleanly than a single capability call.
- You want the workflow's full audit trace (trace entries, cost log rows, approval actor record) for compliance.

If you only need a single tool call gated by an admin (not the user), use the existing `requiresApproval` flag on the capability row instead — the admin queue at `/admin/orchestration/approvals` clears those.

## What you ship

- A workflow with at least one `human_approval` step (built in the workflow editor or seeded).
- A `run_workflow` capability binding on the agent with `customConfig.allowedWorkflowSlugs` listing the workflow's slug.
- Optional system-instructions update so the LLM reaches for `run_workflow` at the right moments.
- Optional: `OrchestrationSettings.embedAllowedOrigins` populated with partner-site origins (only needed for the embed widget).

## Allowlist hosts

None — `run_workflow` doesn't make outbound HTTP calls. The workflow itself may, but those go through the existing `call_external_api` allowlist machinery.

## Credential setup

None — workflow execution runs against your own database. The HMAC-signed approval tokens use `BETTER_AUTH_SECRET` which is already required by the auth layer.

## Capability binding

Bind `run_workflow` to your agent with this `customConfig`:

```json
{
  "allowedWorkflowSlugs": ["refund-flow", "send-billing-confirmation"],
  "defaultBudgetUsd": 0.5
}
```

- `allowedWorkflowSlugs` (required, min 1): whitelist of workflow slugs this binding may invoke. The LLM passes a slug when calling the tool; we check membership server-side. The binding fails closed if the field is missing or malformed.
- `defaultBudgetUsd` (optional): forwarded to the engine as `budgetLimitUsd`. Caps the spend of any chat-triggered run; the workflow halts with `workflow_failed` on overrun and the LLM gets an error tool result.

## Agent prompt guidance

Add to the agent's system instructions:

> When the user asks for an action that requires their explicit confirmation (refund, charge, irreversible submit), call `run_workflow` with the appropriate `workflowSlug`. Don't narrate further until the user approves or rejects in-chat — the workflow will pause for their approval and the system surfaces the prompt to them. After the user replies, summarise the workflow's outcome based on the follow-up message.

The capability description (visible to the LLM) already nudges in the right direction — `"do not narrate further until the user replies"` — so this is reinforcement rather than load-bearing.

## Worked example

User: _"Please refund order #12345."_

1. LLM calls `run_workflow({ workflowSlug: 'refund-flow', input: { orderId: '12345' } })`.
2. The workflow executes its first step (e.g. an `external_call` that fetches the order details), then hits a `human_approval` step with prompt _"Refund £42.50 for order #12345 to the original payment method?"_.
3. The capability returns `{ status: 'pending_approval', executionId, stepId, prompt, expiresAt, approveToken, rejectToken }` with `skipFollowup: true`.
4. The chat handler emits an `approval_required` SSE event and persists a synthetic empty-content assistant message with `metadata.pendingApproval` set.
5. The chat surface (admin chat or embed widget) renders an Approve / Reject card from the event.
6. User clicks **Approve**. The card POSTs to `/api/v1/orchestration/approvals/:id/approve/chat?token=…` with optional notes; the route hard-codes `actorLabel: 'token:chat'` and applies same-origin CORS (or `…/approve/embed` for the widget, with the configured origin allowlist).
7. The card polls `GET /api/v1/orchestration/approvals/:id/status?token=…` until `status === 'completed'`.
8. The card synthesises a follow-up user message: _"Workflow approved. Result: { refundId: 'r-99', amount: 42.50 }"_ — sent through the normal chat-stream path so the LLM gets a fresh turn.
9. LLM replies: _"Done — order #12345 has been refunded. The refund reference is r-99."_

## Common variants

**Approval-only workflow.** A single-step workflow consisting of just a `human_approval` step is valid. The `prompt` for the user comes from the step config; the workflow output (per `output: { approved: true, notes, actor }`) flows back into the chat as the follow-up message.

**Conditional follow-up.** After the approval step, branch into different next steps based on whether the user approved with notes vs without. The `notes` and `actor` fields are available in the trace for downstream steps to read via template interpolation.

**Multi-budget cap.** Combine `defaultBudgetUsd` on the binding with a stricter `budgetLimitUsd` per workflow definition. The lower of the two wins — useful when one binding scopes "any chat-run workflow" and individual workflows further constrain themselves.

## Anti-patterns

- **Don't bind `run_workflow` to an agent without `allowedWorkflowSlugs`.** The capability fail-closes (returns `'invalid_binding'`) when the whitelist is missing — the LLM can't bypass this.
- **Don't trust an `actorLabel` body field from the client.** The chat-rendered Approve / Reject buttons hit the channel-specific sub-routes (`…/approve/chat`, `…/approve/embed`) and the server pins the actor on the route. A leaked HMAC token can't be replayed under a misleading channel name.
- **Don't try to resume the chat stream from the approve POST.** The carry-the-output-back model — poll the execution to a terminal state, then submit a follow-up message — uses primitives that already exist. Re-entering `streamChat` from a non-chat path would require a per-conversation pub/sub layer that isn't there.
- **Don't widen the legacy `/approve` and `/reject` routes' CORS.** They serve email and Slack callers and have no CORS by design. Use the channel-specific sub-routes (`/chat`, `/embed`) for browser-originated flows.

## Test plan

1. Create a test workflow with a single `human_approval` step (prompt: `"Confirm test action?"`).
2. Bind `run_workflow` to a test agent with `allowedWorkflowSlugs: ['<your-slug>']`.
3. In the agent's admin chat, ask the agent to run that workflow. Verify the Approve / Reject card renders inline.
4. Click **Approve**. Verify:
   - The workflow's trace entry transitions from `awaiting_approval` to `completed` with `actor: 'token:chat'`.
   - The execution row's status becomes `completed`.
   - The card transitions to "Approved — workflow completed."
   - A follow-up user message appears in the conversation containing `"Workflow approved. Result: …"`.
   - The LLM produces a summary on the next turn.
5. Repeat with **Reject** (with a reason). Verify cancellation, `actor: 'token:chat'`, and a follow-up containing `"Workflow rejected: …"`.
6. **For the embed widget**, populate `OrchestrationSettings.embedAllowedOrigins` with your partner-site origin. Verify (a) the card POSTs succeed from the allowlisted origin and (b) requests from a non-allowlisted origin are rejected with 403.
7. Tamper with the HMAC token: replay an old / modified token and verify a 401.

## Related

- Streaming Chat — In-chat approvals: [chat.md](../chat.md#in-chat-approvals)
- Approval queue (admin-only path): [orchestration-approvals.md](../../admin/orchestration-approvals.md)
- Embed Widget integration: [embed.md](../embed.md)
- The `run_workflow` capability shape: [capabilities.md](../capabilities.md#run_workflow)
