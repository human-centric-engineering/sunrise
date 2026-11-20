/**
 * App model pins registration (§136 t-1067).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `lib/orchestration/model-lifecycle/app-pins.ts` calls this once,
 * lazily, before the first read of a model's uses or the first move.
 *
 * Use it when your app names models in its own code or tables, so a model's
 * page, its delete check, config health and the move to a replacement count
 * your uses too, and so your app can stop a move it is not ready for:
 *
 *   import { prisma } from '@/lib/db/client';
 *   import { formatModelPin } from '@/lib/orchestration/llm/model-pin';
 *   import {
 *     registerModelMoveCheck,
 *     registerModelPinReporter,
 *   } from '@/lib/orchestration/model-lifecycle/app-pins';
 *
 *   export function initAppModelPins(): void {
 *     // Asked once per org, inside that org's scope: read as usual.
 *     registerModelPinReporter(async ({ model }) => {
 *       const panels = await prisma.appPanel.findMany({
 *         where: { judgeModel: formatModelPin(model.providerSlug, model.modelId) },
 *         select: { name: true },
 *       });
 *       return panels.map((p) => ({ label: `Panel: ${p.name}`, where: 'Panels › Judge' }));
 *     });
 *     // Asked with every org's pins at each preview and once more just
 *     // before the move. Refuse with a reason the admin can act on; the move
 *     // then writes nothing. Run slow or billed work ahead of time and look
 *     // its result up here: the preview asks on every replacement picked.
 *     registerModelMoveCheck(async ({ replacement, pins }) => {
 *       if (pins.length === 0) return { allow: true };
 *       const result = await latestPanelEvaluation(replacement.modelId);
 *       if (!result) {
 *         return { allow: false, reason: `Run the panel evaluations on ${replacement.name} first` };
 *       }
 *       return result.passed
 *         ? { allow: true }
 *         : { allow: false, reason: `${replacement.name} failed the panel evaluations` };
 *     });
 *   }
 *
 * The reporter answers `{ label, where }[]` for the org it is asked about
 * (`{ model, orgId, signal }`); Sunrise stamps the org. Report a pin set in
 * code, the same for every org, from the install org only (`orgId ===
 * INSTALL_ORG_ID`), or it is counted once per org. Sunrise never writes your
 * pins: move them yourself, after the move.
 *
 * The check is asked `{ model, replacement, pins, phase, signal }` in the
 * admin's scope, at each preview (`phase: 'preview'`) and again at the move
 * (`'move'`), and answers `{ allow: true }` or `{ allow: false, reason }`. The
 * move's request has 300 seconds in all, the check included. It **fails closed**: one that throws, runs
 * past two minutes or answers anything else refuses the move, and so does this
 * init throwing, or the reporter failing while a check is registered. A
 * reporter failing on its own marks the app's uses as unreadable, which
 * refuses the model's delete and counts it as in use in config health.
 *
 * Empty = no app uses reported and every move allowed, as before this seam.
 *
 * Full guide: .context/orchestration/llm-providers.md (Model lifecycle) ·
 * .context/architecture/fork-init-seams.md
 */
export function initAppModelPins(): void {
  // No app model pins by default.
}
