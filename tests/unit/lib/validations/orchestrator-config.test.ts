/**
 * Tests for orchestrator validation schemas.
 *
 * Covers:
 *   - orchestratorConfigSchema: required/optional fields, bounds, defaults
 *   - orchestratorPlannerResponseSchema: delegation array, optional fields
 *
 * @see lib/validations/orchestration.ts
 */

import { describe, expect, it } from 'vitest';

import {
  orchestratorConfigSchema,
  orchestratorPlannerResponseSchema,
} from '@/lib/validations/orchestration';

// ─── orchestratorConfigSchema ────────────────────────────────────────────────

describe('orchestratorConfigSchema', () => {
  const validConfig = {
    plannerPrompt: 'Coordinate research agents.',
    availableAgentSlugs: ['agent-a', 'agent-b'],
  };

  it('accepts valid full config', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      selectionMode: 'all',
      maxRounds: 5,
      maxDelegationsPerRound: 10,
      modelOverride: 'gpt-4o',
      temperature: 0.7,
      timeoutMs: 60000,
      budgetLimitUsd: 1.5,
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid minimal config with defaults', () => {
    const result = orchestratorConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.selectionMode).toBe('auto');
      expect(result.data.maxRounds).toBe(3);
      expect(result.data.maxDelegationsPerRound).toBe(5);
      expect(result.data.temperature).toBe(0.3);
      expect(result.data.timeoutMs).toBe(120000);
    }
  });

  it('rejects missing plannerPrompt', () => {
    const result = orchestratorConfigSchema.safeParse({
      availableAgentSlugs: ['agent-a'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty plannerPrompt', () => {
    const result = orchestratorConfigSchema.safeParse({
      plannerPrompt: '',
      availableAgentSlugs: ['agent-a'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty availableAgentSlugs array', () => {
    const result = orchestratorConfigSchema.safeParse({
      plannerPrompt: 'Plan things.',
      availableAgentSlugs: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing availableAgentSlugs', () => {
    const result = orchestratorConfigSchema.safeParse({
      plannerPrompt: 'Plan things.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxRounds = 0', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      maxRounds: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxRounds = 11', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      maxRounds: 11,
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxDelegationsPerRound = 0', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      maxDelegationsPerRound: 0,
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxDelegationsPerRound = 21', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      maxDelegationsPerRound: 21,
    });
    expect(result.success).toBe(false);
  });

  it('rejects temperature = -1', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      temperature: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects temperature = 3', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      temperature: 3,
    });
    expect(result.success).toBe(false);
  });

  it('rejects timeoutMs = 4999', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      timeoutMs: 4999,
    });
    expect(result.success).toBe(false);
  });

  it('rejects timeoutMs = 600001', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      timeoutMs: 600001,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid selectionMode', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      selectionMode: 'random',
    });
    expect(result.success).toBe(false);
  });

  it('accepts budgetLimitUsd = 0', () => {
    const result = orchestratorConfigSchema.safeParse({
      ...validConfig,
      budgetLimitUsd: 0,
    });
    expect(result.success).toBe(true);
  });
});

// ─── orchestratorPlannerResponseSchema ───────────────────────────────────────

describe('orchestratorPlannerResponseSchema', () => {
  it('accepts valid response with delegations', () => {
    const result = orchestratorPlannerResponseSchema.safeParse({
      delegations: [
        { agentSlug: 'researcher', message: 'Find data' },
        { agentSlug: 'analyst', message: 'Analyze trends' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts response with finalAnswer and empty delegations', () => {
    const result = orchestratorPlannerResponseSchema.safeParse({
      delegations: [],
      finalAnswer: 'The answer is 42.',
      reasoning: 'I had enough data.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing delegations array', () => {
    const result = orchestratorPlannerResponseSchema.safeParse({
      finalAnswer: 'Answer without delegations field.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects delegation without agentSlug', () => {
    const result = orchestratorPlannerResponseSchema.safeParse({
      delegations: [{ message: 'Do something' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects delegation without message', () => {
    const result = orchestratorPlannerResponseSchema.safeParse({
      delegations: [{ agentSlug: 'agent-a' }],
    });
    expect(result.success).toBe(false);
  });
});
