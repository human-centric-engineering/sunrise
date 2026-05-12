/**
 * agent-version-diff — pure helpers for the version-history viewer.
 *
 * @see lib/orchestration/agent-version-diff.ts
 */

import { describe, it, expect } from 'vitest';

import {
  diffAgentSnapshots,
  formatSnapshotValue,
  labelForField,
} from '@/lib/orchestration/agent-version-diff';

describe('labelForField', () => {
  it('maps known camelCase keys to friendly labels', () => {
    expect(labelForField('systemInstructions')).toBe('System instructions');
    expect(labelForField('monthlyBudgetUsd')).toBe('Monthly budget (USD)');
    expect(labelForField('enableImageInput')).toBe('Image input');
  });

  it('falls back to a generated label for unknown keys', () => {
    // camelCase → title case for readability when a new snapshot
    // field lands before we add a hand-written label.
    expect(labelForField('someNewField')).toBe('Some New Field');
    expect(labelForField('xyz')).toBe('Xyz');
  });
});

describe('formatSnapshotValue', () => {
  it('renders null/undefined/empty as an em-dash', () => {
    expect(formatSnapshotValue(null)).toBe('—');
    expect(formatSnapshotValue(undefined)).toBe('—');
    expect(formatSnapshotValue('')).toBe('—');
    expect(formatSnapshotValue([])).toBe('—');
  });

  it('renders booleans as On/Off', () => {
    expect(formatSnapshotValue(true)).toBe('On');
    expect(formatSnapshotValue(false)).toBe('Off');
  });

  it('renders arrays as comma-separated values', () => {
    expect(formatSnapshotValue(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('renders plain objects as JSON', () => {
    expect(formatSnapshotValue({ k: 'v' })).toBe('{"k":"v"}');
  });

  it('passes primitives through as strings', () => {
    expect(formatSnapshotValue(42)).toBe('42');
    expect(formatSnapshotValue('hello')).toBe('hello');
  });
});

describe('diffAgentSnapshots', () => {
  const baseSnapshot = {
    model: 'gpt-4o-mini',
    provider: 'openai',
    temperature: 0.7,
    maxTokens: 4096,
    systemInstructions: 'You are helpful.',
    knowledgeCategories: ['docs', 'faq'],
    enableImageInput: false,
  };

  it('reports only changed fields', () => {
    const after = { ...baseSnapshot, temperature: 0.9, enableImageInput: true };
    const changes = diffAgentSnapshots(after, baseSnapshot);
    expect(changes.map((c) => c.field).sort()).toEqual(['enableImageInput', 'temperature']);
  });

  it('captures before/after values verbatim', () => {
    const after = { ...baseSnapshot, model: 'gpt-4o' };
    const [change] = diffAgentSnapshots(after, baseSnapshot);
    expect(change.field).toBe('model');
    expect(change.before).toBe('gpt-4o-mini');
    expect(change.after).toBe('gpt-4o');
  });

  it('deep-equals arrays (order matters)', () => {
    const after = { ...baseSnapshot, knowledgeCategories: ['faq', 'docs'] };
    const changes = diffAgentSnapshots(after, baseSnapshot);
    // Re-ordered array is treated as a change — matches how the
    // diff is rendered to the operator.
    expect(changes.map((c) => c.field)).toContain('knowledgeCategories');
  });

  it('treats identical arrays as unchanged', () => {
    const after = { ...baseSnapshot, knowledgeCategories: ['docs', 'faq'] };
    expect(diffAgentSnapshots(after, baseSnapshot)).toEqual([]);
  });

  it('treats every field as changed when before is null (initial version)', () => {
    const changes = diffAgentSnapshots(baseSnapshot, null);
    // Every key from `after` should appear as a change with before = null.
    expect(changes.length).toBe(Object.keys(baseSnapshot).length);
    for (const change of changes) {
      expect(change.before).toBeNull();
    }
  });

  it('surfaces keys present in only one snapshot', () => {
    // Field added in this version: `provider` previously absent.
    const before = { model: 'gpt-4o-mini' };
    const after = { model: 'gpt-4o-mini', provider: 'openai' };
    const changes = diffAgentSnapshots(after, before);
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('provider');
    expect(changes[0].before).toBeUndefined();
    expect(changes[0].after).toBe('openai');

    // Field removed: present before, absent now.
    const removedChanges = diffAgentSnapshots(
      { model: 'gpt-4o-mini' },
      { model: 'gpt-4o-mini', provider: 'openai' }
    );
    expect(removedChanges).toHaveLength(1);
    expect(removedChanges[0].field).toBe('provider');
    expect(removedChanges[0].before).toBe('openai');
    expect(removedChanges[0].after).toBeUndefined();
  });

  it('places well-known fields ahead of unknown ones', () => {
    const before = {
      model: 'old-model',
      experimentalThing: 'a',
      systemInstructions: 'before',
    };
    const after = {
      model: 'new-model',
      experimentalThing: 'b',
      systemInstructions: 'after',
    };
    const order = diffAgentSnapshots(after, before).map((c) => c.field);
    // Known fields (model, systemInstructions) come before unknowns.
    expect(order.indexOf('model')).toBeLessThan(order.indexOf('experimentalThing'));
    expect(order.indexOf('systemInstructions')).toBeLessThan(order.indexOf('experimentalThing'));
  });
});
