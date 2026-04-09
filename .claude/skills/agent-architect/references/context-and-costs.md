# Context Engineering & Token Costs

## Context Engineering

Context engineering is the discipline of strategically selecting, packaging, and managing all information that goes into each LLM call. It is the single biggest lever for both quality and cost in agentic systems.

### Why It Matters

In agentic systems, context accumulates with every step. Each tool call, each agent response, each retrieved document adds tokens. The typical agentic input-to-output ratio is 100:1 — the agent reads far more than it writes. Since input tokens make up 70–85% of your bill and directly determine output quality, context engineering is simultaneously your biggest cost lever and your biggest quality lever.

### Core Principles

**Send only what the model needs.** The goal is the smallest possible set of high-signal tokens that maximise the desired outcome. A support agent retrieving 3 targeted FAQ entries produces better answers at lower cost than one dumping 50 entries into context.

**Keep your prompt prefix stable.** LLM providers cache processed prompt representations (KV-cache). If the prefix is identical across calls, cached tokens are reused at up to 10× lower cost (e.g., $0.30/M vs $3/M on Claude Sonnet). Changing even a single token in the prefix invalidates the cache for everything after it. Structure prompts: stable instructions first, variable content last.

**Manage context rot.** As the context window fills, accuracy degrades — especially for information in the middle. Strategies: summarise older conversation turns, place critical information at start and end (not middle), prune irrelevant tool results before they accumulate.

**Engineer for the 100:1 ratio.** Every step re-sends the full accumulated context. By step 10, you're paying for the same system prompt for the 10th time. Sub-agent architectures (search in a separate context, return only results) dramatically reduce this accumulation.

### Context Engineering vs Prompt Engineering

Prompt engineering: crafting the right words for a single LLM call.
Context engineering: managing the entire information lifecycle across multi-step agentic workflows — what to include, summarise, discard, and how to structure for each step. Prompt engineering is a subset.

---

## Token Cost Reference (April 2026)

Pricing changes frequently. Use the sources below for current rates.

### Pricing Sources

- **OpenRouter Models API** (`GET https://openrouter.ai/api/v1/models`) — real-time pricing for 300+ models in JSON. No API key required. Best programmatic source for cost-aware agents.
- **Official provider pages:** Anthropic (anthropic.com/pricing), OpenAI (openai.com/api/pricing), Google (ai.google.dev/pricing)
- **Comparison tools:** pricepertoken.com, costgoat.com/compare/llm-api

### Pricing Tiers (per 1M tokens, USD, April 2026)

| Tier     | Example Models                       | Input       | Output     | Use for                                    |
| -------- | ------------------------------------ | ----------- | ---------- | ------------------------------------------ |
| Budget   | Gemini Flash, GPT-4o Mini, Haiku 4.5 | $0.10–1.00  | $0.40–5.00 | Routing, classification, summarisation     |
| Mid-tier | Claude Sonnet 4.6, GPT-5.2           | $1.75–3.00  | $14–15.00  | Complex reasoning, code generation, drafts |
| Frontier | Claude Opus 4.6, GPT-5.4 Pro         | $5.00–30.00 | $15–180.00 | Critical reasoning, research, high-stakes  |

### Cost Estimation Formula

```
Cost per request = (input_tokens × input_price) + (output_tokens × output_price)

input_tokens  = system prompt + conversation history + retrieved context + tool results
output_tokens = model's generated response (3–10× more expensive than input)
prices        = per-token rate (divide per-1M price by 1,000,000)

Monthly cost  = cost_per_request × requests_per_day × 30
```

### Pattern-Specific Multipliers

- **Prompt Chaining:** Multiply by number of chain steps
- **Reflection:** Multiply by critique-revise cycles (typically 2–3×)
- **Parallelisation:** Multiply by number of parallel branches
- **Multi-agent:** Multiply by rounds × agents (context grows each round)
- **RAG:** Add retrieved chunk tokens to input (typically 2,000–10,000 per retrieval)

### Cost Reduction Levers

| Lever               | Savings            | How                                                       |
| ------------------- | ------------------ | --------------------------------------------------------- |
| Prompt caching      | Up to 90% on input | Keep system prompt prefix stable for KV-cache hits        |
| Batch API           | 50% off            | Use for async/non-realtime workloads                      |
| Tiered routing      | 60–80% avg         | Budget model for 70% of queries, frontier for 10%         |
| Context compression | 40–60% input       | Summarise, prune, send only relevant content              |
| Output limits       | 20–30% output      | Set max_tokens, request structured output (JSON vs prose) |

### Budget Planning

A realistic total budget is approximately 1.7× the base token calculation: add 25% for usage growth, 30% for infrastructure overhead (orchestration, monitoring), and 15% for experimentation with new models and prompt optimisation.
