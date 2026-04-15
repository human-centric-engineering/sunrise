import type { SeedUnit } from '../runner';

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
 * exist from `005-pattern-advisor`; we only create the pivot links.
 */
const unit: SeedUnit = {
  name: '006-quiz-master',
  async run({ prisma, logger }) {
    logger.info('🧠 Seeding quiz-master agent...');

    const admin = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-test-users runs first.');
    }
    const createdBy = admin.id;

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
  },
};

export default unit;
