/**
 * App sealed stores.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `lib/security/sealed-stores.ts` calls this once, lazily, before
 * it first reads its registry. If your app keeps values sealed with
 * `sealSecret()` (`lib/security/sealed-secrets.ts`), register where they are,
 * so that `npm run secrets:reseal` can move them onto a new master key before
 * the old one is removed:
 *
 *   import { prisma } from '@/lib/db/client';
 *   import { registerSealedStore } from '@/lib/security/sealed-stores';
 *
 *   export function initAppSealedStores(): void {
 *     registerSealedStore({
 *       name: 'crm-credentials',
 *       async *list() {
 *         let cursor: string | undefined;
 *         for (;;) {
 *           const page = await prisma.appCrmCredential.findMany({
 *             take: 200, orderBy: { id: 'asc' },
 *             ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
 *             select: { id: true, sealedToken: true },
 *           });
 *           for (const row of page)
 *             yield { id: row.id, sealed: row.sealedToken, purpose: `crm-token:${row.id}` };
 *           if (page.length < 200) return;
 *           cursor = page[page.length - 1].id;
 *         }
 *       },
 *       async replace(id, previous, next) {
 *         // Only if the row still holds what was read: never overwrite a newer save.
 *         const { count } = await prisma.appCrmCredential.updateMany({
 *           where: { id, sealedToken: previous },
 *           data: { sealedToken: next },
 *         });
 *         return count === 1;
 *       },
 *     });
 *   }
 *
 * Read before writing one:
 *
 *  - **`replace` must compare and swap.** Write only where the row still holds
 *    `previous`, and answer whether it wrote, so a value saved during the
 *    reseal is never overwritten with an older one.
 *  - **`purpose` must be the one the value was sealed for**, or it will not
 *    open and the reseal reports it as `mismatch`.
 *  - **It runs as the platform** (`runAsSystem`), across every org, because
 *    re-keying is install-wide.
 *  - **A throw here refuses every reseal** until it is fixed, rather than
 *    reporting success while your values stay under the old key.
 *  - **Register synchronously.** This function must not be `async`.
 *
 * Empty = today's behaviour, byte-for-byte.
 *
 * Full guide: .context/security/sealed-secrets.md · CUSTOMIZATION.md §4
 */
export function initAppSealedStores(): void {
  // No app sealed stores by default.
}
