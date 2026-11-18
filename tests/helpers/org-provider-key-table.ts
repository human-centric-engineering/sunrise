/**
 * An in-memory `AiOrgProviderKey` delegate for unit tests (§137 t-1044).
 *
 * Implements only the calls `lib/orchestration/llm/org-provider-keys.ts`
 * makes, with the semantics that matter to it: the (orgId, providerConfigId)
 * unique key, `version: { increment }` on update, a compare-and-swap
 * `updateMany`, cursor paging, and the `providerConfig` relation's select
 * (from {@link createTable}'s `providers`, which a test fills; t-1045). Each method is a `vi.fn`, so a test can
 * count reads or make one fail.
 *
 * Usage, in a `vi.mock` factory (the helper module is one instance per test
 * file, so the factory and the test share the table):
 *
 *   vi.mock('@/lib/db/client', async () => ({
 *     prisma: { aiOrgProviderKey: (await import('@/tests/helpers/org-provider-key-table')).orgKeyTable.delegate },
 *   }));
 */

import { vi } from 'vitest';

export interface OrgKeyRow {
  id: string;
  orgId: string;
  providerConfigId: string;
  sealedKey: string;
  version: number;
  hint: string;
  savedById: string | null;
  savedAt: Date;
  createdAt: Date;
}

type Where = Partial<Pick<OrgKeyRow, 'id' | 'orgId' | 'providerConfigId' | 'sealedKey'>>;

/** A provider row a key's `providerConfig` relation selects from. */
export interface ProviderRelationRow {
  name: string;
  slug: string;
}

/** `{ field: true }`, or `{ providerConfig: { select: { … } } }` for the relation. */
type Select = Record<string, boolean | { select: Record<string, boolean> }>;

function pick(
  row: OrgKeyRow,
  select: Select | undefined,
  providers: ReadonlyMap<string, ProviderRelationRow>
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const [field, on] of Object.entries(select)) {
    if (field === 'providerConfig' && typeof on === 'object') {
      const provider = providers.get(row.providerConfigId);
      if (!provider) throw new Error(`No provider relation row for ${row.providerConfigId}`);
      out[field] = Object.fromEntries(
        Object.entries(on.select)
          .filter(([, wanted]) => wanted)
          .map(([key]) => [key, provider[key as keyof ProviderRelationRow]])
      );
    } else if (on) {
      out[field] = row[field as keyof OrgKeyRow];
    }
  }
  return out;
}

function matches(row: OrgKeyRow, where: Where = {}): boolean {
  return Object.entries(where).every(([field, value]) => row[field as keyof OrgKeyRow] === value);
}

function createTable() {
  const rows = new Map<string, OrgKeyRow>();
  /** What `select: { providerConfig: … }` reads, by provider row id: set by a test that needs it. */
  const providers = new Map<string, ProviderRelationRow>();
  let seq = 0;

  const find = (orgId: string, providerConfigId: string) =>
    [...rows.values()].find((r) => r.orgId === orgId && r.providerConfigId === providerConfigId);

  const delegate = {
    findUnique: vi.fn(
      async (args: {
        where: { orgId_providerConfigId: { orgId: string; providerConfigId: string } };
        select?: Select;
      }) => {
        const { orgId, providerConfigId } = args.where.orgId_providerConfigId;
        const row = find(orgId, providerConfigId);
        return row ? pick(row, args.select, providers) : null;
      }
    ),
    upsert: vi.fn(
      async (args: {
        where: { orgId_providerConfigId: { orgId: string; providerConfigId: string } };
        create: Omit<OrgKeyRow, 'id' | 'version' | 'createdAt'>;
        update: Pick<OrgKeyRow, 'sealedKey' | 'hint' | 'savedById' | 'savedAt'> & {
          version: { increment: number };
        };
        select?: Select;
      }) => {
        const { orgId, providerConfigId } = args.where.orgId_providerConfigId;
        let row = find(orgId, providerConfigId);
        if (row) {
          const { version, ...rest } = args.update;
          Object.assign(row, rest, { version: row.version + version.increment });
        } else {
          seq += 1;
          row = { id: `key${seq}`, version: 1, createdAt: new Date(), ...args.create };
          rows.set(row.id, row);
        }
        return pick(row, args.select, providers);
      }
    ),
    deleteMany: vi.fn(async (args: { where: Where }) => {
      let count = 0;
      for (const row of [...rows.values()]) {
        if (matches(row, args.where)) {
          rows.delete(row.id);
          count += 1;
        }
      }
      return { count };
    }),
    updateMany: vi.fn(async (args: { where: Where; data: Partial<OrgKeyRow> }) => {
      let count = 0;
      for (const row of rows.values()) {
        if (matches(row, args.where)) {
          Object.assign(row, args.data);
          count += 1;
        }
      }
      return { count };
    }),
    count: vi.fn(
      async (args: { where?: Where } = {}) =>
        [...rows.values()].filter((row) => matches(row, args.where)).length
    ),
    findMany: vi.fn(
      async (
        args: {
          where?: Where;
          select?: Select;
          distinct?: Array<keyof OrgKeyRow>;
          take?: number;
          skip?: number;
          cursor?: { id: string };
        } = {}
      ) => {
        let list = [...rows.values()]
          .filter((row) => matches(row, args.where))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (args.cursor) {
          const at = list.findIndex((row) => row.id === args.cursor!.id);
          list = list.slice(at + (args.skip ?? 0));
        }
        if (args.distinct) {
          const seen = new Set<string>();
          list = list.filter((row) => {
            const key = args.distinct!.map((field) => String(row[field])).join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (args.take !== undefined) list = list.slice(0, args.take);
        return list.map((row) => pick(row, args.select, providers));
      }
    ),
  };

  return {
    rows,
    providers,
    delegate,
    /** The row for an org and provider row, as stored. */
    get(orgId: string, providerConfigId: string): OrgKeyRow | undefined {
      return find(orgId, providerConfigId);
    },
    clear(): void {
      rows.clear();
      providers.clear();
      seq = 0;
      for (const fn of Object.values(delegate)) fn.mockClear();
    },
  };
}

export const orgKeyTable = createTable();
