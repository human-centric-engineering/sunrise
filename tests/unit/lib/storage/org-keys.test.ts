import { describe, it, expect } from 'vitest';
import {
  ORG_KEY_ROOT,
  isKeyInOrg,
  isUnderOrgRoot,
  orgKeyPrefix,
  orgOfKey,
} from '@/lib/storage/org-keys';

describe('lib/storage/org-keys', () => {
  describe('orgKeyPrefix', () => {
    it('builds orgs/{id}/ from the root and the id', () => {
      expect(ORG_KEY_ROOT).toBe('orgs/');
      expect(orgKeyPrefix('org_1')).toBe('orgs/org_1/');
    });

    it.each([
      ['empty', ''],
      ['a dot (resolves to the orgs/ root)', '.'],
      ['a space', ' '],
      ['containing a dot', 'a.b'],
      ['containing a slash', 'a/b'],
      ['leading slash', '/a'],
      ['trailing slash', 'a/'],
    ])('rejects an id that is %s', (_label, id) => {
      expect(() => orgKeyPrefix(id)).toThrow(/letters, digits, "_" or "-"/);
    });

    it.each([
      ['a cuid', 'cmtd5heg2001804ky8pgo6odx', 'orgs/cmtd5heg2001804ky8pgo6odx/'],
      ['the install org', 'install', 'orgs/install/'],
    ])('accepts %s', (_label, id, expected) => {
      expect(orgKeyPrefix(id)).toBe(expected);
    });
  });

  describe('isUnderOrgRoot', () => {
    it.each(['orgs/x/y', 'Orgs/x/y', 'ORGS/x', 'orgs//x'])('is true for %s', (key) => {
      expect(isUnderOrgRoot(key)).toBe(true);
    });

    it.each(['avatars/x', 'xorgs/a', 'org/x'])('is false for %s', (key) => {
      expect(isUnderOrgRoot(key)).toBe(false);
    });

    it.each(['orgs', 'org', 'or', 'o', 'ORGS', 'Org', ''])(
      'is true for %j, a prefix of the root that would match every org tree',
      (prefix) => {
        expect(isUnderOrgRoot(prefix)).toBe(true);
      }
    );

    it('judges a full blob URL by its path: true under orgs/', () => {
      expect(isUnderOrgRoot('https://x.public.blob.vercel-storage.com/orgs/b/f.pdf')).toBe(true);
    });

    it.each(['avatars/u/x', 'xorgs/b/x'])(
      'judges a full blob URL by its path: false for %s',
      (path) => {
        expect(isUnderOrgRoot(`https://x.public.blob.vercel-storage.com/${path}`)).toBe(false);
      }
    );
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

  describe('orgOfKey with an id no org prefix could hold', () => {
    it.each(['orgs/a b/x', 'orgs/a.b/x'])('returns null for %s', (key) => {
      expect(orgOfKey(key)).toBeNull();
    });
  });

  describe('isKeyInOrg', () => {
    it('accepts a blob URL whose path is inside the org', () => {
      expect(isKeyInOrg('https://x.public.blob.vercel-storage.com/orgs/a/f.pdf', 'a')).toBe(true);
    });

    it('rejects a blob URL whose path is in another org', () => {
      expect(isKeyInOrg('https://x.public.blob.vercel-storage.com/orgs/b/f.pdf', 'a')).toBe(false);
    });

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
