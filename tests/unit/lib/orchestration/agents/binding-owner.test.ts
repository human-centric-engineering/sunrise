/**
 * Tests: bindingOwnerAfterWrite — the rule every route that writes provider or
 * model uses to make the binding the org's (t-798).
 *
 * @see lib/orchestration/agents/binding-owner.ts
 */
import { describe, expect, it } from 'vitest';

import { bindingOwnerAfterWrite } from '@/lib/orchestration/agents/binding-owner';

const current = { provider: 'anthropic', model: 'claude' };

describe('bindingOwnerAfterWrite', () => {
  it('makes the binding the org’s when a write changes provider or model', () => {
    expect(bindingOwnerAfterWrite(current, { provider: 'openai' })).toBe('org');
    expect(bindingOwnerAfterWrite(current, { model: 'claude-2' })).toBe('org');
    // Both at once, as the form sends them.
    expect(bindingOwnerAfterWrite(current, { provider: 'openai', model: 'gpt-5' })).toBe('org');
  });

  it('changes nothing when the write leaves both as they were, or does not send them', () => {
    expect(bindingOwnerAfterWrite(current, { provider: 'anthropic', model: 'claude' })).toBe(
      undefined
    );
    expect(bindingOwnerAfterWrite(current, {})).toBe(undefined);
  });
});
