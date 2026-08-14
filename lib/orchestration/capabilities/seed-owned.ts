/**
 * Which `AiCapability` fields belong to the seeds rather than the operator.
 *
 * A capability seed re-applies `functionDefinition`, `executionType` and
 * `executionHandler` to existing rows every time its file hash changes (#545),
 * and matches the row it is updating on `slug`. So on an `isSystem` row those
 * four columns belong to the code, and a write to any of them does not survive:
 *
 * - the three re-applied fields are silently reverted by the next re-seed — no
 *   audit entry, no log, no signal in the UI;
 * - `slug` is worse. It is the upsert's `where` key, so a rename is not
 *   reverted: the next re-seed matches nothing and **creates a second row**
 *   for one built-in.
 *
 * Either way the operator's edit is accepted, audited as a success, and then
 * quietly undone. Refusing the write is the honest answer, so both write paths
 * — `PATCH /capabilities/{id}` and the config importer — consult this module.
 *
 * **Gate on the value CHANGING, not on the field being present.** The capability
 * form PATCHes the whole form on every save: `executionType` and
 * `executionHandler` are defaulted in `useForm` and `functionDefinition` is
 * always attached. A presence check would 403 an admin who only edited the
 * description, naming three fields they never touched, and would make `name` /
 * `description` / `category` / `rateLimit` and every safety setting uneditable
 * on every built-in.
 *
 * @see .context/database/seeding.md — the ownership rule and its table
 * @see tests/unit/prisma/seeds/capability-code-owned-fields.test.ts — the seed half
 */

import { jsonEquals } from '@/lib/utils/json-equal';

/**
 * The four fields a seed owns on a system capability, in the order they are
 * reported to the operator.
 *
 * Deliberately NOT the same list as the seed-side test's `CODE_OWNED`, which
 * covers only the three fields a seed re-applies in its `update` branch. `slug`
 * is never re-applied — it is matched on — so it does not belong there, but it
 * is just as unwritable here, for the different reason above.
 */
export const SEED_OWNED_CAPABILITY_FIELDS = [
  'slug',
  'functionDefinition',
  'executionType',
  'executionHandler',
] as const;

export type SeedOwnedCapabilityField = (typeof SEED_OWNED_CAPABILITY_FIELDS)[number];

/** The stored row's shape, narrowed to what this module reads. */
export interface SeedOwnedCapabilityValues {
  slug: string;
  functionDefinition: unknown;
  executionType: string;
  executionHandler: string;
}

/**
 * The seed-owned fields an incoming write would actually change.
 *
 * Fields absent from `incoming` (value `undefined`) are not being written and
 * are skipped — a PATCH body is partial by definition. Everything else is
 * compared against the stored value with {@link jsonEquals}, which ignores
 * object key order.
 *
 * That last part is not a nicety. `functionDefinition` is a `jsonb` column:
 * Postgres canonicalises its key order on write, and Zod rebuilds the parsed
 * body in schema-declaration order — so the same definition read from the
 * database and echoed back by the form serialises to two different strings.
 * A `JSON.stringify` comparison calls that byte-identical value "changed" and
 * 403s every save, one layer below the presence-check bug.
 *
 * Returns `[]` when nothing seed-owned is changing, which is the ordinary case
 * for every save an operator makes.
 */
export function changedSeedOwnedFields(
  current: SeedOwnedCapabilityValues,
  incoming: Partial<Record<SeedOwnedCapabilityField, unknown>>
): SeedOwnedCapabilityField[] {
  return SEED_OWNED_CAPABILITY_FIELDS.filter((field) => {
    const next = incoming[field];
    if (next === undefined) return false;
    return !jsonEquals(next, current[field]);
  });
}
