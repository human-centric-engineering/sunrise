# Template: Router Workflow

A routing workflow that classifies input and branches to different processing paths.

```json
{
  "entryStepId": "classify",
  "errorStrategy": "fail",
  "steps": [
    {
      "id": "classify",
      "name": "Classify Intent",
      "type": "route",
      "config": {
        "classificationPrompt": "Classify the user's intent as one of: 'question', 'action', 'feedback'. Respond with only the classification word.",
        "routes": {
          "question": "User is asking a question or seeking information",
          "action": "User wants to perform an action or make a change",
          "feedback": "User is providing feedback or a complaint"
        }
      },
      "nextSteps": [
        { "targetStepId": "answer", "condition": "question" },
        { "targetStepId": "execute", "condition": "action" },
        { "targetStepId": "acknowledge", "condition": "feedback" }
      ]
    },
    {
      "id": "answer",
      "name": "Answer Question",
      "type": "llm_call",
      "config": {
        "prompt": "Answer this question helpfully and concisely:\n\n{{input}}",
        "temperature": 0.3
      },
      "nextSteps": [{ "targetStepId": "respond" }]
    },
    {
      "id": "execute",
      "name": "Execute Action",
      "type": "llm_call",
      "config": {
        "prompt": "Plan and describe the steps to execute this action:\n\n{{input}}",
        "temperature": 0.5
      },
      "nextSteps": [{ "targetStepId": "respond" }]
    },
    {
      "id": "acknowledge",
      "name": "Acknowledge Feedback",
      "type": "llm_call",
      "config": {
        "prompt": "Acknowledge this feedback professionally and outline next steps:\n\n{{input}}",
        "temperature": 0.5
      },
      "nextSteps": [{ "targetStepId": "respond" }]
    },
    {
      "id": "respond",
      "name": "Final Response",
      "type": "llm_call",
      "config": {
        "prompt": "Polish this into a final user-facing response:\n\n{{previous.output}}",
        "temperature": 0.7
      },
      "nextSteps": []
    }
  ]
}
```

## When to use

- Multi-intent chatbots (support, sales, general)
- Triage systems that route to different processing paths
- Any scenario where different inputs need different handling

## Key rules

- `routes` object keys must match `nextSteps[].condition` values exactly (case-sensitive)
- Route steps need at least 2 branches (validator enforces this)
- Use a cheap model (`modelOverride: "claude-haiku-4-5"`) for classification — it's fast and accurate for routing
- All branches should converge to a final step for consistent output format
