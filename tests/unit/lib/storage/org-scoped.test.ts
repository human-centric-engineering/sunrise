import { describe, it, expect, vi } from 'vitest';
import { excludeOrgKeys, scopeStorageToOrg } from '@/lib/storage/org-scoped';
import { getStorageCapabilities } from '@/lib/storage/providers/types';
import type { StorageObject, StorageProvider } from '@/lib/storage/providers/types';

const ORG = 'org1';
const IN_ORG = `orgs/${ORG}/report.pdf`;
const OUT_OF_ORG = [
  ['another org', 'orgs/other/report.pdf'],
  ['a sibling org sharing the id prefix', `orgs/${ORG}x/report.pdf`],
  ['a legacy unprefixed key', 'agent-uploads/agent1/report.pdf'],
  ['an avatar', 'avatars/u1/me.png'],
  ['a bare org segment', `orgs/${ORG}`],
] as const;

const STORED: StorageObject = { key: IN_ORG, body: Buffer.from('x'), size: 1 };

function makeInner() {
  return {
    name: 'fake',
    capabilities: { privateObjects: true, signedUrls: true, download: true },
    upload: vi.fn().mockResolvedValue({ key: IN_ORG, url: 'u', size: 1 }),
    delete: vi.fn().mockResolvedValue({ success: true, key: IN_ORG }),
    deletePrefix: vi.fn().mockResolvedValue({ success: true, key: `orgs/${ORG}/` }),
    getSignedUrl: vi.fn().mockResolvedValue('https://signed'),
    download: vi.fn().mockResolvedValue(STORED),
  };
}

const buf = Buffer.from('data');
const uploadOpts = (key: string) => ({ key, contentType: 'application/pdf' });

/** Each method as a thunk taking a key, so refusal cases run uniformly. */
const methods = (s: StorageProvider) =>
  [
    ['upload', (k: string) => s.upload(buf, uploadOpts(k))],
    ['delete', (k: string) => s.delete(k)],
    ['deletePrefix', (k: string) => s.deletePrefix(k)],
    ['getSignedUrl', (k: string) => s.getSignedUrl!(k, 60)],
    ['download', (k: string) => s.download!(k)],
  ] as const;

describe('lib/storage/org-scoped', () => {
  describe('refusal outside the org', () => {
    for (const [methodName] of methods(makeInner())) {
      describe(methodName, () => {
        it.each(OUT_OF_ORG)(
          'rejects (not throws) for %s and never reaches the inner provider',
          async (_label, key) => {
            const inner = makeInner();
            const scoped = scopeStorageToOrg(inner, ORG);
            const call = methods(scoped).find(([n]) => n === methodName)![1];

            let pending: Promise<unknown> | undefined;
            expect(() => {
              pending = call(key);
            }).not.toThrow();
            await expect(pending).rejects.toThrow(/refused.*outside this org's prefix/);

            expect(inner[methodName]).not.toHaveBeenCalled();
          }
        );

        it('names the offending key in the error', async () => {
          const scoped = scopeStorageToOrg(makeInner(), ORG);
          const call = methods(scoped).find(([n]) => n === methodName)![1];
          await expect(call('orgs/other/z')).rejects.toThrow('orgs/other/z');
        });
      });
    }
  });

  describe('blob URLs', () => {
    const URL_BASE = 'https://x.public.blob.vercel-storage.com';

    it('accepts delete of a blob URL whose path is inside the org and forwards it unchanged', async () => {
      const inner = makeInner();
      const url = `${URL_BASE}/orgs/${ORG}/f.pdf`;

      await scopeStorageToOrg(inner, ORG).delete(url);

      expect(inner.delete).toHaveBeenCalledWith(url);
    });

    it('refuses delete of a blob URL under another org without reaching the provider', async () => {
      const inner = makeInner();

      await expect(
        scopeStorageToOrg(inner, ORG).delete(`${URL_BASE}/orgs/c/f.pdf`)
      ).rejects.toThrow(/outside this org/i);

      expect(inner.delete).not.toHaveBeenCalled();
    });
  });

  describe('pass-through for in-org keys', () => {
    it('upload forwards the same buffer and options and returns the inner result', async () => {
      const inner = makeInner();
      const opts = { ...uploadOpts(IN_ORG), public: false, metadata: { a: 'b' } };

      const result = await scopeStorageToOrg(inner, ORG).upload(buf, opts);

      expect(inner.upload).toHaveBeenCalledTimes(1);
      expect(inner.upload).toHaveBeenCalledWith(buf, opts);
      expect(result.key).toBe(IN_ORG);
    });

    it('delete forwards the key', async () => {
      const inner = makeInner();
      await scopeStorageToOrg(inner, ORG).delete(IN_ORG);
      expect(inner.delete).toHaveBeenCalledWith(IN_ORG);
    });

    it('deletePrefix accepts the org prefix itself and forwards it', async () => {
      const inner = makeInner();
      await scopeStorageToOrg(inner, ORG).deletePrefix(`orgs/${ORG}/`);
      expect(inner.deletePrefix).toHaveBeenCalledWith(`orgs/${ORG}/`);
    });

    it('download forwards the key', async () => {
      const inner = makeInner();
      await scopeStorageToOrg(inner, ORG).download!(IN_ORG);
      expect(inner.download).toHaveBeenCalledWith(IN_ORG);
    });

    it('getSignedUrl forwards key and expiry', async () => {
      const inner = makeInner();
      await scopeStorageToOrg(inner, ORG).getSignedUrl!(IN_ORG, 120);
      expect(inner.getSignedUrl).toHaveBeenCalledWith(IN_ORG, 120, expect.anything());
    });
  });

  describe('signing is always bound to the wrapper org', () => {
    it('passes { orgId } as the third argument', async () => {
      const inner = makeInner();
      await scopeStorageToOrg(inner, ORG).getSignedUrl!(IN_ORG, 60);
      expect(inner.getSignedUrl).toHaveBeenCalledWith(IN_ORG, 60, { orgId: ORG });
    });

    it('ignores caller-supplied options naming another org', async () => {
      const inner = makeInner();
      const scoped = scopeStorageToOrg(inner, ORG);
      // The interface allows a third argument; a caller trying to sign for
      // another org through the wrapper must not get it through.
      await scoped.getSignedUrl!(IN_ORG, 60, { orgId: 'other' });
      expect(inner.getSignedUrl).toHaveBeenCalledTimes(1);
      expect(inner.getSignedUrl.mock.calls[0][2]).toEqual({ orgId: ORG });
    });
  });

  describe('optional members and capabilities', () => {
    it('defines no getSignedUrl or download when the inner provider lacks them', () => {
      const blobShaped: StorageProvider = {
        name: 'vercel-blob',
        capabilities: { privateObjects: false },
        upload: vi.fn(),
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      };

      const scoped = scopeStorageToOrg(blobShaped, ORG);

      expect(scoped.getSignedUrl).toBeUndefined();
      expect(scoped.download).toBeUndefined();
      expect('getSignedUrl' in scoped).toBe(false);
      expect('download' in scoped).toBe(false);
    });

    it('copies name and leaves capabilities resolving identically', () => {
      const inner = makeInner();
      const scoped = scopeStorageToOrg(inner, ORG);

      expect(scoped.name).toBe('fake');
      expect(getStorageCapabilities(scoped)).toEqual(getStorageCapabilities(inner));
      expect(getStorageCapabilities(scoped).signedUrls).toBe(true);
    });

    it('resolves default (all-false) capabilities when the inner declares none', () => {
      const bare: StorageProvider = {
        name: 'bare',
        upload: vi.fn(),
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      };
      const scoped = scopeStorageToOrg(bare, ORG);

      expect('capabilities' in scoped).toBe(false);
      expect(getStorageCapabilities(scoped)).toEqual(getStorageCapabilities(bare));
    });
  });

  describe('this binding', () => {
    class ClassProvider implements StorageProvider {
      name = 'class-based';
      private readonly secret = 'secret-from-this';
      upload = vi.fn();
      delete = vi.fn();
      deletePrefix = vi.fn();
      async getSignedUrl(key: string, _expiresIn: number): Promise<string> {
        return `${this.secret}:${key}`;
      }
      async download(key: string): Promise<StorageObject> {
        return { key, body: Buffer.from(this.secret), size: this.secret.length };
      }
    }

    it('keeps this for getSignedUrl and download on a class-based inner provider', async () => {
      const scoped = scopeStorageToOrg(new ClassProvider(), ORG);

      await expect(scoped.getSignedUrl!(IN_ORG, 60)).resolves.toBe(`secret-from-this:${IN_ORG}`);
      const obj = await scoped.download!(IN_ORG);
      expect(obj.body.toString()).toBe('secret-from-this');
    });
  });

  describe('construction', () => {
    it.each(['', 'a/b'])('throws for an unusable org id %j', (id) => {
      expect(() => scopeStorageToOrg(makeInner(), id)).toThrow();
    });
  });

  describe('excludeOrgKeys (the unbound guard)', () => {
    const RESERVED = [
      ['an org key', 'orgs/a/x'],
      ['a capitalised root', 'Orgs/a/x'],
      ['an empty org segment', 'orgs//a/x'],
    ] as const;

    for (const [methodName] of methods(makeInner())) {
      describe(methodName, () => {
        it.each(RESERVED)(
          'rejects (not throws) for %s and never reaches the inner provider',
          async (_label, key) => {
            const inner = makeInner();
            const guarded = excludeOrgKeys(inner);
            const call = methods(guarded).find(([n]) => n === methodName)![1];

            let pending: Promise<unknown> | undefined;
            expect(() => {
              pending = call(key);
            }).not.toThrow();
            await expect(pending).rejects.toThrow(/refused.*reserved orgs\/ root/);

            expect(inner[methodName]).not.toHaveBeenCalled();
          }
        );
      });
    }

    it.each(['orgs', 'org'])(
      'refuses deletePrefix(%j), a prefix of the root that would sweep every org',
      async (prefix) => {
        const inner = makeInner();

        await expect(excludeOrgKeys(inner).deletePrefix(prefix)).rejects.toThrow(
          /reserved orgs\/ root/
        );

        expect(inner.deletePrefix).not.toHaveBeenCalled();
      }
    );

    it('refuses to delete a blob URL whose path is under /orgs/b/', async () => {
      const inner = makeInner();

      await expect(
        excludeOrgKeys(inner).delete('https://x.public.blob.vercel-storage.com/orgs/b/f.pdf')
      ).rejects.toThrow(/reserved orgs\/ root/);

      expect(inner.delete).not.toHaveBeenCalled();
    });

    it('passes an unowned key through to every method', async () => {
      const inner = makeInner();
      const guarded = excludeOrgKeys(inner);
      const key = 'avatars/u/a.jpg';
      const opts = uploadOpts(key);

      await guarded.upload(buf, opts);
      await guarded.delete(key);
      await guarded.deletePrefix('avatars/u/');
      await guarded.download!(key);

      expect(inner.upload).toHaveBeenCalledWith(buf, opts);
      expect(inner.delete).toHaveBeenCalledWith(key);
      expect(inner.deletePrefix).toHaveBeenCalledWith('avatars/u/');
      expect(inner.download).toHaveBeenCalledWith(key);
    });

    it('signs an unowned key with empty options (no org) and ignores caller options', async () => {
      const inner = makeInner();
      await excludeOrgKeys(inner).getSignedUrl!('avatars/u/a.jpg', 60, { orgId: 'sneaky' });

      expect(inner.getSignedUrl).toHaveBeenCalledTimes(1);
      expect(inner.getSignedUrl).toHaveBeenCalledWith('avatars/u/a.jpg', 60, {});
    });

    it('omits getSignedUrl and download when the inner provider lacks them', () => {
      const bare: StorageProvider = {
        name: 'bare',
        upload: vi.fn(),
        delete: vi.fn(),
        deletePrefix: vi.fn(),
      };
      const guarded = excludeOrgKeys(bare);
      expect('getSignedUrl' in guarded).toBe(false);
      expect('download' in guarded).toBe(false);
    });
  });
});
