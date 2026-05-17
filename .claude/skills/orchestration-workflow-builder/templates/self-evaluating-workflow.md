# Template — Self-evaluating workflow

A workflow that audits its own execution. The terminal triplet is
`supervisor → report → send_notification`: the supervisor produces an
evidence-cited verdict, the report renders a human-readable
step-by-step narration, and the notification combines both. Copy-paste
starting point for any workflow whose output recipients should see an
honest assessment of what happened, not just an optimistic summary.

## When to use this pattern

- The workflow's terminal output is opinionated (a generated report, a
  decision, a recommendation) and you want a separate honest read on
  whether it can be trusted.
- The workflow's main body is agent-authored (one or more `agent_call`
  or `llm_call` steps) and you don't want those agents marking their
  own homework.
- The output is sent somewhere (email, webhook, downstream workflow)
  where the recipient will rely on it without seeing the trace.
- You're shipping an audit / compliance / regulatory workflow and need
  defensible documentation that the run was reviewed.

## Anti-pattern (don't do this)

- Don't put the supervisor inside a `parallel` branch (it'll judge a
  partial trace).
- Don't put the report before the supervisor (the report can't
  describe the verdict yet).
- Don't set `failOnVerdict: 'fail'` on the supervisor unless you have
  a deliberate rollback story — by default the supervisor is advisory.

## Minimal DAG

```json
{
  "entryStepId": "main_body",
  "errorStrategy": "retry",
  "steps": [
    {
      "id": "main_body",
      "name": "Workflow's actual work goes here",
      "type": "llm_call",
      "config": {
        "prompt": "Process {{input.payload}} and return a structured answer.",
        "modelOverride": "",
        "temperature": 0.4
      },
      "nextSteps": [{ "targetStepId": "supervisor_review" }]
    },
    {
      "id": "supervisor_review",
      "name": "Neutral supervisor review",
      "type": "supervisor",
      "config": {
        "assessmentCriteria": "Did main_body produce an answer that is (1) grounded in the workflow input, (2) internally consistent, and (3) free of unsupported claims? Is the answer's confidence appropriate to the evidence cited?",
        "redTeamPrompts": [
          "Did main_body invent facts not present in the input?",
          "Does the answer reference data that no step in the trace produced?",
          "Is the answer overconfident relative to the input's ambiguity?"
        ],
        "requireEvidenceCitations": true,
        "minWeaknesses": 1,
        "useJudgeModel": true,
        "temperature": 0.2,
        "failOnVerdict": "never",
        "includeStepOutputs": "auto",
        "defaultEnabled": true,
        "respectRuntimeOptOut": true,
        "errorStrategy": "skip"
      },
      "nextSteps": [{ "targetStepId": "report_render" }]
    },
    {
      "id": "report_render",
      "name": "Render human-readable report",
      "type": "report",
      "config": {
        "format": "markdown",
        "includeStepOutputs": "auto",
        "defaultEnabled": true,
        "respectRuntimeOptOut": true,
        "errorStrategy": "skip"
      },
      "nextSteps": [{ "targetStepId": "notify" }]
    },
    {
      "id": "notify",
      "name": "Send result with audit + report",
      "type": "send_notification",
      "config": {
        "channel": "email",
        "to": "admin@example.com",
        "subject": "Workflow result + supervisor verdict",
        "bodyTemplate": "## Supervisor verdict\n\nVerdict: {{supervisor_review.output.verdict}} (score {{supervisor_review.output.score}})\n\n{{supervisor_review.output.summary}}\n\n### Weaknesses\n{{supervisor_review.output.weaknesses}}\n\n### Unverified areas\n{{supervisor_review.output.unverifiedAreas}}\n\n---\n\n## Workflow output\n\n{{main_body.output}}\n\n---\n\n## Full step-by-step report\n\n{{report_render.output.markdown}}",
        "errorStrategy": "skip"
      },
      "nextSteps": []
    }
  ]
}
```

## Run-time toggles

Both `supervisor` and `report` respect run-time opt-out via reserved input keys:

- `inputData.__runSupervisor: false` → supervisor skips, no judge-model cost, no verdict block in the notification.
- `inputData.__generateReport: false` → report skips, no rendered markdown in the notification.

The "Execute workflow" admin dialog renders pre-checked checkboxes for both. Operators uncheck on tight-budget runs.

## Variations

- **Pre-irreversible audit**: insert `supervisor` _before_ an `apply_changes` `tool_call`, set `failOnVerdict: 'fail'`, and the engine's error strategy decides whether to proceed. Useful when the workflow can't be undone (database writes, external API mutations, money movement).
- **Audit-only**: drop the `report` step and just include the supervisor's verdict in the notification. Cheaper, less context for the recipient.
- **Download-only**: drop both the `report` step AND the verdict block from the notification. Recipients can hit `GET /executions/:id/report.md` on demand from the admin UI's "Download report" button.

## Reference implementation

The provider-model-audit template (`prisma/seeds/data/templates/provider-model-audit.ts`) implements this pattern end-to-end across 16 steps. Worth reading as a real-world example of:

- `assessmentCriteria` written for a specific workflow's success conditions
- `redTeamPrompts` listing workflow-specific failure modes
- The notification body interpolating both `{{supervisor_review.output}}` and `{{report_render.output.markdown}}`
- The failure-branch terminus (`report_validation_failure`) which deliberately does NOT include the supervisor — the guard exhaustion is already a clear signal

## Cross-references

- `.context/admin/workflow-builder.md` — Supervisor step UI reference
- `.context/orchestration/patterns-and-steps.md` — `evaluate` vs `supervisor` decision matrix
- `lib/orchestration/supervisor/index.ts` — shared assessment core
- `lib/orchestration/trace/render-markdown.ts` — deterministic renderer
- `app/api/v1/admin/orchestration/executions/[id]/review/route.ts` — retroactive review endpoint
