import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { logger } from '../lib/logging';
import { DEFAULT_FLAGS } from '../lib/feature-flags/config';
import { BUILTIN_WORKFLOW_TEMPLATES } from '../lib/orchestration/workflows/templates';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

async function main() {
  logger.info('🌱 Seeding database...');

  // Clear existing data (in development only)
  if (process.env.NODE_ENV === 'development') {
    logger.info('🗑️  Clearing existing data...');
    await prisma.verification.deleteMany();
    await prisma.session.deleteMany();
    await prisma.account.deleteMany();
    // Clear orchestration rows that FK to User before deleting users, or
    // the deleteMany below fails with a foreign-key error. Workflow
    // executions FK to workflows so they go first.
    await prisma.aiWorkflowExecution.deleteMany();
    await prisma.aiWorkflow.deleteMany();
    await prisma.aiProviderConfig.deleteMany();
    await prisma.user.deleteMany();
    await prisma.featureFlag.deleteMany();
  }

  // Create test users
  logger.info('👤 Creating test users...');

  const testUser = await prisma.user.create({
    data: {
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: true,
      role: 'USER',
    },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@example.com',
      name: 'Admin User',
      emailVerified: true,
      role: 'ADMIN',
    },
  });

  logger.info('✅ Created test user', { email: testUser.email });
  logger.info('✅ Created admin user', { email: adminUser.email });

  // Seed default feature flags
  logger.info('🚩 Seeding feature flags...');

  const { count } = await prisma.featureFlag.createMany({
    data: DEFAULT_FLAGS.map((flag) => ({
      name: flag.name,
      description: flag.description,
      enabled: flag.enabled,
      metadata: flag.metadata,
    })),
  });
  logger.info(`✅ Created ${count} feature flags`);

  // Seed default LLM providers (Anthropic / OpenAI / Ollama).
  // Idempotent on every run: `upsert({ update: {} })` never overwrites
  // rows the admin may have edited in the UI. `isActive` is driven by
  // env-var presence at seed time so a fresh install with
  // `ANTHROPIC_API_KEY` set lights up the provider immediately.
  await seedDefaultProviders(adminUser.id);

  // Seed built-in workflow templates so they show up in the workflows
  // list page. Each template is a pure-TS WorkflowDefinition shared with
  // the builder toolbar's "Use template" dropdown.
  await seedBuiltinTemplates(adminUser.id);

  // Seed the pattern-advisor agent with its three built-in capabilities.
  await seedPatternAdvisor(adminUser.id);

  // Seed the quiz-master agent for interactive pattern quizzes.
  await seedQuizMaster(adminUser.id);

  logger.info('🎉 Seeding complete!');
}

/**
 * Upsert the three default providers (anthropic, openai, ollama-local).
 *
 * - Anthropic — first-party Claude; active iff `ANTHROPIC_API_KEY` is set.
 * - OpenAI — OpenAI-compatible w/ canonical base URL; active iff
 *   `OPENAI_API_KEY` is set.
 * - Ollama — local/loopback; inactive by default (admins toggle on after
 *   they install Ollama).
 *
 * Keyed by slug. The `create` branch is the only branch that writes, so
 * re-running the seeder against an admin-edited row is a no-op.
 */
async function seedDefaultProviders(createdBy: string): Promise<void> {
  logger.info('🔌 Seeding default providers...');

  const defaults = [
    {
      slug: 'anthropic',
      name: 'Anthropic',
      providerType: 'anthropic',
      baseUrl: null as string | null,
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      isLocal: false,
      isActive: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    {
      slug: 'openai',
      name: 'OpenAI',
      providerType: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnvVar: 'OPENAI_API_KEY',
      isLocal: false,
      isActive: Boolean(process.env.OPENAI_API_KEY),
    },
    {
      slug: 'ollama-local',
      name: 'Ollama (Local)',
      providerType: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      apiKeyEnvVar: null as string | null,
      isLocal: true,
      isActive: false,
    },
  ];

  for (const p of defaults) {
    await prisma.aiProviderConfig.upsert({
      where: { slug: p.slug },
      // Empty update — re-seeding never overwrites admin edits.
      update: {},
      create: {
        slug: p.slug,
        name: p.name,
        providerType: p.providerType,
        baseUrl: p.baseUrl,
        apiKeyEnvVar: p.apiKeyEnvVar,
        isLocal: p.isLocal,
        isActive: p.isActive,
        createdBy,
      },
    });
  }

  logger.info(`✅ Upserted ${defaults.length} default providers`);
}

/**
 * Upsert the built-in workflow templates (`BUILTIN_WORKFLOW_TEMPLATES`)
 * as `AiWorkflow` rows with `isTemplate: true`. Each row is keyed by the
 * template's static `slug`; the `update` branch is empty so re-running
 * the seeder against an admin-edited template row is a no-op.
 */
async function seedBuiltinTemplates(createdBy: string): Promise<void> {
  logger.info('📚 Seeding built-in workflow templates...');

  for (const template of BUILTIN_WORKFLOW_TEMPLATES) {
    const patternsUsed = template.patterns.map((p) => p.number);
    await prisma.aiWorkflow.upsert({
      where: { slug: template.slug },
      // Empty update — re-seeding never overwrites admin edits.
      update: {},
      create: {
        slug: template.slug,
        name: template.name,
        description: template.shortDescription,
        workflowDefinition: template.workflowDefinition as unknown as object,
        patternsUsed,
        isActive: true,
        isTemplate: true,
        createdBy,
      },
    });
  }

  logger.info(`✅ Upserted ${BUILTIN_WORKFLOW_TEMPLATES.length} built-in templates`);
}

// ─── Pattern Advisor ─────────────────────────────────────────────────────────

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
async function seedPatternAdvisor(createdBy: string): Promise<void> {
  logger.info('🤖 Seeding pattern-advisor agent...');

  // Upsert the agent
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
      createdBy,
    },
  });

  // Upsert the three capabilities and link them to the agent
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
      },
    });

    // Link agent ↔ capability (idempotent via compound unique)
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
}

// ─── Quiz Master ─────────────────────────────────────────────────────────────

const QUIZ_MASTER_INSTRUCTIONS = `You are a quiz master for agentic design patterns. Your job is to test and teach through interactive questioning.

QUIZ FLOW:
1. At the start, ask the user to self-assess: beginner, intermediate, or advanced. Alternatively, ask 2-3 calibration questions to gauge their level.
2. Generate questions appropriate to their level:
   - Beginner: Focus on Patterns 1, 2, 5, 14, 18 (Foundation tier)
   - Intermediate: Include Patterns 3, 4, 6, 7, 8, 13
   - Advanced: All patterns + compositions + emerging concepts
3. Adjust difficulty dynamically: if they get 3 right in a row, increase difficulty. If they get 2 wrong in a row, decrease difficulty.
4. After each answer, explain WHY the correct answer is correct, linking to the specific pattern. Use search_knowledge_base to ground your explanations.
5. Track their score. After each answer, include the running score in the format "Score: X/Y" where X is correct answers and Y is total questions answered. After 10 questions, give a summary: areas of strength, areas to study, and specific pattern numbers to review.

QUESTION TYPES (vary these):
- Multiple choice (4 options)
- Scenario-based: "Given this requirement, which pattern(s) would you use?"
- Trade-off: "What's the main drawback of using Pattern X here?"
- True/false with explanation
- "What would go wrong if..." (anti-pattern identification)

FORMAT: Present questions clearly with lettered options (A, B, C, D). Wait for the user's answer before revealing the correct one. Be encouraging but honest. Learning is the goal, not tricks.`;

/** Capabilities to link to the quiz-master (subset of pattern-advisor's). */
const QUIZ_CAPABILITY_SLUGS = ['search_knowledge_base', 'get_pattern_detail'] as const;

/**
 * Seed the "quiz-master" agent with two knowledge capabilities.
 *
 * Idempotent — safe to run on every deploy. The capabilities already
 * exist from `seedPatternAdvisor`; we only create the pivot links.
 */
async function seedQuizMaster(createdBy: string): Promise<void> {
  logger.info('🧠 Seeding quiz-master agent...');

  const agent = await prisma.aiAgent.upsert({
    where: { slug: 'quiz-master' },
    update: {},
    create: {
      name: 'Pattern Quiz Master',
      slug: 'quiz-master',
      description:
        'Interactive quiz on agentic design patterns with adaptive difficulty and knowledge-grounded explanations.',
      systemInstructions: QUIZ_MASTER_INSTRUCTIONS,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      temperature: 0.5,
      maxTokens: 4096,
      isActive: true,
      createdBy,
    },
  });

  // Link to existing capabilities (created by seedPatternAdvisor)
  for (const slug of QUIZ_CAPABILITY_SLUGS) {
    const capability = await prisma.aiCapability.findUnique({
      where: { slug },
    });
    if (!capability) {
      logger.warn(`⚠️ Capability ${slug} not found — skipping link for quiz-master`);
      continue;
    }

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

  logger.info('✅ Seeded quiz-master agent with 2 capabilities');
}

main()
  .catch((e) => {
    logger.error('❌ Seeding failed', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
