# Template: Approval Workflow

A workflow with human approval gates for sensitive operations.

```json
{
  "entryStepId": "draft",
  "errorStrategy": "fail",
  "steps": [
    {
      "id": "draft",
      "name": "Draft Response",
      "type": "llm_call",
      "config": {
        "prompt": "Draft a response to this request:\n\n{{input}}\n\nInclude a summary of what actions will be taken.",
        "temperature": 0.5
      },
      "nextSteps": [{ "targetStepId": "guard" }]
    },
    {
      "id": "guard",
      "name": "Safety Check",
      "type": "guard",
      "config": {
        "rules": "Check that the response does not contain PII, financial commitments over $100, or promises that cannot be fulfilled. Flag if any are detected.",
        "mode": "llm",
        "failAction": "block",
        "temperature": 0.1
      },
      "nextSteps": [{ "targetStepId": "approve" }]
    },
    {
      "id": "approve",
      "name": "Human Approval",
      "type": "human_approval",
      "config": {
        "prompt": "Please review the drafted response and approve or reject it. The response has passed safety checks.",
        "timeoutMinutes": 60,
        "notificationChannel": "in-app"
      },
      "nextSteps": [{ "targetStepId": "send" }]
    },
    {
      "id": "send",
      "name": "Send Response",
      "type": "send_notification",
      "config": {
        "channel": "email",
        "to": "{{input.customer_email}}",
        "subject": "Re: {{input.subject}}",
        "bodyTemplate": "{{draft.output}}"
      },
      "nextSteps": []
    }
  ]
}
```

## When to use

- Customer-facing responses that need human review
- Financial operations (refunds, credits, billing changes)
- Any workflow where incorrect output has high business impact

## Key considerations

- `human_approval` **pauses the entire workflow** — the execution status becomes `paused_for_approval`
- Set `timeoutMinutes` appropriately — after timeout, the approval step fails according to the error strategy
- Use `guard` steps before `human_approval` to filter out obvious problems before consuming human attention
- The approval queue is visible in the admin UI under the "Approvals" sidebar section
- Consider `notificationChannel: "email"` for workflows where reviewers aren't always in the admin UI
