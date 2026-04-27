# Provider Selection Matrix

DB-managed registry of LLM provider **models** with tier classification, capability ratings, and a decision heuristic for assigning models to agent roles. Each row represents a single model (e.g. "Claude Opus 4", "GPT-4o-mini", "Voyage 3") rather than a provider.

## Quick Start

```typescript
import { recommendModels } from '@/lib/orchestration/llm';

// "What model should I use for a reasoning-heavy agent?"
const recs = await recommendModels('thinking', { limit: 3 });
// → [{ slug: 'anthropic-claude-opus-4', providerSlug: 'anthropic', score: 90, reason: '...' }, ...]

// Embedding model recommendations
const embedRecs = await recommendModels('embedding', { limit: 3 });
```

## Architecture

**`AiProviderModel`** (Prisma model) stores per-model characteristics. Separate from `AiProviderConfig` (which stores operational config: API keys, base URLs).

Relationship: soft link via `providerSlug` matching `AiProviderConfig.slug`. A model entry can exist without a config (landscape entry), and a config can exist without model entries (custom/private provider).

### Data Flow

```
Seed (~36 defaults) → AiProviderModel table → provider-selector.ts → API endpoints → Admin UI
                            ↑
                     Admin CRUD (UI/API)
```

### Update Strategy

- **Seed-managed** (`isDefault: true`): ~36 default model entries populated by `009-provider-models.ts`. Re-seeding updates these rows.
- **Admin-managed** (`isDefault: false`): Once an admin edits a seed model, `isDefault` flips to `false` and future seeds skip it. Admin-created models are always `isDefault: false`.

## 6-Tier Classification

| Tier | Role                | Use When                                                             | Example Models                                  |
| ---- | ------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| 1    | **Thinking**        | Complex planning, multi-step reasoning, decomposition                | Claude Opus 4, GPT-5, Gemini 2.5 Pro            |
| 2    | **Worker**          | Tool execution, summarisation, transformations, cheap parallel tasks | Claude Sonnet 4, GPT-4.1, DeepSeek Chat, Grok 3 |
| 3    | **Infrastructure**  | Scaling, latency-sensitive loops, high-throughput                    | Claude Haiku 4.5, GPT-4o-mini, Groq Llama 3.3   |
| 4    | **Control Plane**   | Fallback logic, A/B testing, cost routing, enterprise compliance     | OpenRouter Auto, Bedrock Claude, Azure GPT-4o   |
| 5    | **Local/Sovereign** | Privacy-sensitive workloads, offline capability, data residency      | Llama 3.3 70B (Ollama), Qwen 2.5 72B            |
| E    | **Embedding**       | Vector embeddings for knowledge base and semantic search             | text-embedding-3-small, Voyage 3, Mistral Embed |

## Decision Heuristic

When assigning a model in an agent system:

| Condition                         | Recommendation                 |
| --------------------------------- | ------------------------------ |
| If it **thinks**                  | Use frontier models (Tier 1)   |
| If it **does**                    | Use cheap/open models (Tier 2) |
| If it **loops fast**              | Use infra providers (Tier 3)   |
| If it **must not fail**           | Route via aggregators (Tier 4) |
| If it **must stay private**       | Run local (Tier 5)             |
| If it **needs vector embeddings** | Use embedding models (Tier E)  |

### Programmatic API

```typescript
type TaskIntent = 'thinking' | 'doing' | 'fast_looping' | 'high_reliability' | 'private' | 'embedding';

const recs = await recommendModels(intent, { limit?: number; includeInactive?: boolean });
// Returns ModelRecommendation[] sorted by score (0-90 chat, 0-96 embedding)
```

Scoring for chat intents: primary factor is `tierRole` match (60 points), secondary tiebreaker from the relevant dimension (up to 30 points). Non-matching tiers score 0 + secondary only.

Scoring for embedding intent: `schemaCompatible` (40pts), `costEfficiency` (21pts), `quality` (20pts), `hasFreeTier` (10pts), `local` preference (5pts).

## Model Dimensions

| Dimension              | Values                                                                      | Purpose                                  |
| ---------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `tierRole`             | thinking, worker, infrastructure, control_plane, local_sovereign, embedding | Primary classification                   |
| `capabilities`         | `['chat']`, `['embedding']`, `['chat', 'embedding']`                        | What the model can do                    |
| `providerSlug`         | String                                                                      | Groups models by provider                |
| `modelId`              | String                                                                      | API model identifier                     |
| `reasoningDepth`       | very_high, high, medium, none                                               | Complexity of reasoning tasks it handles |
| `latency`              | very_fast, fast, medium                                                     | Response speed characteristics           |
| `costEfficiency`       | very_high, high, medium, none                                               | Cost per token/request                   |
| `contextLength`        | very_high, high, medium, n_a                                                | Maximum context window                   |
| `toolUse`              | strong, moderate, none                                                      | Function/tool calling capability         |
| `bestRole`             | Free text                                                                   | Recommended role in agent architectures  |
| `dimensions`           | Integer (nullable)                                                          | Embedding vector dimensions              |
| `schemaCompatible`     | Boolean (nullable)                                                          | Compatible with pgvector(1536) schema    |
| `costPerMillionTokens` | Float (nullable)                                                            | Embedding cost per 1M tokens             |
| `hasFreeTier`          | Boolean (nullable)                                                          | Whether a free tier is available         |
| `local`                | Boolean                                                                     | Runs locally (Ollama, etc.)              |
| `quality`              | high, medium, budget (nullable)                                             | Embedding quality tier                   |

## API Endpoints

### CRUD

| Method | Path                                              | Purpose                                                                                 |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| GET    | `/api/v1/admin/orchestration/provider-models`     | Paginated list with filters (`tierRole`, `capability`, `providerSlug`, `isActive`, `q`) |
| POST   | `/api/v1/admin/orchestration/provider-models`     | Create (sets `isDefault: false`)                                                        |
| GET    | `/api/v1/admin/orchestration/provider-models/:id` | Single model with `configured` status                                                   |
| PATCH  | `/api/v1/admin/orchestration/provider-models/:id` | Update (flips `isDefault` to `false` on edit)                                           |
| DELETE | `/api/v1/admin/orchestration/provider-models/:id` | Soft delete (`isActive = false`)                                                        |

**Soft delete behaviour:** DELETE sets `isActive = false` (no `deletedAt` column). Inactive models are excluded from the matrix and `recommendModels()` by default. Agents that explicitly reference a deactivated model still resolve at runtime — the model is hidden from selection UI but not blocked from use.

### Recommendations

| Method | Path                                                                    | Purpose                |
| ------ | ----------------------------------------------------------------------- | ---------------------- |
| GET    | `/api/v1/admin/orchestration/provider-models/recommend?intent=thinking` | Scored recommendations |

Query params: `intent` (required), `limit` (optional, default 5).

Response includes `recommendations[]` and a `heuristic` object with human-readable rules.

## Admin UI

- **Flat table** (`/admin/orchestration/provider-models`): Filterable by provider, tier, capability (Chat/Embedding/All). Sortable columns with capability badges and configured-status dots.
- **Create** (`/admin/orchestration/provider-models/new`): Form with provider slug, model ID, capabilities checkboxes, tier selector, conditional embedding fields.
- **Edit** (`/admin/orchestration/provider-models/:id`): Pre-filled form, warns about `isDefault` flip.

## Embedding Model Integration

Embedding models are stored in the same `AiProviderModel` table with `capabilities: ['embedding']` and `tierRole: 'embedding'`. The Knowledge Base "Compare Embedding Providers" modal fetches from the DB via `getEmbeddingModels()`, which falls back to a static array if the DB is unavailable.

The `embedding-models/` API endpoint queries `AiProviderModel` where `capabilities` includes `'embedding'`, mapping rows to the `EmbeddingModelInfo` shape for backward compatibility.

## Caching

`provider-selector.ts` caches all models in memory with a 60-second TTL (same pattern as `settings-resolver.ts`). Cache is invalidated by `invalidateModelCache()`, called from POST/PATCH/DELETE routes.

## Testing

```bash
# Unit tests (scoring algorithm, caching)
npx vitest run tests/unit/lib/orchestration/llm/provider-selector

# Integration tests (API endpoints, auth, validation)
npx vitest run tests/integration/api/v1/admin/orchestration/provider-models
```

## Related

- [LLM providers (runtime)](./llm-providers.md) — provider abstraction, model registry, cost tracking
- [Provider management pages](../admin/orchestration-providers.md) — operational config UI
- [Admin API reference](./admin-api.md) — full endpoint catalogue
