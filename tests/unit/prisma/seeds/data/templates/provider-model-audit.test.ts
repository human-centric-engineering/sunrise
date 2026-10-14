/**
 * Provider-model-audit template — supervisor wiring assertions.
 *
 * Catches drift between the seed template and the supervisor step type
 * added in Phase 1 of the workflow-supervisor branch. Tests assert the
 * DAG places the supervisor between `compile_report` and `notify_complete`
 * (so the supervisor sees the full trace including capability dispatches)
 * and that the notification template surfaces the verdict.
 */

import { describe, expect, it } from 'vitest';

import { PROVIDER_MODEL_AUDIT_TEMPLATE } from '@/prisma/seeds/data/templates/provider-model-audit';
import { supervisorConfigSchema } from '@/lib/validations/orchestration';

describe('provider-model-audit template — supervisor wiring', () => {
  const steps = PROVIDER_MODEL_AUDIT_TEMPLATE.workflowDefinition.steps;
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));

  it('contains a supervisor step with id "supervisor_review"', () => {
    const step = byId['supervisor_review'];
    expect(step).toBeDefined();
    expect(step.type).toBe('supervisor');
  });

  it('supervisor_review.config parses cleanly against supervisorConfigSchema', () => {
    const step = byId['supervisor_review'];
    expect(() => supervisorConfigSchema.parse(step.config)).not.toThrow();
  });

  it('supervisor and report steps flow into notify_complete', () => {
    // compile_report → supervisor_review → report_render → notify_complete.
    // The report step renders the trace up to (but not including) itself
    // — placing it after supervisor_review means the report can include
    // the supervisor verdict block.
    expect(byId['compile_report'].nextSteps).toEqual([{ targetStepId: 'supervisor_review' }]);
    expect(byId['supervisor_review'].nextSteps).toEqual([{ targetStepId: 'report_render' }]);
    expect(byId['report_render'].nextSteps).toEqual([{ targetStepId: 'notify_complete' }]);
    expect(byId['report_render'].type).toBe('report');
  });

  it('supervisor step opts in to errorStrategy=skip so judge-model failures cannot flip status', () => {
    const config = byId['supervisor_review'].config;
    expect(config.errorStrategy).toBe('skip');
  });

  it('supervisor step does NOT terminate the workflow on a fail verdict (advisory)', () => {
    const config = byId['supervisor_review'].config;
    expect(config.failOnVerdict).toBe('never');
  });

  it('supervisor step defaults to enabled and respects the run-time opt-out', () => {
    const config = byId['supervisor_review'].config;
    expect(config.defaultEnabled).toBe(true);
    expect(config.respectRuntimeOptOut).toBe(true);
  });

  it('notify_complete bodyTemplate surfaces the supervisor verdict before the report', () => {
    const config = byId['notify_complete'].config as { bodyTemplate: string };
    expect(config.bodyTemplate).toContain('{{supervisor_review.output.verdict}}');
    expect(config.bodyTemplate).toContain('{{supervisor_review.output.summary}}');
    expect(config.bodyTemplate).toContain('{{supervisor_review.output.weaknesses}}');
    // Verdict block must appear before the optimistic compile_report
    // narrative — the recipient sees the honest assessment first.
    const verdictIndex = config.bodyTemplate.indexOf('{{supervisor_review.output.verdict}}');
    const reportIndex = config.bodyTemplate.indexOf('{{compile_report.output}}');
    expect(verdictIndex).toBeGreaterThanOrEqual(0);
    expect(reportIndex).toBeGreaterThan(verdictIndex);
  });

  it('failure-branch terminus (report_validation_failure) does NOT supervise', () => {
    // The guard-exhausted path is itself a clear signal and the workflow
    // has done nothing irreversible by that point — adding supervisor
    // here would double-bill without adding signal.
    expect(byId['report_validation_failure']).toBeDefined();
    expect(byId['report_validation_failure'].nextSteps).toEqual([]);
  });
});

describe('provider-model-audit template — pricing (t-774)', () => {
  const steps = PROVIDER_MODEL_AUDIT_TEMPLATE.workflowDefinition.steps;
  const byId = Object.fromEntries(steps.map((s) => [s.id, s]));

  it('analyse_chat prompt carries the pricing rules', () => {
    const prompt = (byId['analyse_chat'].config as { prompt: string }).prompt;
    expect(prompt).toContain('Training knowledge alone is NOT enough for a price');
    expect(prompt).toContain('inputCostPerMillionTokens');
    expect(prompt).toContain('outputCostPerMillionTokens');
    expect(prompt).toContain('both, together');
    // The schema rejects a lone price change, so the prompt must say to
    // restate an unchanged price rather than leave it out.
    expect(prompt).toContain('If only one of them changed, still propose both');
    expect(prompt).toContain('written as JSON numbers');
  });

  it('validate_rationale passes a restated, unchanged price paired with a changed one', () => {
    // The pricing prompt asks for an unchanged partner; the rationale guard
    // must not fail it for not explaining why its current value is wrong.
    const rules = (byId['validate_rationale'].config as { rules: string }).rules;
    expect(rules).toContain('restated as the pair of the other price');
  });

  it('discover_new_models message carries the pricing rules', () => {
    const message = (byId['discover_new_models'].config as { message: string }).message;
    expect(message).toContain('Training knowledge alone is NOT enough for a price');
    expect(message).toContain('inputCostPerMillionTokens');
  });

  it('load_models extracts both price fields', () => {
    const prompt = (byId['load_models'].config as { prompt: string }).prompt;
    expect(prompt).toContain('inputCostPerMillionTokens');
    expect(prompt).toContain('outputCostPerMillionTokens');
  });

  it('refine_findings critique asks the reflector to check prices', () => {
    const critique = (byId['refine_findings'].config as { critiquePrompt: string }).critiquePrompt;
    expect(critique).toContain('For any proposed price');
    expect(critique).toContain('per 1M tokens');
  });

  it('review_changes newModels section has editable numeric price columns', () => {
    const config = byId['review_changes'].config as {
      reviewSchema: {
        sections: Array<{
          id: string;
          fields: Array<{ key: string; display: string; editable?: boolean }>;
        }>;
      };
    };
    const section = config.reviewSchema.sections.find((x) => x.id === 'newModels');
    for (const key of ['inputCostPerMillionTokens', 'outputCostPerMillionTokens']) {
      const field = section?.fields.find((f) => f.key === key);
      expect(field, key).toBeDefined();
      expect(field?.display).toBe('number');
      expect(field?.editable).toBe(true);
    }
  });
});
