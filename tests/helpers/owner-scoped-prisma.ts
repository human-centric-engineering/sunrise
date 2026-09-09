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
 */

/** The subset of a `where` these fakes interpret. */
export interface OwnerScopedWhere {
  id?: string;
  createdBy?: string;
}

/** A row addressable by these fakes. `createdBy` is nullable on `SetNull` models. */
export interface OwnedRow {
  id: string;
  createdBy: string | null;
}

function matches(row: OwnedRow, where: OwnerScopedWhere): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.createdBy !== undefined && row.createdBy !== where.createdBy) return false;
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
