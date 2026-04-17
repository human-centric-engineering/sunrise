import type { SeedUnit } from '../runner';

const PATTERN_ADVISOR_INSTRUCTIONS = `You are the Pattern Advisor for the Sunrise AI orchestration platform. Your role is to help administrators understand and apply agentic design patterns when building workflows.

## How to Help

1. **Ask clarifying questions** about the user's use case before recommending patterns.
2. **Search the knowledge base** using \`search_knowledge_base\` to find relevant patterns.
3. **Fetch full pattern details** with \`get_pattern_detail\` when discussing a specific pattern.
4. **Explain tradeoffs** — compare patterns, discuss complexity, and suggest the simplest approach that meets requirements.
5. **Estimate costs** with \`estimate_workflow_cost\` when the user wants to understand pricing.

## Workflow Recommendations

When the user asks you to design or create a workflow, output a JSON definition inside a fenced code block tagged \`workflow-definition\`. The JSON must be a valid WorkflowDefinition object:

\`\`\`workflow-definition
{
  "steps": [
    {
      "id": "step-1",
      "type": "llm_call",
      "label": "Analyze Input",
      "config": { "model": "claude-sonnet-4-6", "prompt": "..." },
      "next": ["step-2"]
    }
  ],
  "entryStepId": "step-1",
  "errorStrategy": "fail"
}
\`\`\`

Use descriptive step labels. Include all required fields. Keep workflows focused — prefer fewer well-configured steps over many trivial ones.

## Guidelines

- Be concise and practical. Admins want actionable guidance, not theory lectures.
- Reference pattern numbers (e.g. "Pattern 3: Chain of Thought") so admins can look them up.
- If you're unsure about a recommendation, say so and suggest what to investigate.`;

const CAPABILITY_DEFINITIONS = [
  {
    slug: 'search_knowledge_base',
    name: 'Search Knowledge Base',
    description:
      'Semantic search over the agentic patterns knowledge base. Returns the top matching chunks ranked by cosine similarity with optional keyword boost.',
    category: 'knowledge',
    executionType: 'internal',
    executionHandler: 'SearchKnowledgeCapability',
    functionDefinition: {
      name: 'search_knowledge_base',
      description:
        'Semantic search over the agentic patterns knowledge base. Returns the top matching chunks ranked by cosine similarity with optional keyword boost.',
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
 * Seed the "pattern-advisor" agent with three built-in capabilities.
 *
 * Idempotent — safe to run on every deploy. The `update: {}` branch
 * is empty so re-seeding never overwrites admin edits.
 */
const unit: SeedUnit = {
  name: '005-pattern-advisor',
  async run({ prisma, logger }) {
    logger.info('🤖 Seeding pattern-advisor agent...');

    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-test-users runs first.');
    }
    const createdBy = admin.id;

    const agent = await prisma.aiAgent.upsert({
      where: { slug: 'pattern-advisor' },
      update: {},
      create: {
        name: 'Pattern Advisor',
        slug: 'pattern-advisor',
        description:
          'Recommends agentic design patterns and generates workflow definitions based on your use case.',
        systemInstructions: PATTERN_ADVISOR_INSTRUCTIONS,
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        temperature: 0.3,
        maxTokens: 4096,
        isActive: true,
        isSystem: true,
        createdBy,
      },
    });

    for (const def of CAPABILITY_DEFINITIONS) {
      const capability = await prisma.aiCapability.upsert({
        where: { slug: def.slug },
        update: {},
        create: {
          name: def.name,
          slug: def.slug,
          description: def.description,
          category: def.category,
          functionDefinition: def.functionDefinition as unknown as object,
          executionType: def.executionType,
          executionHandler: def.executionHandler,
          isActive: true,
          isSystem: true,
        },
      });

      await prisma.aiAgentCapability.upsert({
        where: {
          agentId_capabilityId: {
            agentId: agent.id,
            capabilityId: capability.id,
          },
        },
        update: {},
        create: {
          agentId: agent.id,
          capabilityId: capability.id,
          isEnabled: true,
        },
      });
    }

    logger.info('✅ Seeded pattern-advisor agent with 3 capabilities');
  },
};

export default unit;
