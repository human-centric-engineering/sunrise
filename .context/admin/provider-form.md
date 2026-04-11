# Provider form

Shared create/edit form for `AiProviderConfig`. Raw `react-hook-form` + `zodResolver`, same sticky action bar pattern as [`agent-form.md`](./agent-form.md) and [`capability-form.md`](./capability-form.md).

**File:** `components/admin/orchestration/provider-form.tsx`

The form's interesting feature is the **flavor selector** — the backend only knows two `providerType` values (`anthropic`, `openai-compatible`), but the UI presents four choices so admins don't have to think about provider-compatibility plumbing.

## Flavor selector

A `role="radiogroup"` of four bordered cards at the top of the form. The selected flavor drives the rest of the form — which fields are visible, what their defaults are, and how the submit payload is composed.

| Flavor              | Shown fields                              | `providerType`      | `baseUrl` default           | `isLocal` | `apiKeyEnvVar` default |
| ------------------- | ----------------------------------------- | ------------------- | --------------------------- | --------- | ---------------------- |
| `anthropic`         | Name, Slug, apiKeyEnvVar, Active          | `anthropic`         | — (not asked)               | `false`   | `ANTHROPIC_API_KEY`    |
| `openai`            | Name, Slug, apiKeyEnvVar, Active          | `openai-compatible` | `https://api.openai.com/v1` | `false`   | `OPENAI_API_KEY`       |
| `ollama`            | Name, Slug, baseUrl, Active               | `openai-compatible` | `http://localhost:11434/v1` | `true`    | — (not asked)          |
| `openai-compatible` | Name, Slug, baseUrl, apiKeyEnvVar, Active | `openai-compatible` | — (required input)          | `false`   | — (optional input)     |

`providerType` and `isLocal` are never tracked in form state — they're derived from `flavor` on submit and injected into the POST/PATCH payload. The client-side Zod schema only tracks `{ flavor, name, slug, baseUrl?, apiKeyEnvVar?, isActive }`.

### Reverse mapping on edit

When rendering an existing provider the form reverse-maps the row back to a flavor so the UI round-trips cleanly:

```ts
function flavorFromProvider(p): Flavor {
  if (p.providerType === 'anthropic') return 'anthropic';
  if (p.isLocal) return 'ollama';
  if (p.baseUrl?.includes('api.openai.com')) return 'openai';
  return 'openai-compatible';
}
```

### Flavor change behaviour

In **create mode**, switching flavor refills `baseUrl` and `apiKeyEnvVar` with the new flavor's defaults, and (if the admin hasn't edited the slug yet) also refills `name` and `slug`. In **edit mode**, switching flavor leaves the admin's typed values intact — the flavor change only affects which fields are visible.

## Fields

### Name / Slug

Same auto-slug behaviour as `agent-form.tsx`: typing `name` auto-fills `slug` via `toSlug()` until the user edits the slug. Slug is disabled in edit mode — changing a slug breaks existing agent references.

### Base URL

Rendered only when `flavorMeta.showBaseUrl` is true (all flavors except Anthropic). Placeholder shows the flavor default. Validated as a URL client-side (`z.string().url()`); the **SSRF guard** lives on the backend in `refineProviderBaseUrl()` (see `lib/validations/orchestration.ts` and `lib/security/safe-url.ts`).

If the backend refuses the URL (e.g. loopback address, private network), the sanitized 400 response is rendered inline via the error banner at the top of the form. The client never pre-validates against internal addresses — we trust the backend to be the authority and let its error message through.

### API key env var

Rendered only when `flavorMeta.showApiKeyEnvVar` is true (all flavors except Ollama). Validated client-side as `/^[A-Z][A-Z0-9_]*$/` (SCREAMING_SNAKE_CASE) — same regex as `providerConfigSchema`.

A green ✓ "set" or red ✗ "missing" indicator renders next to the input based on `apiKeyPresent` on the provider row (see [`orchestration-providers.md`](./orchestration-providers.md) for the security model). The indicator re-renders on every PATCH response.

**Help copy (exact):** _"Name of the environment variable that holds your API key (e.g. `ANTHROPIC_API_KEY`). The UI never stores the key itself — just this name. The backend reads `process.env[…]` at request time."_

### Active

Shadcn `<Switch>`. Inactive providers stay in the list but are skipped when resolving agents.

## Test connection

Below the fields in edit mode (create mode has no id yet, so there's nothing to test) — renders `<ProviderTestButton providerId={provider.id} />`. Behaviour and error sanitization are documented in [`orchestration-providers.md`](./orchestration-providers.md#providertestbutton--shared-extract).

## Submit flow

```ts
// Compose payload from flavor + form state
const meta = FLAVORS.find((f) => f.id === data.flavor);
const payload = {
  name: data.name,
  slug: data.slug,
  providerType: meta.providerType,
  isLocal: meta.isLocal,
  isActive: data.isActive,
  ...(baseUrl ? { baseUrl } : {}),
  ...(apiKeyEnvVar ? { apiKeyEnvVar } : {}),
};

if (isEdit) {
  const updated = await apiClient.patch(API.ADMIN.ORCHESTRATION.providerById(provider.id), {
    body: payload,
  });
  setApiKeyPresent(updated.apiKeyPresent ?? null); // re-check the green/red indicator
  reset({ ...data, baseUrl: updated.baseUrl ?? '', apiKeyEnvVar: updated.apiKeyEnvVar ?? '' });
} else {
  const created = await apiClient.post(API.ADMIN.ORCHESTRATION.PROVIDERS, { body: payload });
  router.push(`/admin/orchestration/providers/${created.id}`);
}
```

## Related

- [Providers list page](./orchestration-providers.md) — card grid, status dots, models dialog, key env var security model
- [Agent form](./agent-form.md) — the Model tab consumes the same `<ProviderTestButton>`
- [LLM providers (runtime)](../orchestration/llm-providers.md)
- [Admin API reference](../orchestration/admin-api.md)
