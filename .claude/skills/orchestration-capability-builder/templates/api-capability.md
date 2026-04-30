# Template: API Capability

Use this template for capabilities that call an external REST API. No TypeScript class needed — the dispatcher makes the HTTP call directly.

## Database row only (no code files needed)

```json
{
  "name": "External Order API",
  "slug": "external_order_lookup",
  "description": "Calls the external order service API to look up order details",
  "category": "external",
  "executionType": "api",
  "executionHandler": "https://api.example.com/v1/orders",
  "functionDefinition": {
    "name": "external_order_lookup",
    "description": "Look up an order by ID from the external order service.",
    "parameters": {
      "type": "object",
      "properties": {
        "order_id": {
          "type": "string",
          "description": "The order ID to look up.",
          "minLength": 1,
          "maxLength": 100
        }
      },
      "required": ["order_id"]
    }
  },
  "requiresApproval": false,
  "rateLimit": 10,
  "isActive": true
}
```

## Key differences from internal

- `executionType` is `"api"` instead of `"internal"`
- `executionHandler` is a full URL, not a class name
- URL is validated by `checkSafeProviderUrl` (blocks private IPs, localhost, etc.)
- No TypeScript class, no registry entry needed
- The dispatcher sends validated args as the request body to the URL
- Response is returned as the capability result

## Agent binding

Same as internal — attach via:

```
POST /api/v1/admin/orchestration/agents/{agentId}/capabilities
{
  "capabilityId": "<id>",
  "isEnabled": true,
  "customRateLimit": null
}
```

## When to use API type

- Calling third-party services (Stripe, Twilio, external CRMs)
- Calling internal microservices with their own HTTP endpoints
- When you don't want to add TypeScript code to the Sunrise app
