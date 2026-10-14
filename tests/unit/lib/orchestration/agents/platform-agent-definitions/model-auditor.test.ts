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

  it('cannot write to the Model Matrix itself: writes wait for the approval step', () => {
    // The discover_new_models agent turn reads web search results; with a
    // write tool bound, text planted there could change the matrix (prices
    // included) before the workflow's human_approval step.
    for (const write of [
      'apply_audit_changes',
      'add_provider_models',
      'deactivate_provider_models',
    ]) {
      expect(PROVIDER_MODEL_AUDITOR_AGENT.capabilities).not.toContain(write);
    }
  });
});
