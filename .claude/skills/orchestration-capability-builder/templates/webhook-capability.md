# Template: Webhook Capability

Use this template for fire-and-forget notifications to external systems. Similar to API type but intended for one-way communication where the response is not used by the agent.

## Database row only (no code files needed)

```json
{
  "name": "Slack Notification",
  "slug": "notify_slack",
  "description": "Send a notification to a Slack webhook",
  "category": "notification",
  "executionType": "webhook",
  "executionHandler": "https://hooks.slack.com/services/T00/B00/xxxx",
  "functionDefinition": {
    "name": "notify_slack",
    "description": "Send a notification message to the team's Slack channel.",
    "parameters": {
      "type": "object",
      "properties": {
        "message": {
          "type": "string",
          "description": "The notification message to send.",
          "minLength": 1,
          "maxLength": 2000
        },
        "channel": {
          "type": "string",
          "description": "Target Slack channel name.",
          "minLength": 1,
          "maxLength": 100
        }
      },
      "required": ["message"]
    }
  },
  "requiresApproval": false,
  "rateLimit": 5,
  "isActive": true
}
```

## Key differences from API type

- `executionType` is `"webhook"` instead of `"api"`
- Intended for fire-and-forget — the response from the webhook is not fed back to the LLM
- Lower rate limits are typical (notifications should be infrequent)
- Consider `requiresApproval: true` for webhooks that trigger external actions

## When to use webhook type

- Slack/Teams/Discord notifications
- Triggering external CI/CD pipelines
- Sending events to monitoring systems
- Any case where you need to notify but don't need the response
