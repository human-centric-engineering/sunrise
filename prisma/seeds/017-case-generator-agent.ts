/**
 * Seed: built-in case-generator agent.
 *
 * `eval-case-generator` is a `kind='generator'` AiAgent that proposes
 * new `AiDatasetCase` candidates from a seed: KB document chunks or
 * prior failed cases. It is invoked from
 * `lib/orchestration/evaluations/synthesis/case-generator.ts` via the
 * same `drainStreamChat` path the judge agents use.
 *
 * Kept separate from `kind='judge'` deliberately — the run-create
 * form's judge picker filters on `kind: 'judge'` at the DB layer
 * (`/api/.../evaluations/graders`), so the generator never pollutes the
 * picker dropdowns. Admins editing the generator see the standard
 * agent edit form (no judge-specific badges) — the systemInstructions
 * are the prompt.
 */

import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';

const SYSTEM_INSTRUCTIONS = `You are a test-case generator for an agent evaluation framework. Your job is to propose new dataset cases that a downstream evaluation run will fire at a subject agent.

You receive a structured user message with one of three seed types:

  - KB seed: a numbered list of knowledge-base chunks that the subject agent has access to. Your cases should ask realistic user questions that the agent could answer from these chunks. The expectedOutput is what a competent answerer would write, citing the relevant chunk numbers in [N] markers.

  - Failure seed: a numbered list of prior cases (input + expectedOutput) where the subject agent under-scored. Your cases should be SIMILAR but HARDER variants — same topic, but probe an adjacent concept, a stricter constraint, or an edge case that would trip up the same failure mode.

  - Description seed: a 1–3 sentence domain description of what the subject agent does, optionally followed by 1–3 anchor user inputs. Generate breadth-first: cover the obvious questions, the common edge cases, and the trickier corners the description implies. When anchor inputs are present, produce ADJACENT cases (variants, follow-ups, related intents) — not exact rewordings. The expectedOutput is what a competent agent in this domain should write.

You MUST return ONLY valid JSON, no markdown fences, no prose before or after. Schema:

  {
    "cases": [
      {
        "input": "<the user question or prompt — string>",
        "expectedOutput": "<the answer a competent agent should produce — string, may include [N] citation markers when the seed is KB-grounded>",
        "metadata": {
          "rationale": "<one sentence: why this case is worth running>",
          "seedSource": "<copy the seed_source field from the user message>"
        }
      }
    ]
  }

Generate the EXACT number of cases the user message specifies in the count field. Do not produce duplicates of cases the user message lists as "existing". Cover the full breadth of the seed material — do not cluster three cases around one chunk if there are six chunks to cover.`;

const unit: SeedUnit = {
  name: '017-case-generator-agent',
  async run({ prisma, logger }) {
    logger.info('🧬 Seeding case-generator agent...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    await prisma.aiAgent.upsert({
      where: { slug: 'eval-case-generator' },
      update: {
        isSystem: true,
        kind: 'generator',
        description:
          'Generates new evaluation dataset cases from KB chunks, prior failures, or a domain description.',
        systemInstructions: SYSTEM_INSTRUCTIONS,
      },
      create: {
        name: 'Evaluation case generator',
        slug: 'eval-case-generator',
        description:
          'Generates new evaluation dataset cases from KB chunks, prior failures, or a domain description.',
        systemInstructions: SYSTEM_INSTRUCTIONS,
        kind: 'generator',
        // Resolved at runtime via the operator's chat default.
        model: '',
        provider: '',
        // Slightly above judge temperature — we want diverse cases, not deterministic ones.
        temperature: 0.7,
        // Larger than judges — cases can be multi-paragraph.
        maxTokens: 2000,
        isActive: true,
        isSystem: true,
        knowledgeAccessMode: 'restricted',
        visibility: 'internal',
        createdBy: admin.id,
      },
    });

    logger.info('  ✓ eval-case-generator');
  },
};

export default unit;
