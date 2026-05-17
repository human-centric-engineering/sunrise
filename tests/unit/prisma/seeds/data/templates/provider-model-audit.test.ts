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

  it('supervisor step is positioned between compile_report and notify_complete', () => {
    expect(byId['compile_report'].nextSteps).toEqual([{ targetStepId: 'supervisor_review' }]);
    expect(byId['supervisor_review'].nextSteps).toEqual([{ targetStepId: 'notify_complete' }]);
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
