# Sealed secrets

Some credentials have to be stored and read back later: an org's own AI vendor
key (§137), an ad-platform token, a CRM refresh token. Whoever holds one can
act in someone else's account, so a database dump or a backup must not hand it
over. Seal the value before you write it, and open it at the moment you use it.

A webhook signing secret is not this. It only signs our own requests and HMAC
needs the original on both sides, so it stays in plaintext beside its
destination.

## Quick reference

| Need                                   | Where                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| Seal a value before writing it         | `await sealSecret(plaintext, purpose)`, `lib/security/sealed-secrets.ts`           |
| Open it when you use it                | `await openSecret(sealed, purpose)`                                                |
| Can this install store secrets at all? | `isSealedSecretKeyConfigured()`                                                    |
| Is a stored value on the current key?  | `needsReseal(sealed)`, from its header alone                                       |
| Tell the reseal where your values live | `registerSealedStore()` from `initAppSealedStores()` in `lib/app/sealed-stores.ts` |
| Move every value onto a new master key | `npm run secrets:reseal` (`-- --dry-run` to count first)                           |
| The master keys                        | `SEALED_SECRET_KEYS`, `SEALED_SECRET_ACTIVE_KEY`, `SEALED_SECRET_LEGACY_KEY`       |
| Why a value would not open             | `SealedSecretOpenError.reason`: `format`, `unknown_key`, `mismatch`                |
| No keyring configured                  | `SealedSecretKeyMissingError`, from every seal and open                            |

### Anti-patterns

- **Falling back to plaintext when no key is configured.** Both functions throw
  `SealedSecretKeyMissingError`. Turn that into "this cannot be saved" for the
  person saving, never into writing the value unsealed.
- **One purpose for everything.** The purpose is authenticated, so a value only
  opens for the purpose it was sealed for. Include the owner where there is
  one, e.g. `org-provider-key:<orgId>:<providerId>`. A value copied onto
  another org's row then fails to open there.
- **Logging the error with the value.** No error this module throws contains
  the plaintext, a key or the envelope. Keep it that way at the call site: log
  the row id and `reason`.
- **Removing an old key before resealing.** Every value still under it stops
  opening (`unknown_key`). Run the reseal, and remove the key only after a
  clean run.
- **A store whose `replace` overwrites unconditionally.** A value someone saves
  during the reseal would be replaced by an older one. Write only where the row
  still holds `previous`.

## The master keys

Three variables, checked together at boot. A broken keyring stops the app
starting, and the error names the variable without printing any secret.

```bash
SEALED_SECRET_KEYS="k2026:<openssl rand -base64 32>,k2025:<the old one>"
SEALED_SECRET_ACTIVE_KEY="k2026"
# Only if you have values sealed before key ids existed:
SEALED_SECRET_LEGACY_KEY="k2025"
```

- **`SEALED_SECRET_KEYS`** holds every key that may still open a value. An id
  is lowercase letters, digits and hyphens, at most 32 characters. A secret is
  at least 32 characters with no comma. Each is hashed with SHA-256 to the 32
  bytes AES-256 needs.
- **`SEALED_SECRET_ACTIVE_KEY`** says which key seals new values. It is
  required even with one key, so that reordering the list never rotates the key
  silently.
- **`SEALED_SECRET_LEGACY_KEY`** names the key that first-format values open
  under (below).

All three unset is the shipped state: nothing can be sealed.

## The envelope

```
v2.<keyId>.<iv>.<tag>.<ciphertext>          iv, tag, ciphertext: base64url
```

AES-256-GCM with a fresh 12-byte IV per value and a 16-byte tag. The format,
the key id and the purpose are all authenticated, so changing any of them, or
one byte of the value, makes it refuse to open (`mismatch`).

**The first format, `v1.<iv>.<tag>.<ciphertext>`**, is the one ConQuest's
`secret-box.ts` wrote. It names no key and authenticates only the purpose.
`openSecret` still reads it, under the key `SEALED_SECRET_LEGACY_KEY` names, so
an app moving onto this helper reseals nothing. Nothing writes it any more. An
app adopting the helper puts its old key in `SEALED_SECRET_KEYS` under an id
of its choosing and names that id as the legacy key. It keeps its own
environment variable's value, not its name: core never reads a fork's env names.

## Rotating the master key

**Two deploys, not one.** Every process has to be able to open a value under
the new key before any process seals one under it. During a rolling deploy,
or on warm serverless instances, old and new processes run side by side, and a
process whose `SEALED_SECRET_KEYS` lacks the new key cannot open what the new
ones seal. A rollback would leave every such value unreadable.

1. **Add** the new key to `SEALED_SECRET_KEYS`, leaving
   `SEALED_SECRET_ACTIVE_KEY` on the old one. Deploy, and wait until no process
   runs the previous environment.
2. **Switch** `SEALED_SECRET_ACTIVE_KEY` to the new key. Deploy. New values
   seal under it, and everything stored keeps opening under its old key. A
   rollback of this step is safe: every process can still open both.
3. **Reseal.** Run `npm run secrets:reseal -- --dry-run` to see how many values
   would move, then `npm run secrets:reseal`. Outside development, run
   `npx tsx scripts/secrets/reseal.ts` where the app's environment is set.
   Run it once step 2 is fully rolled out, or a process still on the old
   active key may save values under it (the run reports those and exits `1`).
4. **Remove** the old key (and `SEALED_SECRET_LEGACY_KEY`, if it named it) once
   a run exits `0`.

| Exit | Meaning                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Every value is on the active key (or would be, on a dry run). Safe to remove old keys.                                                            |
| `1`  | Some value did not move, a store could not be read, or a value changed during the run. The report names them. Keep the old keys and run it again. |
| `2`  | It could not start: no keyring, a keyring `lib/env.ts` refused, an argument it does not know, or the app's `initAppSealedStores` threw.           |

A run is safe to repeat. A value already on the active key is not touched, and
a value someone saved during the run is left as they saved it. It still makes
the run exit `1` (`changedMeanwhile`): during a deploy, the process that saved
it may still be sealing under the old key. The next run either finds it
current or moves it.

**The report is printed, not logged**, so `LOG_LEVEL` cannot hide it. Every
report line starts `secrets:reseal `: one `secrets:reseal store {json}` per
store (counts, and each failed row as `{ id, reason }`, where `reason` is
`format`, `unknown_key`, `mismatch`, `invalid_purpose` or `write_failed`, the
last with the error's name and code; a store that could not be listed has
`error`, also a name and code), then a summary. Log lines from the run share
stdout, so pick the report out by that prefix. Nothing in it is a plaintext,
an envelope or an error message.

**Only `--dry-run` is accepted.** Anything else exits `2` without touching a
store, so a typo never turns into a writing run. `npm run secrets:reseal
--dry-run` without the `--` hands the flag to npm, and the script reads npm's
flag as the dry run it was meant to be.

**A failed app registration refuses the reseal.** If `initAppSealedStores`
throws, the registry rolls back as every seam does, and then every reseal
throws `SealedStoreRegistrationError` until it is fixed. A run that walked only
core's stores would report success with the app's values still under the old
key, and removing that key next would lose them.

## Registering a store

Each place that keeps sealed values registers how to list them and how to
replace one. The walk runs inside `runAsSystem`, because re-keying is
install-wide and at `multi` the rows belong to every org.

```ts
// lib/app/sealed-stores.ts
import { prisma } from '@/lib/db/client';
import { registerSealedStore } from '@/lib/security/sealed-stores';

export function initAppSealedStores(): void {
  registerSealedStore({
    name: 'crm-credentials',
    async *list() {
      let cursor: string | undefined;
      for (;;) {
        const page = await prisma.appCrmCredential.findMany({
          take: 200,
          orderBy: { id: 'asc' },
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: { id: true, sealedToken: true },
        });
        for (const row of page)
          yield { id: row.id, sealed: row.sealedToken, purpose: `crm-token:${row.id}` };
        if (page.length < 200) return;
        cursor = page[page.length - 1].id;
      }
    },
    async replace(id, previous, next) {
      const { count } = await prisma.appCrmCredential.updateMany({
        where: { id, sealedToken: previous },
        data: { sealedToken: next },
      });
      return count === 1;
    },
  });
}
```

Sunrise registers its own stores in core as it adds them. The first will be
the org AI key store (§137 t-1044); today none is registered.

## A managed key service

The keys come from the environment. Sealing and opening are `async` so that a
managed key service can replace the environment later without changing any
caller: the key lookup is one internal function in `sealed-secrets.ts`. It is
deliberately not a fork seam yet. It becomes one when an app needs it.

## Related

- [`lib/security/sealed-secrets.ts`](../../lib/security/sealed-secrets.ts) — the helper and its guarantees
- [`lib/security/sealed-stores.ts`](../../lib/security/sealed-stores.ts) — the registry and the reseal walk
- [`lib/security/sealed-secret-keys.ts`](../../lib/security/sealed-secret-keys.ts) — reading the keyring
- [Multi-tenancy design, Q5](../architecture/multi-tenancy-design.md) — why Sunrise now holds org keys, and when
- [Fork init seams](../architecture/fork-init-seams.md) — why a failed registration refuses
