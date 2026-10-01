/**
 * The (slug, credential identity) key the provider client cache, the circuit
 * breakers and the in-flight counter share (§120 t-744).
 */

import { describe, it, expect } from 'vitest';
import { credentialKey, slugOfCredentialKey } from '@/lib/orchestration/llm/credential-key';

describe('credentialKey', () => {
  it('is the bare slug for the shared credential, so every existing key is unchanged at rest', () => {
    expect(credentialKey('anthropic', '')).toBe('anthropic');
  });

  it('joins a non-empty identity, so two orgs on one row get two keys', () => {
    expect(credentialKey('anthropic', 'org:a')).toBe('anthropic#org:a');
    expect(credentialKey('anthropic', 'org:a')).not.toBe(credentialKey('anthropic', 'org:b'));
  });
});

describe('slugOfCredentialKey', () => {
  it('recovers the slug from either form', () => {
    expect(slugOfCredentialKey('anthropic')).toBe('anthropic');
    expect(slugOfCredentialKey('anthropic#org:a')).toBe('anthropic');
  });

  it('does not confuse a slug that merely shares a prefix', () => {
    expect(slugOfCredentialKey('anthropic-eu#org:a')).toBe('anthropic-eu');
  });
});
