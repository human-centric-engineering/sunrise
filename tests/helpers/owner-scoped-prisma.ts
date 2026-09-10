/**
 * Prisma fakes that honour the query's own owner clause.
 *
 * The problem these solve is that `mockResolvedValue(foreignRow)` hands the
 * route a row whatever it asked for. A test written against that mock —
 * "another user owns it, so expect 404" — passes just as well when the route
 * has no owner filter at all, because the assertion has no way to fail. These
 * fakes apply `where.createdBy` the way the database would, so deleting the
 * filter from a route turns its ownership tests red.
 *
 * They understand exactly two clauses, `id` and `createdBy`, and ignore the
 * rest: they exist to prove the ownership boundary, not to reimplement Prisma.
 * A clause absent from the query matches every row — which is precisely how an
 * unscoped route ends up returning a foreign one.
 *
 * **`skip`, `take` and `orderBy` are ignored too**, so `ownerScopedFindMany`
 * returns the whole matching set and `ownerScopedCount` counts it unpaged. A
 * test that also wants to assert page size or ordering will pass here whatever
 * the route does with them — assert those against the call arguments, or use a
 * different fake.
 */

/**
 * The subset of a `where` these fakes interpret.
 *
 * **Two owner columns, because the tree has two.** `AiExperiment` and the
 * webhooks family key on `createdBy`; the evaluations family — datasets,
 * sessions, runs — keys on `userId`. A fake that knew only one silently
 * matched every row of the other model and reported a leak as a pass. Adding a
 * model with a third spelling means adding it to {@link OWNER_COLUMNS}, and
 * the test that forgets will fail loudly rather than pass blindly.
 *
 * A null owner value means IS NULL — the ownerless row — not "no clause".
 * `AND` and `OR` are understood because routes build the visible set as
 * `{ AND: [ownerClause, filters] }` where `ownerClause` may itself be
 * `{ OR: [{ owner: me }, { owner: null }] }`.
 */
export interface OwnerScopedWhere {
  id?: string;
  createdBy?: string | null;
  userId?: string | null;
  AND?: OwnerScopedWhere[];
  OR?: OwnerScopedWhere[];
}

/** A row addressable by these fakes: an id, and whichever owner column it uses. */
export interface OwnedRow {
  id: string;
  createdBy?: string | null;
  userId?: string | null;
}

/** The owner columns in this tree. Add a spelling here when a model adds one. */
const OWNER_COLUMNS = ['createdBy', 'userId'] as const;

function matches(row: OwnedRow, where: OwnerScopedWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;

  // `!== undefined` rather than a truthiness test: a null owner is a real
  // clause (IS NULL), and treating it as "absent" would match every row.
  for (const column of OWNER_COLUMNS) {
    const wanted = where[column];
    if (wanted !== undefined && (row[column] ?? null) !== wanted) return false;
  }

  if (where.AND !== undefined && !where.AND.every((clause) => matches(row, clause))) return false;
  if (where.OR !== undefined && !where.OR.some((clause) => matches(row, clause))) return false;
  return true;
}

function select<T extends OwnedRow>(rows: readonly T[], args?: { where?: OwnerScopedWhere }): T[] {
  return rows.filter((row) => matches(row, args?.where ?? {}));
}

/** Stands in for `findFirst` / `findUnique`: the first matching row, else `null`. */
export function ownerScopedFindFirst<T extends OwnedRow>(rows: readonly T[]) {
  return (args?: { where?: OwnerScopedWhere }): Promise<T | null> =>
    Promise.resolve(select(rows, args)[0] ?? null);
}

/** Stands in for `findMany`: every matching row, in the order given. */
export function ownerScopedFindMany<T extends OwnedRow>(rows: readonly T[]) {
  return (args?: { where?: OwnerScopedWhere }): Promise<T[]> => Promise.resolve(select(rows, args));
}

/**
 * Stands in for `count`. Pass the same rows as the `findMany` fake: a total
 * computed from a different `where` than the page is the leak that survives
 * every test asserting the page itself is correct.
 */
export function ownerScopedCount<T extends OwnedRow>(rows: readonly T[]) {
  return (args?: { where?: OwnerScopedWhere }): Promise<number> =>
    Promise.resolve(select(rows, args).length);
}
