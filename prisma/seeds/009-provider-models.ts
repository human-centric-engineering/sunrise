import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';

/**
 * Seed the provider model matrix with per-model entries.
 *
 * Each row represents a single model (not a provider) with its specific
 * characteristics: tier role, reasoning, latency, cost, capabilities (chat/embedding),
 * and embedding-specific fields where applicable.
 *
 * Update strategy:
 *   - `isDefault: true` rows are seed-managed and updated on re-seed.
 *   - Admin-edited rows have `isDefault: false` and are never overwritten.
 *   - Admin-created rows (no matching slug) are unaffected.
 */
const unit: SeedUnit = {
  name: '009-provider-models',
  async run({ prisma, logger }) {
    logger.info('📊 Seeding provider model matrix...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }
    const createdBy = admin.id;

    // Pricing notes:
    //
    // `costPerMillionTokens` is a single value used by the cost tracker
    // for BOTH input and output tokens (see lib/orchestration/llm/db-model-adapter.ts).
    // Hosted chat models have asymmetric input/output rates — OpenAI's
    // GPT-5 is $1.25 in / $10 out, Anthropic's Opus 4 is $15 in / $75 out.
    // Until the schema gains separate input/output columns (tracked
    // follow-up: AiProviderModel.inputCostPerMillionTokens + outputCostPerMillionTokens),
    // we store an (input + output) / 2 blended rate. Cost figures
    // sourced from each vendor's public pricing page as of 2026-05.
    //
    // The in-memory model registry (lib/orchestration/llm/model-registry.ts)
    // carries separate input/output rates for the most common ids and
    // wins over the DB row on `getModel(id)` — so cost figures for
    // gpt-5, gpt-4o, Claude Opus 4 etc. stay precise. The seed rates
    // below are the safety net for rows not in the static fallback.
    const models = [
      // ========================================================================
      // Anthropic
      // ========================================================================
      {
        slug: 'anthropic-claude-opus-4',
        providerSlug: 'anthropic',
        modelId: 'claude-opus-4',
        name: 'Claude Opus 4',
        description:
          'Anthropic flagship. Deepest reasoning, extended thinking, very large context. Best for planning and complex orchestration.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'thinking',
        reasoningDepth: 'very_high',
        latency: 'medium',
        costEfficiency: 'medium',
        contextLength: 'very_high',
        toolUse: 'strong',
        bestRole: 'Planner / orchestrator',
        costPerMillionTokens: 45, // ($15 in + $75 out) / 2
      },
      {
        slug: 'anthropic-claude-sonnet-4',
        providerSlug: 'anthropic',
        modelId: 'claude-sonnet-4',
        name: 'Claude Sonnet 4',
        description:
          'Balanced reasoning and speed. Strong tool use with good cost efficiency for worker tasks.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'worker',
        reasoningDepth: 'high',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'very_high',
        toolUse: 'strong',
        bestRole: 'Versatile worker agent',
        costPerMillionTokens: 9, // ($3 in + $15 out) / 2
      },
      {
        slug: 'anthropic-claude-haiku-4-5',
        providerSlug: 'anthropic',
        modelId: 'claude-haiku-4.5',
        name: 'Claude Haiku 4.5',
        description:
          'Fast and cost-efficient. Good for high-volume, latency-sensitive agent loops.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'very_fast',
        costEfficiency: 'very_high',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'Fast tool execution',
        costPerMillionTokens: 3, // ($1 in + $5 out) / 2
      },

      // ========================================================================
      // OpenAI — Chat models
      // ========================================================================
      {
        slug: 'openai-gpt-5',
        providerSlug: 'openai',
        modelId: 'gpt-5',
        name: 'GPT-5',
        description:
          'OpenAI flagship. Very high reasoning, strong tool use. Best for planning and complex orchestration.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'thinking',
        reasoningDepth: 'very_high',
        latency: 'medium',
        costEfficiency: 'medium',
        contextLength: 'very_high',
        toolUse: 'strong',
        bestRole: 'Planner / orchestrator',
        // gpt-5 family rejects `max_tokens` and any non-default temperature
        // — the OpenAI-compatible provider switches to `max_completion_tokens`
        // and skips temperature when paramProfile is set to 'openai-reasoning'.
        paramProfile: 'openai-reasoning',
        costPerMillionTokens: 5.625, // ($1.25 in + $10 out) / 2
      },
      {
        slug: 'openai-gpt-4-1',
        providerSlug: 'openai',
        modelId: 'gpt-4.1',
        name: 'GPT-4.1',
        description:
          'Strong reasoning with improved instruction following. Good general-purpose worker.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'worker',
        reasoningDepth: 'high',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'General-purpose worker',
        costPerMillionTokens: 5, // ($2 in + $8 out) / 2
      },
      {
        slug: 'openai-gpt-4o',
        providerSlug: 'openai',
        modelId: 'gpt-4o',
        name: 'GPT-4o',
        description: 'Multimodal model with strong reasoning. Fast with good cost efficiency.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'worker',
        reasoningDepth: 'high',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'Multimodal worker',
        costPerMillionTokens: 6.25, // ($2.50 in + $10 out) / 2
      },
      {
        slug: 'openai-gpt-4o-mini',
        providerSlug: 'openai',
        modelId: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        description:
          'Fastest and cheapest OpenAI model. Ideal for high-volume, latency-sensitive loops.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'very_fast',
        costEfficiency: 'very_high',
        contextLength: 'high',
        toolUse: 'moderate',
        bestRole: 'High-throughput loops',
        costPerMillionTokens: 0.375, // ($0.15 in + $0.60 out) / 2
      },

      // OpenAI — Reasoning model
      {
        slug: 'openai-o3-mini',
        providerSlug: 'openai',
        modelId: 'o3-mini',
        name: 'o3-mini',
        description:
          'OpenAI reasoning model. Uses the /v1/responses API for explicit multi-step thinking; ideal for hard planning and verification tasks where chain-of-thought quality matters more than speed.',
        capabilities: ['reasoning'],
        tierRole: 'thinking',
        reasoningDepth: 'very_high',
        latency: 'medium',
        costEfficiency: 'medium',
        contextLength: 'very_high',
        toolUse: 'strong',
        bestRole: 'Hard reasoning, planning, verification',
        paramProfile: 'openai-reasoning',
        costPerMillionTokens: 2.75, // ($1.10 in + $4.40 out) / 2
      },

      // OpenAI — Audio (Whisper) — unlocks the streaming-chat mic input.
      // The audio capability is resolved at runtime by
      // lib/orchestration/llm/provider-manager.ts → getAudioProvider(),
      // which queries AiProviderModel for rows with capabilities ⊇ ['audio'].
      {
        slug: 'openai-whisper-1',
        providerSlug: 'openai',
        modelId: 'whisper-1',
        name: 'Whisper 1',
        description:
          'OpenAI speech-to-text. Resolved by getAudioProvider() when the operator clicks the mic in the streaming chat. No reasoning depth — Whisper is a transcription model, not an LLM.',
        capabilities: ['audio'],
        tierRole: 'infrastructure',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'Speech-to-text transcription',
      },

      // OpenAI — Embedding models
      {
        slug: 'openai-text-embedding-3-small',
        providerSlug: 'openai',
        modelId: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        description: 'Low cost, native 1536 dimensions. Good general-purpose embedding quality.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'very_high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'General-purpose embeddings',
        dimensions: 1536,
        schemaCompatible: true,
        costPerMillionTokens: 0.02,
        hasFreeTier: false,
        local: false,
        quality: 'medium',
        strengths: 'Low cost; native 1536 dimensions; good general-purpose quality',
        setup:
          'OpenAI API key → add as OpenAI-compatible provider with base URL https://api.openai.com/v1',
      },
      {
        slug: 'openai-text-embedding-3-large',
        providerSlug: 'openai',
        modelId: 'text-embedding-3-large',
        name: 'text-embedding-3-large',
        description: 'Highest quality OpenAI embedding. Supports dimension reduction to 1536.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'High-quality embeddings',
        dimensions: 3072,
        schemaCompatible: true,
        costPerMillionTokens: 0.13,
        hasFreeTier: false,
        local: false,
        quality: 'high',
        strengths: 'Highest quality OpenAI embedding; supports dimension reduction to 1536',
        setup:
          'OpenAI API key → add as OpenAI-compatible provider with base URL https://api.openai.com/v1',
      },

      // ========================================================================
      // Voyage AI — Embedding specialist
      // ========================================================================
      {
        slug: 'voyage-voyage-3',
        providerSlug: 'voyage',
        modelId: 'voyage-3',
        name: 'Voyage 3',
        description:
          'Top-tier retrieval quality from ex-Anthropic researchers. Free 200M tokens/month tier.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'Premium embeddings',
        dimensions: 1024,
        schemaCompatible: true,
        costPerMillionTokens: 0.06,
        hasFreeTier: true,
        local: false,
        quality: 'high',
        strengths:
          'Top-tier retrieval quality; built by ex-Anthropic researchers; free 200M tokens/month',
        setup: 'Sign up at voyageai.com → copy API key → add as Voyage AI provider',
      },

      // ========================================================================
      // Google
      // ========================================================================
      {
        slug: 'google-gemini-2-5-pro',
        providerSlug: 'google',
        modelId: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        description:
          'Google flagship. Very high reasoning with thinking mode, very large context and strong multimodal capabilities.',
        capabilities: ['chat', 'vision'],
        tierRole: 'thinking',
        reasoningDepth: 'very_high',
        latency: 'medium',
        costEfficiency: 'medium',
        contextLength: 'very_high',
        toolUse: 'strong',
        bestRole: 'Retrieval + multimodal',
        costPerMillionTokens: 3.125, // ($1.25 in + $5 out) / 2
      },
      {
        slug: 'google-gemini-2-5-flash',
        providerSlug: 'google',
        modelId: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        description:
          'Fast, cost-efficient Gemini variant. Good for high-throughput multimodal tasks.',
        capabilities: ['chat', 'vision'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'very_fast',
        costEfficiency: 'very_high',
        contextLength: 'very_high',
        toolUse: 'moderate',
        bestRole: 'Fast multimodal agent',
        costPerMillionTokens: 1.4, // ($0.30 in + $2.50 out) / 2
      },
      {
        slug: 'google-text-embedding-004',
        providerSlug: 'google',
        modelId: 'text-embedding-004',
        name: 'text-embedding-004',
        description: 'Very low cost embedding model with generous free tier. Good for prototyping.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'very_high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'Budget embeddings',
        dimensions: 768,
        schemaCompatible: false,
        costPerMillionTokens: 0.00625,
        hasFreeTier: true,
        local: false,
        quality: 'medium',
        strengths: 'Very low cost; generous free tier; good for prototyping',
        setup: 'Google AI API key → not directly compatible (768-dim, requires schema change)',
      },

      // ========================================================================
      // xAI
      // ========================================================================
      {
        slug: 'xai-grok-3',
        providerSlug: 'xai',
        modelId: 'grok-3',
        name: 'Grok 3',
        description:
          'xAI flagship with real-time context awareness and strong reasoning capabilities.',
        capabilities: ['chat', 'vision'],
        tierRole: 'worker',
        reasoningDepth: 'high',
        latency: 'medium',
        costEfficiency: 'medium',
        contextLength: 'high',
        toolUse: 'moderate',
        bestRole: 'Real-time context agents',
        costPerMillionTokens: 9, // ($3 in + $15 out) / 2
      },
      {
        slug: 'xai-grok-3-mini',
        providerSlug: 'xai',
        modelId: 'grok-3-mini',
        name: 'Grok 3 Mini',
        description: 'Lightweight Grok variant. Fast and affordable for worker tasks.',
        capabilities: ['chat'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'medium',
        toolUse: 'moderate',
        bestRole: 'Fast worker loops',
        costPerMillionTokens: 0.4, // ($0.30 in + $0.50 out) / 2
      },

      // ========================================================================
      // Mistral — Chat + Embedding
      // ========================================================================
      {
        slug: 'mistral-mistral-large',
        providerSlug: 'mistral',
        modelId: 'mistral-large-latest',
        name: 'Mistral Large',
        description: 'Mistral flagship. Strong reasoning with good European-language support.',
        capabilities: ['chat'],
        tierRole: 'worker',
        reasoningDepth: 'high',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'Multilingual worker',
        costPerMillionTokens: 4, // ($2 in + $6 out) / 2
      },
      {
        slug: 'mistral-mistral-small',
        providerSlug: 'mistral',
        modelId: 'mistral-small-latest',
        name: 'Mistral Small',
        description: 'Fast and cost-efficient. Good for high-volume worker tasks.',
        capabilities: ['chat'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'very_fast',
        costEfficiency: 'very_high',
        contextLength: 'medium',
        toolUse: 'moderate',
        bestRole: 'Cost-efficient loops',
        costPerMillionTokens: 0.4, // ($0.20 in + $0.60 out) / 2
      },
      {
        slug: 'mistral-mistral-embed',
        providerSlug: 'mistral',
        modelId: 'mistral-embed',
        name: 'Mistral Embed',
        description: 'Good European-language embedding support with OpenAI-compatible API.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'Multilingual embeddings',
        dimensions: 1024,
        schemaCompatible: false,
        costPerMillionTokens: 0.1,
        hasFreeTier: false,
        local: false,
        quality: 'medium',
        strengths: 'Good European-language support; OpenAI-compatible API',
        setup:
          'Mistral API key → add as OpenAI-compatible provider with base URL https://api.mistral.ai/v1',
      },

      // ========================================================================
      // Cohere — Chat + Embedding
      // ========================================================================
      {
        slug: 'cohere-command-r-plus',
        providerSlug: 'cohere',
        modelId: 'command-r-plus',
        name: 'Command R+',
        description: 'Cohere flagship. Strong tool use designed for enterprise RAG workflows.',
        capabilities: ['chat'],
        tierRole: 'worker',
        reasoningDepth: 'high',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'Enterprise RAG workflows',
        costPerMillionTokens: 6.25, // ($2.50 in + $10 out) / 2
      },
      {
        slug: 'cohere-embed-english-v3',
        providerSlug: 'cohere',
        modelId: 'embed-english-v3.0',
        name: 'Embed English v3',
        description: 'Excellent English retrieval with search/classification input types.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'English embeddings',
        dimensions: 1024,
        schemaCompatible: false,
        costPerMillionTokens: 0.1,
        hasFreeTier: true,
        local: false,
        quality: 'high',
        strengths:
          'Excellent English retrieval; search/classification input types; free trial tier',
        setup: 'Cohere API key → add as OpenAI-compatible provider (requires adapter)',
      },
      {
        slug: 'cohere-embed-multilingual-v3',
        providerSlug: 'cohere',
        modelId: 'embed-multilingual-v3.0',
        name: 'Embed Multilingual v3',
        description: 'Best-in-class multilingual embedding support covering 100+ languages.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'Multilingual embeddings',
        dimensions: 1024,
        schemaCompatible: false,
        costPerMillionTokens: 0.1,
        hasFreeTier: true,
        local: false,
        quality: 'high',
        strengths: 'Best-in-class multilingual support; 100+ languages',
        setup: 'Cohere API key → add as OpenAI-compatible provider (requires adapter)',
      },

      // ========================================================================
      // DeepSeek
      // ========================================================================
      {
        slug: 'deepseek-deepseek-chat',
        providerSlug: 'deepseek',
        modelId: 'deepseek-chat',
        name: 'DeepSeek Chat',
        description: 'High reasoning at very low cost. Ideal for cheap parallel reasoning workers.',
        capabilities: ['chat'],
        tierRole: 'worker',
        reasoningDepth: 'high',
        latency: 'fast',
        costEfficiency: 'very_high',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'Cheap reasoning worker',
        costPerMillionTokens: 0.21, // ($0.14 in + $0.28 out) / 2
      },
      {
        slug: 'deepseek-deepseek-coder',
        providerSlug: 'deepseek',
        modelId: 'deepseek-coder',
        name: 'DeepSeek Coder',
        description:
          'Code-specialised model. Very cost-efficient for code generation and analysis tasks.',
        capabilities: ['chat'],
        tierRole: 'worker',
        reasoningDepth: 'high',
        latency: 'fast',
        costEfficiency: 'very_high',
        contextLength: 'medium',
        toolUse: 'strong',
        bestRole: 'Code generation worker',
        costPerMillionTokens: 0.21, // ($0.14 in + $0.28 out) / 2
      },

      // ========================================================================
      // Perplexity AI
      // ========================================================================
      {
        slug: 'perplexity-sonar-pro',
        providerSlug: 'perplexity',
        modelId: 'sonar-pro',
        name: 'Sonar Pro',
        description: 'Search-grounded model with built-in real-time information retrieval.',
        capabilities: ['chat'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'fast',
        costEfficiency: 'medium',
        contextLength: 'medium',
        toolUse: 'strong',
        bestRole: 'Search-grounded agents',
        costPerMillionTokens: 9, // ($3 in + $15 out) / 2
      },

      // ========================================================================
      // Groq — Hosted inference
      // ========================================================================
      {
        slug: 'groq-llama-3-3-70b',
        providerSlug: 'groq',
        modelId: 'llama-3.3-70b-versatile',
        name: 'Llama 3.3 70B (Groq)',
        description:
          'Llama 3.3 on Groq LPU hardware. Very fast inference for latency-sensitive loops.',
        capabilities: ['chat'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'very_fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'moderate',
        bestRole: 'Low-latency execution',
        costPerMillionTokens: 0.69, // ($0.59 in + $0.79 out) / 2
      },
      {
        slug: 'groq-mixtral-8x7b',
        providerSlug: 'groq',
        modelId: 'mixtral-8x7b-32768',
        name: 'Mixtral 8x7B (Groq)',
        description:
          'Mixtral on Groq hardware. Cost-efficient with 32K context for fast parallel tasks.',
        capabilities: ['chat'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'very_fast',
        costEfficiency: 'very_high',
        contextLength: 'medium',
        toolUse: 'moderate',
        bestRole: 'Budget fast loops',
        costPerMillionTokens: 0.27, // Groq flat rate
      },

      // ========================================================================
      // Together AI
      // ========================================================================
      {
        slug: 'together-llama-3-3-70b',
        providerSlug: 'together',
        modelId: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        name: 'Llama 3.3 70B (Together)',
        description: 'Llama 3.3 hosted on Together AI. Fast inference with good cost efficiency.',
        capabilities: ['chat'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'moderate',
        bestRole: 'Scalable worker pool',
        costPerMillionTokens: 0.88, // Together flat rate
      },

      // ========================================================================
      // Fireworks AI
      // ========================================================================
      {
        slug: 'fireworks-llama-3-3-70b',
        providerSlug: 'fireworks',
        modelId: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
        name: 'Llama 3.3 70B (Fireworks)',
        description:
          'Llama 3.3 on Fireworks infrastructure. Optimised for high-throughput agent workloads.',
        capabilities: ['chat'],
        tierRole: 'infrastructure',
        reasoningDepth: 'medium',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'moderate',
        bestRole: 'High-throughput agents',
        costPerMillionTokens: 0.9, // Fireworks flat rate
      },

      // ========================================================================
      // Amazon Bedrock
      // ========================================================================
      {
        slug: 'amazon-bedrock-claude',
        providerSlug: 'amazon',
        modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
        name: 'Claude Sonnet 4 (Bedrock)',
        description:
          'Claude Sonnet 4 through AWS Bedrock. Enterprise-grade with compliance and data residency.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'control_plane',
        reasoningDepth: 'high',
        latency: 'medium',
        costEfficiency: 'medium',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'Enterprise orchestration',
        costPerMillionTokens: 9, // Bedrock Claude Sonnet 4: ($3 in + $15 out) / 2
      },

      // ========================================================================
      // Microsoft Azure
      // ========================================================================
      {
        slug: 'microsoft-azure-gpt-4o',
        providerSlug: 'microsoft',
        modelId: 'gpt-4o',
        name: 'GPT-4o (Azure)',
        description:
          'GPT-4o via Azure OpenAI Service. Enterprise layer with compliance, private networking.',
        capabilities: ['chat', 'vision', 'documents'],
        tierRole: 'control_plane',
        reasoningDepth: 'high',
        latency: 'medium',
        costEfficiency: 'medium',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'Enterprise GPT layer',
        costPerMillionTokens: 6.25, // Azure GPT-4o: ($2.50 in + $10 out) / 2
      },

      // ========================================================================
      // OpenRouter — Aggregated routing
      // ========================================================================
      {
        slug: 'openrouter-auto',
        providerSlug: 'openrouter',
        modelId: 'openrouter/auto',
        name: 'OpenRouter Auto',
        description:
          'Automatic model selection and routing. Optimised cost with automatic fallback across providers.',
        // documents capability is best-effort here: OpenRouter routes
        // requests through whichever upstream model it picks, and not
        // every upstream accepts the `file` content part shape that
        // OpenAI's Chat Completions defines. If the chosen route lacks
        // PDF support the call will surface a provider error rather
        // than silently dropping the attachment. Operators who want
        // guaranteed PDF support should target a specific Claude or
        // GPT-4o row instead.
        capabilities: ['chat', 'documents'],
        tierRole: 'control_plane',
        reasoningDepth: 'medium',
        latency: 'medium',
        costEfficiency: 'high',
        contextLength: 'medium',
        toolUse: 'strong',
        bestRole: 'Routing / fallback layer',
        // OpenRouter auto routes across many upstreams; the blended
        // average lands around the cheaper-tier worker / mid models.
        costPerMillionTokens: 2,
      },

      // ========================================================================
      // Meta — Local / Sovereign
      // ========================================================================
      {
        slug: 'meta-llama-3-3-70b',
        providerSlug: 'meta',
        modelId: 'llama-3.3-70b',
        name: 'Llama 3.3 70B',
        description:
          'Open-weight model for local/private deployment. No data leaves your infrastructure.',
        capabilities: ['chat'],
        tierRole: 'worker',
        deploymentProfiles: ['sovereign'],
        reasoningDepth: 'medium',
        latency: 'medium',
        costEfficiency: 'very_high',
        contextLength: 'high',
        toolUse: 'moderate',
        bestRole: 'Local/private agents',
        local: true,
        // Self-hosted open-weight; no per-token cost. Operators tracking
        // GPU spend should compute their own rate and edit in admin UI.
        costPerMillionTokens: 0,
      },
      {
        slug: 'meta-llama-3-2-8b',
        providerSlug: 'meta',
        modelId: 'llama-3.2-8b',
        name: 'Llama 3.2 8B',
        description: 'Lightweight open-weight model. Fast local inference for simple tasks.',
        capabilities: ['chat'],
        tierRole: 'worker',
        deploymentProfiles: ['sovereign'],
        reasoningDepth: 'medium',
        latency: 'fast',
        costEfficiency: 'very_high',
        contextLength: 'medium',
        toolUse: 'moderate',
        bestRole: 'Lightweight local agent',
        local: true,
        costPerMillionTokens: 0, // self-hosted open-weight
      },

      // ========================================================================
      // Alibaba — Sovereign-deployable thinking-tier model
      // ========================================================================
      {
        slug: 'alibaba-qwen-2-5-72b',
        providerSlug: 'alibaba',
        modelId: 'qwen2.5-72b-instruct',
        name: 'Qwen 2.5 72B',
        description:
          'Strong multilingual model with competitive performance. Good for sovereign deployment.',
        capabilities: ['chat'],
        tierRole: 'thinking',
        deploymentProfiles: ['sovereign'],
        reasoningDepth: 'high',
        latency: 'fast',
        costEfficiency: 'high',
        contextLength: 'high',
        toolUse: 'strong',
        bestRole: 'Multilingual agents',
        // Alibaba's hosted Qwen pricing is regional; this is a rough
        // blended average. Self-hosted deployments should override.
        costPerMillionTokens: 0.7,
      },

      // ========================================================================
      // Ollama — Local embedding models
      // ========================================================================
      {
        slug: 'ollama-nomic-embed-text',
        providerSlug: 'ollama',
        modelId: 'nomic-embed-text',
        name: 'nomic-embed-text',
        description:
          'Free local embedding model. No data leaves your machine, good quality for size.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'very_high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'Local embeddings',
        dimensions: 768,
        schemaCompatible: false,
        costPerMillionTokens: 0,
        hasFreeTier: true,
        local: true,
        quality: 'medium',
        strengths: 'Free; runs locally; no data leaves your machine; good quality for size',
        setup:
          'Install Ollama → ollama pull nomic-embed-text → add as local OpenAI-compatible provider',
      },
      {
        slug: 'ollama-mxbai-embed-large',
        providerSlug: 'ollama',
        modelId: 'mxbai-embed-large',
        name: 'mxbai-embed-large',
        description:
          'Free local embedding model with larger context window and strong retrieval benchmarks.',
        capabilities: ['embedding'],
        tierRole: 'embedding',
        reasoningDepth: 'none',
        latency: 'fast',
        costEfficiency: 'very_high',
        contextLength: 'n_a',
        toolUse: 'none',
        bestRole: 'Local high-quality embeddings',
        dimensions: 1024,
        schemaCompatible: false,
        costPerMillionTokens: 0,
        hasFreeTier: true,
        local: true,
        quality: 'medium',
        strengths: 'Free; local; larger context window than nomic; strong retrieval benchmarks',
        setup:
          'Install Ollama → ollama pull mxbai-embed-large → add as local OpenAI-compatible provider',
      },
    ];

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const model of models) {
      // Check if an existing row has been customised by an admin
      const existing = await prisma.aiProviderModel.findUnique({
        where: { slug: model.slug },
        select: { isDefault: true },
      });

      if (existing && !existing.isDefault) {
        // Admin has customised this model — do not overwrite
        skipped++;
        continue;
      }

      const data = {
        providerSlug: model.providerSlug,
        modelId: model.modelId,
        name: model.name,
        description: model.description,
        capabilities: model.capabilities,
        tierRole: model.tierRole,
        // Default to ['hosted'] for any row that doesn't declare its
        // deployment profile explicitly. Sovereign rows are the explicit
        // exception (see Llama 3, Qwen 2.5 above).
        deploymentProfiles: model.deploymentProfiles ?? ['hosted'],
        reasoningDepth: model.reasoningDepth,
        latency: model.latency,
        costEfficiency: model.costEfficiency,
        contextLength: model.contextLength,
        toolUse: model.toolUse,
        // Wire-level parameter convention. When unset, the runtime falls
        // back to `deriveParamProfile()` — safe default that correctly
        // classifies most ids. Set explicitly on rows where the wire
        // shape differs in a way the heuristic can't infer (e.g. gpt-5,
        // o-series — both reject `max_tokens`).
        paramProfile: model.paramProfile ?? null,
        bestRole: model.bestRole,
        dimensions: model.dimensions ?? null,
        schemaCompatible: model.schemaCompatible ?? null,
        costPerMillionTokens: model.costPerMillionTokens ?? null,
        hasFreeTier: model.hasFreeTier ?? null,
        local: model.local ?? false,
        quality: model.quality ?? null,
        strengths: model.strengths ?? null,
        setup: model.setup ?? null,
      };

      await prisma.aiProviderModel.upsert({
        where: { slug: model.slug },
        update: {
          ...data,
          isDefault: true,
        },
        create: {
          slug: model.slug,
          ...data,
          isDefault: true,
          createdBy,
        },
      });

      if (existing) {
        updated++;
      } else {
        created++;
      }
    }

    logger.info(
      `✅ Provider models: ${created} created, ${updated} updated, ${skipped} skipped (admin-customised)`
    );
  },
};

export default unit;
