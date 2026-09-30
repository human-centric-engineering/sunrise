/**
 * Tests: how the admin UI names a platform agent's org-tunable fields.
 *
 * The banner and the restore dialog both build their prose from the API's
 * `tunableFields`; they differ only in whether `providerConfig` is named.
 *
 * @see components/admin/orchestration/platform-agent-fields.ts
 */
import { describe, it, expect } from 'vitest';

import { describeTunableFields } from '@/components/admin/orchestration/platform-agent-fields';
import {
  fieldLabels,
  platformAgentFieldNames,
} from '@/lib/orchestration/agents/agent-field-registry';

const ORG = platformAgentFieldNames('org');

describe('describeTunableFields', () => {
  it('leaves provider configuration out by default: the form has no control for it', () => {
    expect(describeTunableFields(ORG)).toBe(
      'provider, model, fallback providers, monthly budget, per-turn cost cap, rate limit and how long its conversations are kept'
    );
  });

  it('names provider configuration when asked: a restore brings it back', () => {
    expect(describeTunableFields(ORG, { includeProviderConfig: true })).toBe(
      'provider, model, fallback providers, provider configuration, monthly budget, per-turn cost cap, rate limit and how long its conversations are kept'
    );
  });

  it('keeps the form order whatever order the API lists them in', () => {
    expect(describeTunableFields(['retentionDays', 'model', 'provider'])).toBe(
      'provider, model and how long its conversations are kept'
    );
  });

  it('adds capabilities last when the bindings are the org’s', () => {
    expect(describeTunableFields(['model'], { capabilitiesToo: true })).toBe(
      'model and which capabilities it may use'
    );
  });

  it('names a single field without a conjunction, and nothing as empty', () => {
    expect(describeTunableFields(['model'])).toBe('model');
    expect(describeTunableFields([])).toBe('');
  });

  it("falls back to a fork field's registry label, or its name", () => {
    // `temperature` stands in for a field a fork made org-tunable: it has a
    // registry label but no phrase of its own here.
    const label = fieldLabels().temperature;
    expect(label).toBeTruthy();
    expect(describeTunableFields(['model', 'temperature', 'forkOnlyField'])).toBe(
      `model, ${label.toLowerCase()} and forkonlyfield`
    );
  });
});
