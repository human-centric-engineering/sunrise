import { describe, it, expect } from 'vitest';

import { auditProposalsSchema } from '@/lib/orchestration/schemas/audit-proposals';

/**
 * Tests for the `audit-proposals` Zod schema. Replaces the prior
 * LLM-mode `validate_proposals` rules — these tests pin the structural
 * checks that an LLM judge kept hallucinating on:
 *
 *   - capabilities element membership (the recurring `vision`
 *     failure that motivated the rewrite)
 *   - tierRole / deploymentProfiles / other enum membership
 *   - per-field proposedValue enum check on changes
 *   - sources non-empty + per-source-kind rules
 *   - new-model slug regex
 *
 * Rule 10 (rationale-engagement) is intentionally NOT in this
 * schema — it stays on the downstream `validate_rationale` LLM
 * guard, where LLM judgement is the right tool.
 */

const SOURCE = {
  source: 'web_search',
  confidence: 'high',
  reference: 'https://provider.example.com/release-notes',
};

const VALID_ANALYSIS_BRANCH = {
  models: [],
  deactivateModels: [],
};

function makeInput(overrides: Partial<Record<string, unknown>> = {}): unknown {
  return {
    analyse_chat: VALID_ANALYSIS_BRANCH,
    analyse_embedding: VALID_ANALYSIS_BRANCH,
    discover_new_models: { newModels: [], reasoning: '' },
    ...overrides,
  };
}

describe('audit-proposals schema', () => {
  it('accepts an empty compound (no proposals from any branch)', () => {
    const result = auditProposalsSchema.safeParse(makeInput());
    expect(result.success).toBe(true);
  });

  // ── Closed-set membership (the failure that motivated this rewrite) ─
  it('accepts a new model whose capabilities array contains `vision`', () => {
    // The LLM-mode guard rejected this exact input three times in a
    // week. The schema must accept it — `vision` IS in the spec.
    const result = auditProposalsSchema.safeParse(
      makeInput({
        discover_new_models: {
          newModels: [
            {
              name: 'Demo',
              slug: 'provider-demo',
              providerSlug: 'provider',
              modelId: 'demo-1',
              description: 'A demo model',
              capabilities: ['chat', 'vision', 'documents'],
              tierRole: 'thinking',
              deploymentProfiles: ['hosted'],
              bestRole: 'Demo',
              sources: [SOURCE],
            },
          ],
          reasoning: 'one new model',
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it('rejects a new model whose capabilities contains an unknown token', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        discover_new_models: {
          newModels: [
            {
              name: 'Demo',
              slug: 'provider-demo',
              providerSlug: 'provider',
              modelId: 'demo-1',
              description: 'A demo model',
              capabilities: ['chat', 'multimodal'], // multimodal is not in CAPABILITIES
              tierRole: 'thinking',
              deploymentProfiles: ['hosted'],
              bestRole: 'Demo',
              sources: [SOURCE],
            },
          ],
          reasoning: '',
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a new model whose tierRole is not in TIER_ROLES', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        discover_new_models: {
          newModels: [
            {
              name: 'Demo',
              slug: 'provider-demo',
              providerSlug: 'provider',
              modelId: 'demo-1',
              description: 'A demo model',
              capabilities: ['chat'],
              tierRole: 'edge', // not in TIER_ROLES
              deploymentProfiles: ['hosted'],
              bestRole: 'Demo',
              sources: [SOURCE],
            },
          ],
          reasoning: '',
        },
      })
    );
    expect(result.success).toBe(false);
  });

  // ── Per-field proposedValue enum (changes) ──────────────────────────
  it('accepts a change whose field=tierRole + proposedValue is in TIER_ROLES', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        analyse_chat: {
          models: [
            {
              model_id: 'm1',
              modelName: 'Model 1',
              providerSlug: 'provider',
              changes: [
                {
                  field: 'tierRole',
                  currentValue: 'worker',
                  proposedValue: 'thinking',
                  reason: 'Reasoning is very_high; worker tier undersells it.',
                  confidence: 'high',
                  sources: [SOURCE],
                },
              ],
              overallConfidence: 'high',
              reasoning: 'shift up the tier',
            },
          ],
          deactivateModels: [],
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it('rejects a change whose field=capabilities + proposedValue array contains an unknown token', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        analyse_chat: {
          models: [
            {
              model_id: 'm1',
              modelName: 'Model 1',
              providerSlug: 'provider',
              changes: [
                {
                  field: 'capabilities',
                  currentValue: ['chat'],
                  proposedValue: ['chat', 'reasoning', 'multimodal'], // multimodal bad
                  reason: 'add reasoning + multimodal',
                  confidence: 'medium',
                  sources: [SOURCE],
                },
              ],
              overallConfidence: 'medium',
              reasoning: '',
            },
          ],
          deactivateModels: [],
        },
      })
    );
    expect(result.success).toBe(false);
  });

  // ── Sources rules (Rule 9) ──────────────────────────────────────────
  it('rejects a change with an empty sources array', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        analyse_chat: {
          models: [
            {
              model_id: 'm1',
              modelName: 'Model 1',
              providerSlug: 'provider',
              changes: [
                {
                  field: 'bestRole',
                  currentValue: 'worker',
                  proposedValue: 'planner',
                  reason: 'whatever',
                  confidence: 'low',
                  sources: [], // empty
                },
              ],
              overallConfidence: 'low',
              reasoning: '',
            },
          ],
          deactivateModels: [],
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a `training_knowledge` source with confidence=high', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        analyse_chat: {
          models: [
            {
              model_id: 'm1',
              modelName: 'Model 1',
              providerSlug: 'provider',
              changes: [
                {
                  field: 'bestRole',
                  currentValue: 'a',
                  proposedValue: 'b',
                  reason: 'reason',
                  confidence: 'high',
                  sources: [{ source: 'training_knowledge', confidence: 'high' }],
                },
              ],
              overallConfidence: 'high',
              reasoning: '',
            },
          ],
          deactivateModels: [],
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a `web_search` source with no reference', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        analyse_chat: {
          models: [
            {
              model_id: 'm1',
              modelName: 'Model 1',
              providerSlug: 'provider',
              changes: [
                {
                  field: 'bestRole',
                  currentValue: 'a',
                  proposedValue: 'b',
                  reason: 'reason',
                  confidence: 'high',
                  sources: [{ source: 'web_search', confidence: 'high' }],
                },
              ],
              overallConfidence: 'high',
              reasoning: '',
            },
          ],
          deactivateModels: [],
        },
      })
    );
    expect(result.success).toBe(false);
  });

  // ── Slug regex ──────────────────────────────────────────────────────
  it('rejects a new model whose slug contains uppercase letters', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        discover_new_models: {
          newModels: [
            {
              name: 'Demo',
              slug: 'Provider-Demo', // capitals reject
              providerSlug: 'provider',
              modelId: 'demo-1',
              description: 'A demo model',
              capabilities: ['chat'],
              tierRole: 'thinking',
              deploymentProfiles: ['hosted'],
              bestRole: 'Demo',
              sources: [SOURCE],
            },
          ],
          reasoning: '',
        },
      })
    );
    expect(result.success).toBe(false);
  });

  // ── Empty deploymentProfiles ────────────────────────────────────────
  it('rejects a new model with empty deploymentProfiles', () => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        discover_new_models: {
          newModels: [
            {
              name: 'Demo',
              slug: 'provider-demo',
              providerSlug: 'provider',
              modelId: 'demo-1',
              description: 'A demo model',
              capabilities: ['chat'],
              tierRole: 'thinking',
              deploymentProfiles: [],
              bestRole: 'Demo',
              sources: [SOURCE],
            },
          ],
          reasoning: '',
        },
      })
    );
    expect(result.success).toBe(false);
  });

  // ── modelId canonical-form regex (Issue 5 — registry uses bare ids) ──
  // The schema enforces structural shape; the "no date suffix" rule is
  // a semantic constraint that lives in the prompt. The regex still
  // catches the most common drift modes (uppercase, spaces, trailing
  // separators) so the validator surfaces them at attempt 1 rather
  // than letting the downstream tool_call key on a malformed id.

  function makeNewModel(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Demo',
      slug: 'provider-demo',
      providerSlug: 'provider',
      modelId: 'demo-1',
      description: 'A demo model',
      capabilities: ['chat'],
      tierRole: 'thinking',
      deploymentProfiles: ['hosted'],
      bestRole: 'Demo',
      sources: [SOURCE],
      ...overrides,
    };
  }

  it.each([
    ['claude-opus-4', true],
    ['claude-sonnet-4-5', true],
    ['gpt-5', true],
    ['gpt-4.1', true],
    ['gpt-4o-mini', true],
    ['o3-mini', true],
    ['text-embedding-3-large', true],
    ['meta-llama/llama-3.3-70b', true], // slashes allowed for compound provider ids
    ['Claude-Opus-4', false], // uppercase
    ['claude-opus-4-', false], // trailing hyphen
    ['-claude-opus-4', false], // leading hyphen
    ['gpt 5', false], // space
    ['gpt--5', false], // double separator
    ['gpt-5.', false], // trailing dot
  ])('modelId %s → valid: %s', (modelId, expected) => {
    const result = auditProposalsSchema.safeParse(
      makeInput({
        discover_new_models: {
          newModels: [makeNewModel({ modelId })],
          reasoning: '',
        },
      })
    );
    expect(result.success).toBe(expected);
  });
});
