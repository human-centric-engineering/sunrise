# Provider form

Shared create/edit form for `AiProviderConfig`. Raw `react-hook-form` + `zodResolver`, same sticky action bar pattern as [`agent-form.md`](./agent-form.md) and [`capability-form.md`](./capability-form.md).

**File:** `components/admin/orchestration/provider-form.tsx`

The form's interesting feature is the **flavor selector** — the backend knows three `providerType` values (`anthropic`, `openai-compatible`, `voyage`), but the UI presents sixteen choices across six groups so admins don't have to think about provider-compatibility plumbing.

## Flavor selector

A `role="radiogroup"` of sixteen bordered cards organized into six collapsible groups. The selected flavor drives the rest of the form — which fields are visible, what their defaults are, and how the submit payload is composed.

### Groups and flavors

**Frontier Providers**

| Flavor      | Shown fields                     | `providerType`      | `baseUrl` default                                         | `isLocal` | `apiKeyEnvVar` default |
| ----------- | -------------------------------- | ------------------- | --------------------------------------------------------- | --------- | ---------------------- |
| `anthropic` | Name, Slug, apiKeyEnvVar, Active | `anthropic`         | — (not asked)                                             | `false`   | `ANTHROPIC_API_KEY`    |
| `google`    | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://generativelanguage.googleapis.com/v1beta/openai` | `false`   | `GOOGLE_AI_API_KEY`    |
| `mistral`   | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.mistral.ai/v1`                               | `false`   | `MISTRAL_API_KEY`      |
| `openai`    | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.openai.com/v1`                               | `false`   | `OPENAI_API_KEY`       |
| `xai`       | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.x.ai/v1`                                     | `false`   | `XAI_API_KEY`          |

**Open-Model Hosts**

| Flavor      | Shown fields                     | `providerType`      | `baseUrl` default                       | `isLocal` | `apiKeyEnvVar` default |
| ----------- | -------------------------------- | ------------------- | --------------------------------------- | --------- | ---------------------- |
| `deepseek`  | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.deepseek.com/v1`           | `false`   | `DEEPSEEK_API_KEY`     |
| `fireworks` | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.fireworks.ai/inference/v1` | `false`   | `FIREWORKS_API_KEY`    |
| `groq`      | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.groq.com/openai/v1`        | `false`   | `GROQ_API_KEY`         |
| `together`  | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.together.xyz/v1`           | `false`   | `TOGETHER_API_KEY`     |

**Embedding Specialists**

| Flavor   | Shown fields                     | `providerType`      | `baseUrl` default             | `isLocal` | `apiKeyEnvVar` default |
| -------- | -------------------------------- | ------------------- | ----------------------------- | --------- | ---------------------- |
| `cohere` | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.cohere.com/v2`   | `false`   | `COHERE_API_KEY`       |
| `voyage` | Name, Slug, apiKeyEnvVar, Active | `voyage`            | `https://api.voyageai.com/v1` | `false`   | `VOYAGE_API_KEY`       |

**Aggregators & Enterprise**

| Flavor       | Shown fields                     | `providerType`      | `baseUrl` default                                   | `isLocal` | `apiKeyEnvVar` default |
| ------------ | -------------------------------- | ------------------- | --------------------------------------------------- | --------- | ---------------------- |
| `alibaba`    | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `false`   | `ALIBABA_API_KEY`      |
| `openrouter` | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://openrouter.ai/api/v1`                      | `false`   | `OPENROUTER_API_KEY`   |
| `perplexity` | Name, Slug, apiKeyEnvVar, Active | `openai-compatible` | `https://api.perplexity.ai`                         | `false`   | `PERPLEXITY_API_KEY`   |

**Local / Self-Hosted**

| Flavor   | Shown fields                | `providerType`      | `baseUrl` default           | `isLocal` | `apiKeyEnvVar` default |
| -------- | --------------------------- | ------------------- | --------------------------- | --------- | ---------------------- |
| `ollama` | Name, Slug, baseUrl, Active | `openai-compatible` | `http://localhost:11434/v1` | `true`    | — (not asked)          |

**Custom**

| Flavor              | Shown fields                              | `providerType`      | `baseUrl` default  | `isLocal` | `apiKeyEnvVar` default |
| ------------------- | ----------------------------------------- | ------------------- | ------------------ | --------- | ---------------------- |
| `openai-compatible` | Name, Slug, baseUrl, apiKeyEnvVar, Active | `openai-compatible` | — (required input) | `false`   | — (optional input)     |

`providerType` and `isLocal` are never tracked in form state — they're derived from `flavor` on submit and injected into the POST/PATCH payload. The client-side Zod schema only tracks `{ flavor, name, slug, baseUrl?, apiKeyEnvVar?, isActive, timeoutMs?, maxRetries? }`.

### Reverse mapping on edit

When rendering an existing provider the form reverse-maps the row back to a flavor so the UI round-trips cleanly. The function first checks `providerType` for the two non-`openai-compatible` types, then `isLocal`, then tries base URL substring and slug matches for all known providers:

```ts
function flavorFromProvider(p): Flavor {
  if (p.providerType === 'anthropic') return 'anthropic';
  if (p.providerType === 'voyage') return 'voyage';
  if (p.isLocal) return 'ollama';

  const url = p.baseUrl ?? '';
  const slug = p.slug ?? '';

  // Match by base URL or slug
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('api.groq.com') || slug === 'groq') return 'groq';
  if (url.includes('api.together.xyz') || slug === 'together') return 'together';
  if (url.includes('api.fireworks.ai') || slug === 'fireworks') return 'fireworks';
  if (url.includes('api.mistral.ai') || slug === 'mistral') return 'mistral';
  if (url.includes('api.cohere.com') || slug === 'cohere') return 'cohere';
  if (url.includes('generativelanguage.googleapis.com') || slug === 'google') return 'google';
  if (url.includes('api.x.ai') || slug === 'xai') return 'xai';
  if (url.includes('api.deepseek.com') || slug === 'deepseek') return 'deepseek';
  if (url.includes('api.perplexity.ai') || slug === 'perplexity') return 'perplexity';
  if (url.includes('openrouter.ai') || slug === 'openrouter') return 'openrouter';
  if (url.includes('dashscope.aliyuncs.com') || slug === 'alibaba') return 'alibaba';

  return 'openai-compatible'; // fallback
}
```

### Flavor change behaviour

In **create mode**, switching flavor refills `baseUrl` and `apiKeyEnvVar` with the new flavor's defaults, and (if the admin hasn't edited the slug yet) also refills `name` and `slug`. In **edit mode**, switching flavor leaves the admin's typed values intact — the flavor change only affects which fields are visible.

## Fields

### Name / Slug

Same auto-slug behaviour as `agent-form.tsx`: typing `name` auto-fills `slug` via `toSlug()` until the user edits the slug. Slug is disabled in edit mode — changing a slug breaks existing agent references.

### Base URL

Rendered only when `flavorMeta.showBaseUrl` is true (Ollama and Custom flavors). For named providers (Anthropic, OpenAI, etc.) the base URL is set automatically from the flavor defaults and not shown. Placeholder shows the flavor default. Validated as a URL client-side (`z.string().url()`); the **SSRF guard** lives on the backend in `refineProviderBaseUrl()` (see `lib/validations/orchestration.ts` and `lib/security/safe-url.ts`).

If the backend refuses the URL (e.g. loopback address, private network), the sanitized 400 response is rendered inline via the error banner at the top of the form. The client never pre-validates against internal addresses — we trust the backend to be the authority and let its error message through.

### API key env var

Rendered only when `flavorMeta.showApiKeyEnvVar` is true (all flavors except Ollama). Validated client-side as `/^[A-Z][A-Z0-9_]*$/` (SCREAMING_SNAKE_CASE) — same regex as `providerConfigSchema`.

A green check "set" or red X "missing" indicator renders next to the input based on `apiKeyPresent` on the provider row (see [`orchestration-providers.md`](./orchestration-providers.md) for the security model). The indicator re-renders on every PATCH response.

**Help copy (exact):** _"Name of the environment variable that holds your API key (e.g. `ANTHROPIC_API_KEY`). The UI never stores the key itself — just this name. The backend reads `process.env[…]` at request time."_

### Active

Shadcn `<Switch>`. Inactive providers stay in the list but are skipped when resolving agents.

## Advanced settings

A collapsible section below the Active toggle exposing two optional fields:

| Field        | Type   | Range         | Default | Help copy                                                                                                                   |
| ------------ | ------ | ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `timeoutMs`  | number | 1 000–300 000 | —       | "Maximum time in milliseconds to wait for a response from this provider. Leave empty to use the system default."            |
| `maxRetries` | number | 0–10          | —       | "Number of automatic retries on transient failures (network errors, 5xx responses). Leave empty to use the system default." |

Both fields are optional — when empty the backend falls back to its built-in defaults. The collapsible opens automatically if either field has a saved value.

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
};

if (isEdit) {
  // Edit: send null for empty/hidden fields so stale values are cleared in the DB.
  // The UPDATE schema accepts .nullable().optional() for these fields.
  payload.baseUrl = baseUrl ?? null;
  payload.apiKeyEnvVar = apiKeyEnvVar ?? null;
  payload.timeoutMs =
    typeof data.timeoutMs === 'number' && !Number.isNaN(data.timeoutMs) ? data.timeoutMs : null;
  payload.maxRetries =
    typeof data.maxRetries === 'number' && !Number.isNaN(data.maxRetries) ? data.maxRetries : null;

  const updated = await apiClient.patch(API.ADMIN.ORCHESTRATION.providerById(provider.id), {
    body: payload,
  });
  setApiKeyPresent(updated.apiKeyPresent ?? null);
  reset({ ...data, baseUrl: updated.baseUrl ?? '', apiKeyEnvVar: updated.apiKeyEnvVar ?? '' });
} else {
  // Create: only include fields when they have a value.
  // The CREATE schema uses .optional() without .nullable() — null would fail validation.
  if (baseUrl) payload.baseUrl = baseUrl;
  if (apiKeyEnvVar) payload.apiKeyEnvVar = apiKeyEnvVar;
  if (typeof data.timeoutMs === 'number' && !Number.isNaN(data.timeoutMs))
    payload.timeoutMs = data.timeoutMs;
  if (typeof data.maxRetries === 'number' && !Number.isNaN(data.maxRetries))
    payload.maxRetries = data.maxRetries;

  const created = await apiClient.post(API.ADMIN.ORCHESTRATION.PROVIDERS, { body: payload });
  router.push(`/admin/orchestration/providers/${created.id}`);
}
```

## Related

- [Providers list page](./orchestration-providers.md) — card grid, status dots, models dialog, key env var security model
- [Agent form](./agent-form.md) — the Model tab consumes the same `<ProviderTestButton>`
- [LLM providers (runtime)](../orchestration/llm-providers.md)
- [Admin API reference](../orchestration/admin-api.md)
