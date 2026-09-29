import type { SeedUnit } from '@/prisma/runner';

export const CAPABILITY_DEFINITIONS = [
  {
    slug: 'search_knowledge_base',
    name: 'Search Knowledge Base',
    // NOTE: keep this description in sync with the code constant in
    // lib/orchestration/capabilities/built-in/search-knowledge.ts. The runtime
    // tool definition the LLM sees is read from AiCapability.functionDefinition
    // (this seeded row), not the code constant — see registry.ts#getCapabilityDefinitions.
    description:
      'Semantic search over the knowledge base. Call this whenever the user’s message touches a topic the knowledge base may cover — prefer searching over answering from memory when you are not certain. Returns the top matching chunks ranked by cosine similarity (with optional BM25-flavoured keyword scoring in hybrid mode). Each result carries a numeric `marker` field — when you ground a claim in a result, cite it inline using that marker in square brackets, e.g. "the deposit must be protected within 30 days [1]". A separate citations panel renders the source for each marker, so the user can verify the claim.',
    category: 'knowledge',
    executionType: 'internal',
    executionHandler: 'SearchKnowledgeCapability',
    functionDefinition: {
      name: 'search_knowledge_base',
      description:
        'Semantic search over the knowledge base. Call this whenever the user’s message touches a topic the knowledge base may cover — prefer searching over answering from memory when you are not certain. Returns the top matching chunks ranked by cosine similarity (with optional BM25-flavoured keyword scoring in hybrid mode). Each result carries a numeric `marker` field — when you ground a claim in a result, cite it inline using that marker in square brackets, e.g. "the deposit must be protected within 30 days [1]". A separate citations panel renders the source for each marker, so the user can verify the claim.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language search query.',
            minLength: 1,
            maxLength: 500,
          },
          pattern_number: {
            type: 'integer',
            description: 'Optional filter to a single pattern number (1–999).',
            minimum: 1,
            maximum: 999,
          },
          document_id: {
            type: 'string',
            format: 'uuid',
            description:
              'Optional filter to search within a single uploaded document. Use when the user wants results scoped to a specific file they uploaded.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    slug: 'get_pattern_detail',
    name: 'Get Pattern Detail',
    description:
      'Return every chunk and metadata for a single agentic pattern, ordered by section for logical reading.',
    category: 'knowledge',
    executionType: 'internal',
    executionHandler: 'GetPatternDetailCapability',
    functionDefinition: {
      name: 'get_pattern_detail',
      description:
        'Return every chunk and metadata for a single agentic pattern, ordered by section for logical reading.',
      parameters: {
        type: 'object',
        properties: {
          pattern_number: {
            type: 'integer',
            description: 'The pattern number (1–999).',
            minimum: 1,
            maximum: 999,
          },
        },
        required: ['pattern_number'],
      },
    },
  },
  {
    slug: 'estimate_workflow_cost',
    name: 'Estimate Workflow Cost',
    description:
      'Rough planning-grade USD cost estimate for a multi-step workflow at the requested model tier.',
    category: 'cost',
    executionType: 'internal',
    executionHandler: 'EstimateCostCapability',
    functionDefinition: {
      name: 'estimate_workflow_cost',
      description:
        'Rough planning-grade USD cost estimate for a multi-step workflow at the requested model tier. Uses fixed per-step token assumptions (1500 in, 500 out) and the first registered model in the tier.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Natural-language description of the workflow (logged, not executed).',
            minLength: 1,
            maxLength: 2000,
          },
          estimated_steps: {
            type: 'integer',
            description: 'Approximate step count (1–1000).',
            minimum: 1,
            maximum: 1000,
          },
          model_tier: {
            type: 'string',
            enum: ['budget', 'mid', 'frontier'],
            description: 'Price tier used to pick a representative model.',
          },
        },
        required: ['description', 'estimated_steps', 'model_tier'],
      },
    },
  },
] as const;

/**
 * Seed the three built-in knowledge and cost capabilities the Pattern Advisor
 * uses: `search_knowledge_base`, `get_pattern_detail`,
 * `estimate_workflow_cost`.
 *
 * The agent itself is a platform agent now (§116 t-724): defined in
 * `lib/orchestration/agents/platform-agent-definitions/pattern-advisor.ts` and
 * materialised in every org by `021-platform-agents`, which also binds these.
 * The unit keeps its name so installs that ran it do not re-run it for
 * nothing.
 *
 * Idempotent — safe to run on every deploy.
 */
const unit: SeedUnit = {
  name: '005-pattern-advisor',
  async run({ prisma, logger }) {
    logger.info('🧰 Seeding knowledge and cost capabilities...');

    for (const def of CAPABILITY_DEFINITIONS) {
      await prisma.aiCapability.upsert({
        where: { slug: def.slug },
        // Re-apply the code-owned fields so an edited definition reaches rows
        // that already exist. Narrowed in #545: this used to re-apply `name`,
        // `description` and `category` too, which reverted an operator's
        // renames and re-wordings on every deploy. Those columns are admin-UI
        // presentation — what the LLM reads is inside `functionDefinition`,
        // which is still re-applied. See `.context/database/seeding.md`.
        update: {
          isSystem: true,
          executionType: def.executionType,
          executionHandler: def.executionHandler,
          functionDefinition: def.functionDefinition,
        },
        create: {
          name: def.name,
          slug: def.slug,
          description: def.description,
          category: def.category,
          functionDefinition: def.functionDefinition,
          executionType: def.executionType,
          executionHandler: def.executionHandler,
          isActive: true,
          isSystem: true,
        },
      });
    }

    logger.info(`✅ Seeded ${CAPABILITY_DEFINITIONS.length} capabilities`);
  },
};

export default unit;
