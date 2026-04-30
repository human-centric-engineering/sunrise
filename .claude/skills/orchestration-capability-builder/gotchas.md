# Capability Builder — Gotchas

## Slug Triple-Match

The `slug` must be identical in three places:

1. `BaseCapability.slug` property
2. `functionDefinition.name` field
3. `AiCapability.slug` in the database row

A mismatch causes **silent failures** — the dispatcher can't route to the handler, or the LLM sees a tool name that doesn't match any registered handler.

## Zod Schema vs JSON Schema Duality

The capability has TWO schemas that must be **semantically equivalent but are syntactically different**:

- `schema` (protected) — Zod schema, used by `validate()` to parse raw LLM args
- `functionDefinition.parameters` — OpenAI-compatible JSON Schema, shown to the LLM

If these diverge, the LLM will send args that pass the JSON Schema but fail Zod validation (or vice versa). Common mismatches:

- Zod has `.min(1)` but JSON Schema is missing `minLength`
- Zod field is `.optional()` but JSON Schema lists it in `required`
- Zod uses `.int()` but JSON Schema says `type: "number"` instead of `type: "integer"`

## executionHandler for Internal Type

For `executionType: "internal"`, the `executionHandler` field must match the **class name** exactly (e.g., `"LookupOrderCapability"`). This is how the dispatcher routes to the correct in-memory handler.

For `api` and `webhook` types, `executionHandler` must be a valid URL, validated by `checkSafeProviderUrl` on both client and server.

## Don't Catch CapabilityValidationError

`CapabilityValidationError` is thrown by `validate()` and **caught by the dispatcher**, which wraps it in `{ success: false, error: { code: 'invalid_args' } }`. Never catch it inside `execute()` — your `execute()` method receives pre-validated, typed args.

## customRateLimit Override

The `customRateLimit` on the `AiAgentCapability` pivot row **overrides** (not adds to) the base capability's `rateLimit` for that specific agent. Setting it to `null` falls through to the base rate limit.

## Default-Allow vs Default-Deny

- `dispatch()` is **default-allow** — no `AiAgentCapability` row means use base capability defaults. Backend/CLI callers can dispatch without admin wiring.
- `getCapabilityDefinitions()` is **default-deny** — only capabilities with an explicit `AiAgentCapability` row (`isEnabled: true`) AND active `AiCapability` AND registered handler are returned to the LLM.

This means: a capability can work when dispatched manually but be invisible to an agent if the binding row is missing.

## Built-in Capabilities Are isSystem: true

The 6 built-in capabilities (`search_knowledge_base`, `get_pattern_detail`, `estimate_workflow_cost`, `read_user_memory`, `write_user_memory`, `escalate_to_human`) are seeded with `isSystem: true` and **cannot be deleted** via the API. To give an agent access, bind the existing capability — don't create a new one with the same slug.

## No next/\* Imports

`lib/orchestration/` is platform-agnostic. Never import from `next/headers`, `next/server`, etc. in capability files. If you need request context, it should come through `CapabilityContext.entityContext`.

## Dispatcher Pipeline Order Matters for Debugging

The 9-step pipeline runs in sequence and returns on first failure. If you're seeing `capability_inactive` but the capability exists, check that `isActive: true` on the DB row. If you're seeing `unknown_capability`, the handler isn't registered in `registry.ts`. The error code tells you exactly which step failed.
