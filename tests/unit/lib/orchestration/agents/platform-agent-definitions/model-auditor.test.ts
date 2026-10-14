/**
 * Tests: the provider-model auditor's definition.
 *
 * The audit workflow's new-model discovery runs as this agent, so its
 * instructions are where the price rule (t-774) reaches the model doing the
 * discovering: prices as a pair, only from a citable source. The
 * `audit-proposals` schema enforces the rule; this keeps the agent from
 * being told something different.
 *
 * @see lib/orchestration/agents/platform-agent-definitions/model-auditor.ts
 */
import { describe, it, expect } from 'vitest';

import { PROVIDER_MODEL_AUDITOR_AGENT } from '@/lib/orchestration/agents/platform-agent-definitions/model-auditor';

describe('PROVIDER_MODEL_AUDITOR_AGENT', () => {
  const instructions = PROVIDER_MODEL_AUDITOR_AGENT.agent.systemInstructions;

  it('tells the auditor to propose prices as a pair, only from a citable source', () => {
    expect(instructions).toContain('**Prices**');
    expect(instructions).toContain('proposed as a pair');
    expect(instructions).toContain('only from a source you can cite with a URL');
    expect(instructions).toContain('Never from memory alone');
  });

  it('is install-only and can write audited changes back to the matrix', () => {
    expect(PROVIDER_MODEL_AUDITOR_AGENT.audience).toBe('install-only');
    expect(PROVIDER_MODEL_AUDITOR_AGENT.capabilities).toEqual(
      expect.arrayContaining(['apply_audit_changes', 'add_provider_models'])
    );
  });
});
