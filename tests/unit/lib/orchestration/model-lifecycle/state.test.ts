/**
 * Model lifecycle state and the successor rule (§136 t-1064).
 *
 * @see lib/orchestration/model-lifecycle/state.ts
 */

import { describe, expect, it } from 'vitest';

import {
  checkReplacement,
  modelLifecycleState,
  parseRetirementDate,
  type ReplacementCandidate,
  type RetiringModelRef,
} from '@/lib/orchestration/model-lifecycle/state';

const NOW = new Date('2027-03-01T12:00:00.000Z');

describe('modelLifecycleState', () => {
  it('is current with no retirement known', () => {
    expect(modelLifecycleState({ retiresAt: null }, NOW)).toBe('current');
  });

  it('is retiring while the day is still to come', () => {
    expect(modelLifecycleState({ retiresAt: new Date('2027-03-01T12:00:00.001Z') }, NOW)).toBe(
      'retiring'
    );
  });

  it('is retired from the instant the day arrives', () => {
    expect(modelLifecycleState({ retiresAt: new Date('2027-03-01T12:00:00.000Z') }, NOW)).toBe(
      'retired'
    );
    expect(modelLifecycleState({ retiresAt: new Date('2026-01-01T00:00:00.000Z') }, NOW)).toBe(
      'retired'
    );
  });
});

describe('checkReplacement', () => {
  const model: RetiringModelRef = {
    id: 'm1',
    providerSlug: 'openai',
    capabilities: ['chat', 'vision'],
  };
  const good: ReplacementCandidate = {
    id: 'm2',
    name: 'GPT-5',
    providerSlug: 'openai',
    capabilities: ['chat', 'vision', 'documents'],
    isActive: true,
    retiresAt: null,
  };

  it('accepts an active same-provider successor with every capability, extra ones included', () => {
    expect(checkReplacement(model, good)).toBeNull();
  });

  it('refuses the model itself', () => {
    expect(checkReplacement(model, { ...good, id: 'm1' })).toMatch(/cannot replace itself/);
  });

  it('refuses another provider, naming both', () => {
    expect(checkReplacement(model, { ...good, providerSlug: 'anthropic' })).toBe(
      'The replacement must be on the same provider (openai); "GPT-5" is on anthropic'
    );
  });

  it('refuses a model turned off', () => {
    expect(checkReplacement(model, { ...good, isActive: false })).toMatch(/turned off/);
  });

  it('refuses a successor with any retirement date, retiring or retired', () => {
    expect(checkReplacement(model, { ...good, retiresAt: new Date('2099-01-01') })).toMatch(
      /itself being retired/
    );
    expect(checkReplacement(model, { ...good, retiresAt: new Date('2020-01-01') })).toMatch(
      /itself being retired/
    );
  });

  it('refuses a successor missing a capability, naming each one missing', () => {
    expect(
      checkReplacement(
        { ...model, capabilities: ['chat', 'vision', 'embedding'] },
        { ...good, capabilities: ['chat'] }
      )
    ).toBe('"GPT-5" lacks vision, embedding, which this model has');
  });
});

describe('parseRetirementDate', () => {
  it('reads a day as the UTC midnight that begins it', () => {
    expect(parseRetirementDate('2027-03-01')).toEqual(new Date('2027-03-01T00:00:00.000Z'));
  });

  it.each(['2027-3-1', '01/03/2027', '2027-03-01T00:00:00Z', '', 'soon'])(
    'refuses %j, which is not YYYY-MM-DD',
    (value) => {
      expect(parseRetirementDate(value)).toBeNull();
    }
  );

  it.each(['2027-02-30', '2027-13-01', '2027-00-10'])(
    'refuses %j, which is not a day on the calendar',
    (value) => {
      expect(parseRetirementDate(value)).toBeNull();
    }
  );
});
