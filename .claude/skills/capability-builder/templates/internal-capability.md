# Template: Internal Capability

Use this template for capabilities that execute TypeScript business logic within the app.

## File: `lib/orchestration/capabilities/built-in/<slug>.ts`

```typescript
import { z } from 'zod';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

// ── Zod schema ──────────────────────────────────────────────────
const schema = z.object({
  // Define args here — never use z.any()
  example_field: z.string().min(1).max(200),
});

type Args = z.infer<typeof schema>;

// ── Return data shape ───────────────────────────────────────────
interface Data {
  // Define what execute() returns
  result: string;
}

// ── Capability class ────────────────────────────────────────────
export class ExampleCapability extends BaseCapability<Args, Data> {
  readonly slug = 'example_slug';

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'example_slug', // MUST match slug
    description: 'One-sentence description of what this tool does.',
    parameters: {
      type: 'object',
      properties: {
        example_field: {
          type: 'string',
          description: 'Description for the LLM.',
          minLength: 1,
          maxLength: 200,
        },
      },
      required: ['example_field'],
    },
  };

  protected readonly schema = schema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    // Business logic here — args are pre-validated and typed
    // Use context.userId, context.agentId as needed

    // On failure:
    // return this.error('Something went wrong', 'error_code');

    // On success:
    return this.success({ result: args.example_field });

    // If result IS the final answer (no follow-up LLM turn):
    // return this.success(data, { skipFollowup: true });
  }
}
```

## Registry entry in `lib/orchestration/capabilities/registry.ts`

```typescript
import { ExampleCapability } from './built-in/example-slug';

export function registerBuiltInCapabilities(): void {
  if (registered) return;
  // ... existing registrations ...
  capabilityDispatcher.register(new ExampleCapability());
  registered = true;
}
```

## Database row

```json
{
  "name": "Example Tool",
  "slug": "example_slug",
  "description": "One-sentence description",
  "category": "internal",
  "executionType": "internal",
  "executionHandler": "ExampleCapability",
  "functionDefinition": {
    "name": "example_slug",
    "description": "One-sentence description of what this tool does.",
    "parameters": {
      "type": "object",
      "properties": {
        "example_field": {
          "type": "string",
          "description": "Description for the LLM.",
          "minLength": 1,
          "maxLength": 200
        }
      },
      "required": ["example_field"]
    }
  },
  "requiresApproval": false,
  "rateLimit": 30,
  "isActive": true
}
```

## Agent binding

```json
{
  "capabilityId": "<id-from-db-row>",
  "isEnabled": true,
  "customRateLimit": null
}
```
