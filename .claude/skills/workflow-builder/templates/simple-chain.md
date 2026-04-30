# Template: Simple Chain Workflow

A 3-step linear workflow: process input, refine output, produce final result.

```json
{
  "entryStepId": "process",
  "errorStrategy": "fail",
  "steps": [
    {
      "id": "process",
      "name": "Process Input",
      "type": "llm_call",
      "config": {
        "prompt": "Analyze the following input and extract key information:\n\n{{input}}",
        "temperature": 0.3
      },
      "nextSteps": [{ "targetStepId": "refine" }]
    },
    {
      "id": "refine",
      "name": "Refine Output",
      "type": "llm_call",
      "config": {
        "prompt": "Refine and improve the following analysis:\n\n{{previous.output}}",
        "temperature": 0.5
      },
      "nextSteps": [{ "targetStepId": "finalize" }]
    },
    {
      "id": "finalize",
      "name": "Produce Final Result",
      "type": "llm_call",
      "config": {
        "prompt": "Produce a polished final result based on this refined analysis:\n\n{{previous.output}}",
        "temperature": 0.7
      },
      "nextSteps": []
    }
  ]
}
```

## When to use

- Sequential text processing (summarize → refine → format)
- Multi-step content generation
- Progressive refinement of LLM output

## Customisation points

- Add `modelOverride` to use different models per step (cheaper model for extraction, better model for final output)
- Add `errorStrategy: "retry"` on individual steps for resilience
- Insert `evaluate` or `guard` steps between chain links for quality gates
