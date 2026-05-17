/**
 * Tests for `lib/orchestration/provenance/guard-rules.ts`.
 *
 * The helper returns a string fragment for inlining into a workflow's
 * `guard.config.rules` prompt. Tests pin the contract the audit
 * workflow's `validate_proposals` step relies on so an accidental
 * wording change here doesn't silently weaken enforcement on every
 * workflow that adopts the helper.
 */

import { describe, expect, it } from 'vitest';
import { provenanceRequiredRule } from '@/lib/orchestration/provenance/guard-rules';

describe('provenanceRequiredRule', () => {
  it('defaults to the audit-workflow field shape', () => {
    const rule = provenanceRequiredRule();
    expect(rule).toContain('`changes`');
    expect(rule).toContain('`newModels`');
    expect(rule).toContain('`deactivateModels`');
  });

  it('numbers the rule 8 by default', () => {
    const rule = provenanceRequiredRule();
    expect(rule.startsWith('8. ')).toBe(true);
  });

  it('respects a custom rule number', () => {
    const rule = provenanceRequiredRule({ ruleNumber: 3 });
    expect(rule.startsWith('3. ')).toBe(true);
  });

  it('respects a custom field list', () => {
    const rule = provenanceRequiredRule({ fields: ['claims', 'recommendations'] });
    expect(rule).toContain('`claims`');
    expect(rule).toContain('`recommendations`');
    expect(rule).not.toContain('`changes`');
  });

  it('uses per-item scan target by default', () => {
    const rule = provenanceRequiredRule();
    expect(rule).toContain('Every entry in each of these arrays');
  });

  it('uses array-level scan target when perItem is false', () => {
    const rule = provenanceRequiredRule({ perItem: false });
    expect(rule).toContain('Each of these arrays MUST itself have');
    expect(rule).not.toContain('Every entry in each of these arrays');
  });

  it('lists every valid source kind verbatim', () => {
    const rule = provenanceRequiredRule();
    for (const kind of [
      'training_knowledge',
      'web_search',
      'knowledge_base',
      'prior_step',
      'external_call',
      'user_input',
    ]) {
      expect(rule).toContain(`\`${kind}\``);
    }
  });

  it('lists every valid confidence value verbatim', () => {
    const rule = provenanceRequiredRule();
    for (const c of ['high', 'medium', 'low']) {
      expect(rule).toContain(`\`${c}\``);
    }
  });

  it('forbids training_knowledge + high confidence in the rule body', () => {
    const rule = provenanceRequiredRule();
    expect(rule).toContain('training_knowledge');
    expect(rule).toMatch(/never.*high/i);
  });

  it('includes the worked rejection example so the LLM has a concrete anchor', () => {
    const rule = provenanceRequiredRule();
    expect(rule).toContain('Worked rejection');
    expect(rule).toContain('FAIL');
  });
});
