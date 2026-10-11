import { describe, it, expect } from 'vitest';
import { ORG_KEY_ROOT, isKeyInOrg, orgKeyPrefix, orgOfKey } from '@/lib/storage/org-keys';

describe('lib/storage/org-keys', () => {
  describe('orgKeyPrefix', () => {
    it('builds orgs/{id}/ from the root and the id', () => {
      expect(ORG_KEY_ROOT).toBe('orgs/');
      expect(orgKeyPrefix('org_1')).toBe('orgs/org_1/');
    });

    it.each([
      ['empty', ''],
      ['containing a slash', 'a/b'],
      ['leading slash', '/a'],
      ['trailing slash', 'a/'],
    ])('rejects an id that is %s', (_label, id) => {
      expect(() => orgKeyPrefix(id)).toThrow(/no "\/" in it/);
    });
  });

  describe('orgOfKey', () => {
    it('returns the org segment for an org-owned key', () => {
      expect(orgOfKey('orgs/a/x')).toBe('a');
      expect(orgOfKey('orgs/org_1/deep/nested/file.png')).toBe('org_1');
    });

    it.each([
      ['an avatar', 'avatars/u/x'],
      ['a legacy agent upload', 'agent-uploads/agent1/x.pdf'],
      ['the bare root', 'orgs/'],
      ['an empty org segment', 'orgs//x'],
      ['an org with no trailing segment', 'orgs/a'],
      ['an unrelated key that merely contains orgs/', 'x/orgs/a/y'],
    ])('returns null for %s', (_label, key) => {
      expect(orgOfKey(key)).toBeNull();
    });
  });

  describe('isKeyInOrg', () => {
    it('accepts a key under the org prefix', () => {
      expect(isKeyInOrg('orgs/a/x', 'a')).toBe(true);
    });

    it('accepts the org prefix itself (what erasure deletes)', () => {
      expect(isKeyInOrg('orgs/a/', 'a')).toBe(true);
    });

    it('rejects a sibling org whose id starts with the same characters', () => {
      expect(isKeyInOrg('orgs/ab/x', 'a')).toBe(false);
    });

    it('rejects another org, an avatar and a legacy key', () => {
      expect(isKeyInOrg('orgs/b/x', 'a')).toBe(false);
      expect(isKeyInOrg('avatars/a/x', 'a')).toBe(false);
      expect(isKeyInOrg('agent-uploads/a/x', 'a')).toBe(false);
    });

    it('rejects the bare org segment without the trailing slash', () => {
      expect(isKeyInOrg('orgs/a', 'a')).toBe(false);
    });

    it('throws for an unusable org id rather than matching everything', () => {
      expect(() => isKeyInOrg('orgs/a/x', '')).toThrow();
    });
  });
});
