/**
 * Estimate Workflow Cost capability
 *
 * Rough planning-grade cost estimate for a multi-step workflow. Picks
 * a representative model for the requested tier and multiplies
 * hard-coded per-step token assumptions by the step count. The result
 * sets `skipFollowup: true` — the number *is* the final answer, so
 * the chat handler should feed it back without another LLM turn.
 *
 * The heuristic tokens-per-step values below are deliberately rough:
 * they exist so the LLM can give order-of-magnitude answers like
 * "about $0.08 for 5 Sonnet steps". Tighten them later if we start
 * capturing real workflow traces.
 */

import { z } from 'zod';
import { calculateCost } from '@/lib/orchestration/llm/cost-tracker';
import { getModelsByTier } from '@/lib/orchestration/llm/model-registry';
import { BaseCapability } from '../base-capability';
import type { CapabilityContext, CapabilityFunctionDefinition, CapabilityResult } from '../types';

/** Rough planning-grade assumptions — not measured from production traces. */
const INPUT_TOKENS_PER_STEP = 1500;
const OUTPUT_TOKENS_PER_STEP = 500;

const schema = z.object({
  description: z.string().min(1).max(2000),
  estimated_steps: z.number().int().min(1).max(1000),
  model_tier: z.enum(['budget', 'mid', 'frontier']),
});

type Args = z.infer<typeof schema>;

interface Data {
  model: string;
  tier: Args['model_tier'];
  totalSteps: number;
  assumptions: {
    inputTokensPerStep: number;
    outputTokensPerStep: number;
  };
  cost: {
    inputCostUsd: number;
    outputCostUsd: number;
    totalCostUsd: number;
  };
}

export class EstimateCostCapability extends BaseCapability<Args, Data> {
  readonly slug = 'estimate_workflow_cost';

  readonly functionDefinition: CapabilityFunctionDefinition = {
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
  };

  protected readonly schema = schema;

  execute(args: Args, _context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const candidates = getModelsByTier(args.model_tier);
    const model = candidates[0];
    if (!model) {
      return Promise.resolve(
        this.error(`No model available for tier ${args.model_tier}`, 'no_model_for_tier')
      );
    }

    const totalInput = args.estimated_steps * INPUT_TOKENS_PER_STEP;
    const totalOutput = args.estimated_steps * OUTPUT_TOKENS_PER_STEP;
    const cost = calculateCost(model.id, totalInput, totalOutput);

    return Promise.resolve(
      this.success(
        {
          model: model.id,
          tier: args.model_tier,
          totalSteps: args.estimated_steps,
          assumptions: {
            inputTokensPerStep: INPUT_TOKENS_PER_STEP,
            outputTokensPerStep: OUTPUT_TOKENS_PER_STEP,
          },
          cost: {
            inputCostUsd: cost.inputCostUsd,
            outputCostUsd: cost.outputCostUsd,
            totalCostUsd: cost.totalCostUsd,
          },
        },
        { skipFollowup: true }
      )
    );
  }
}
