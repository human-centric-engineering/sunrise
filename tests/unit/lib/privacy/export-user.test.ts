/**
 * Unit tests for lib/privacy/export-user.ts
 *
 * Contract under test:
 *   exportUserData({ userId, actorUserId, reason })
 *   1. throws SubjectNotFoundError when there is no account row
 *   2. runs every manifest source and files it by disposition
 *   3. folds in erasure receipts and the app seam
 *   4. reports scope honestly in `meta` (counts, exclusions, format version)
 *   5. fails whole rather than returning a partial bundle
 *
 * The redaction cases assert the arguments that reach Prisma rather than the
 * rows that come back. Asserting the rows would only prove the mock returned
 * what the mock was told to return; asserting `omit: { token: true }` proves
 * the manifest actually withholds the credential.
 *
 * @see lib/privacy/export-user.ts
 * @see lib/privacy/export-sources.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted so the factories below can close over them
// ---------------------------------------------------------------------------

const { mockPrisma, delegateFor, resetDelegates, mockUserFindUnique, mockLogger } = vi.hoisted(
  () => {
    interface Delegate {
      findMany: ReturnType<typeof vi.fn>;
    }

    // The manifest touches ~28 delegates. Rather than hand-declare each (and
    // silently miss one as the manifest grows), vend them on demand and keep a
    // registry the tests can inspect.
    const delegates = new Map<string, Delegate>();
    const delegateFor = (name: string): Delegate => {
      let delegate = delegates.get(name);
      if (!delegate) {
        delegate = { findMany: vi.fn().mockResolvedValue([]) };
        delegates.set(name, delegate);
      }
      return delegate;
    };

    // `vi.clearAllMocks()` clears recorded calls but NOT implementations, so a
    // `mockResolvedValue` set by one test would otherwise leak into the next —
    // and a leaked row count is the kind of thing that makes a later assertion
    // pass for the wrong reason. Re-arm the default explicitly.
    const resetDelegates = (): void => {
      for (const delegate of delegates.values()) {
        delegate.findMany.mockReset().mockResolvedValue([]);
      }
    };

    const userFindUnique = vi.fn();

    const prisma = new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property !== 'string') return undefined;
          if (property === 'user') return { findUnique: userFindUnique };
          return delegateFor(property);
        },
      }
    );

    return {
      mockPrisma: prisma,
      delegateFor,
      resetDelegates,
      mockUserFindUnique: userFindUnique,
      mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    };
  }
);

const mockInitAppSubjectSources = vi.fn();

vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockCollectAppSubjectData = vi.fn().mockResolvedValue({});
/**
 * Stubbed alongside the collector, not omitted. Leaving it out does not fail —
 * the registry catches the resulting TypeError, logs it and rolls back — so the
 * suite would go green while every declaration test below silently exercised
 * the error path instead of the contract.
 */
vi.mock('@/lib/app/data-export', () => ({
  collectAppSubjectData: (...args: unknown[]) => mockCollectAppSubjectData(...args),
  initAppSubjectSources: () => mockInitAppSubjectSources(),
}));

// ---------------------------------------------------------------------------

import {
  exportUserData,
  SubjectNotFoundError,
  DeclaredAppSourceMissingError,
  AppSubjectDeclarationsUnavailableError,
  EXPORT_FORMAT_VERSION,
} from '@/lib/privacy/export-user';
import {
  registerAppSubjectSources,
  __resetAppSubjectSourceRegistryForTests,
} from '@/lib/privacy/subject-source-registry';
import {
  SUBJECT_DATA_SOURCES,
  EXCLUDED_SOURCES,
  type SubjectDataSource,
} from '@/lib/privacy/export-sources';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';

const SUBJECT = {
  id: 'user-1',
  email: 'Subject@Example.com',
  name: 'Subject',
  role: 'USER',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const PARAMS = { userId: 'user-1', actorUserId: 'user-1', reason: 'self_service' as const };

/** Every findMany call made against one delegate during the test. */
function callsTo(delegate: string): unknown[][] {
  return delegateFor(delegate).findMany.mock.calls;
}

/** The single findMany argument object a delegate was called with. */
function argsTo(delegate: string): Record<string, unknown> {
  const calls = callsTo(delegate);
  expect(calls).toHaveLength(1);
  return calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDelegates();
  mockEnv.TENANCY_MODE = 'single';
  mockUserFindUnique.mockResolvedValue(SUBJECT);
  mockCollectAppSubjectData.mockResolvedValue({});
  mockInitAppSubjectSources.mockReset();
  __resetAppSubjectSourceRegistryForTests();
});

describe('exportUserData', () => {
  describe('subject lookup', () => {
    it('throws SubjectNotFoundError when no account row exists', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await expect(exportUserData(PARAMS)).rejects.toThrow(SubjectNotFoundError);
    });

    it('names the missing id in the error', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await expect(exportUserData({ ...PARAMS, userId: 'ghost' })).rejects.toThrow(/ghost/);
    });

    it('runs no source queries when the subject does not exist', async () => {
      mockUserFindUnique.mockResolvedValue(null);

      await expect(exportUserData(PARAMS)).rejects.toThrow(SubjectNotFoundError);
      expect(callsTo('session')).toHaveLength(0);
    });

    it('returns the account row verbatim', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.account).toEqual(SUBJECT);
    });
  });

  describe('credential redaction', () => {
    // These are the cases that would turn an access response into a breach.
    it('withholds the session token', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('session')).toMatchObject({
        where: { userId: 'user-1' },
        omit: { token: true },
      });
    });

    it('withholds the password hash and OAuth tokens', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('account').omit).toEqual({
        password: true,
        accessToken: true,
        refreshToken: true,
        idToken: true,
      });
    });

    it('withholds the API key hash', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiApiKey').omit).toEqual({ keyHash: true });
    });

    it('withholds the webhook signing secret', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiWebhookSubscription').omit).toEqual({ secret: true });
    });

    it('uses omit rather than select on every exported source', async () => {
      // `select` would silently narrow the export as columns are added — the
      // failure mode the manifest exists to prevent. Attribution sources are
      // exempt: narrowing is the whole point there.
      await exportUserData(PARAMS);

      const exportedDelegates = [
        'session',
        'account',
        'aiConversation',
        'aiUserMemory',
        'aiApiKey',
      ];
      for (const delegate of exportedDelegates) {
        expect(argsTo(delegate).select, `${delegate} must not use select`).toBeUndefined();
      }
    });
  });

  describe('scoping', () => {
    it('scopes userId-keyed sources to the subject', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiUserMemory').where).toEqual({ userId: 'user-1' });
    });

    it('scopes createdBy-keyed sources to the subject', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiAgent').where).toEqual({ createdBy: 'user-1' });
    });

    it('scopes uploadedBy-keyed sources to the subject', async () => {
      await exportUserData(PARAMS);

      expect(argsTo('aiKnowledgeDocument').where).toEqual({ uploadedBy: 'user-1' });
    });

    it('matches conversations on the subject alone, with no inbound filter', async () => {
      // Inbound threads used to be written with `userId = trigger.createdBy`
      // — the operator who configured the channel — while the messages and
      // `fromAddress` belonged to whoever sent them, so this source filtered
      // `channel: null` to avoid handing one subject another person's
      // correspondence. #502 made those rows system-owned (`userId: null`),
      // which excludes them from this query by construction. The filter is
      // gone, and the subject's own chat history is no longer narrowed by a
      // predicate that was never about them.
      await exportUserData(PARAMS);

      expect(argsTo('aiConversation').where).toEqual({ userId: 'user-1' });
    });

    it('matches workflow runs on the subject alone, with no trigger-source filter', async () => {
      // Same retirement as conversations above. An inbound run's `inputData`
      // is the adapter payload verbatim — sender number, email body,
      // attachments — so while those rows carried an operator's id, this
      // source had to filter `triggerSource: null` to stay honest.
      await exportUserData(PARAMS);

      expect(argsTo('aiWorkflowExecution').where).toEqual({ userId: 'user-1' });
    });

    it('matches contact submissions exactly on the normalised subject email', async () => {
      // No FK to User — the public form takes an address, and its only writer
      // stores it trimmed and lower-cased (`emailSchema`). So the read
      // normalises the same way and matches exactly. Not `mode: 'insensitive'`:
      // Prisma compiles that to an unescaped ILIKE, where `_` and `%` in an
      // address match other people's submissions.
      await exportUserData(PARAMS);

      expect(argsTo('contactSubmission').where).toEqual({ email: 'subject@example.com' });
    });

    it('trims the subject email before matching contact submissions', async () => {
      // `emailSchema` trims too, so an account address with stray whitespace
      // (one written by a path other than better-auth) still finds its rows.
      mockUserFindUnique.mockResolvedValue({ ...SUBJECT, email: '  Subject@Example.com ' });

      await exportUserData(PARAMS);

      expect(argsTo('contactSubmission').where).toEqual({ email: 'subject@example.com' });
    });
  });

  describe('reading across every org at multi (§107 t-748)', () => {
    // The email as the contact form stores it: trimmed and lower-cased.
    const NORMALISED_EMAIL = SUBJECT.email.trim().toLowerCase();
    const isSubject = (value: unknown) =>
      value === SUBJECT.id || value === SUBJECT.email || value === NORMALISED_EMAIL;
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);

    /**
     * Relation filters a source may pin the subject through — the subject's
     * id on a RELATED row, which narrows to the subject's rows only where the
     * relation says so. Named one by one: `Org` is the orgs the subject has a
     * membership in. A new one is a judgement, so it fails here until named.
     */
    const RELATION_PINS = new Set(['Org.memberships']);

    /** Whether one field's filter is the subject exactly: no negation, no list with others. */
    function fieldPins(value: unknown): boolean {
      if (isSubject(value)) return true;
      if (!isRecord(value)) return false;
      const keys = Object.keys(value);
      // An exact `equals` only. With `mode: 'insensitive'` Prisma emits an
      // unescaped ILIKE, so `_` or `%` in the value match other people's rows.
      if (keys.every((k) => k === 'equals' || k === 'mode')) {
        return value.mode !== 'insensitive' && isSubject(value.equals);
      }
      if (keys.length === 1 && Array.isArray(value.in)) {
        return value.in.length > 0 && value.in.every(isSubject);
      }
      return false;
    }

    /**
     * Whether `where` pins `model`'s rows to the subject: their id or email
     * on one of the row's own fields, at the top level or under `AND` —
     * never through `OR`, `NOT` or a negating operator (`not`, `notIn`,
     * `none`, `every`), which do not narrow the read to them and under the
     * bypass would read other people's rows in every org.
     */
    function pinsSubject(model: string, where: unknown): boolean {
      if (!isRecord(where)) return false;
      return Object.entries(where).some(([key, value]) => {
        if (key === 'AND') {
          const parts = Array.isArray(value) ? value : [value];
          return parts.some((part) => pinsSubject(model, part));
        }
        if (key === 'OR' || key === 'NOT') return false;
        if (RELATION_PINS.has(`${model}.${key}`)) {
          return isRecord(value) && isRecord(value.some) && pinsSubject(model, value.some);
        }
        return fieldPins(value);
      });
    }

    /**
     * Relations each source reads rows through (`include`, or a nested
     * `select`). Under the bypass a related row is not held to one org, so
     * every relation is named here, with why it is still the subject's.
     */
    const RELATION_READS: Record<string, string[]> = {
      // The org row of each of the subject's own memberships: id, slug, name.
      OrgMembership: ['org'],
      // The messages and share link of the subject's own conversations.
      AiConversation: ['messages', 'share'],
    };

    function relationReads(args: Record<string, unknown>): string[] {
      const { include, select } = args;
      const fromInclude = isRecord(include)
        ? Object.entries(include)
            .filter(([, v]) => Boolean(v))
            .map(([k]) => k)
        : [];
      const fromSelect = isRecord(select)
        ? Object.entries(select)
            .filter(([, v]) => isRecord(v))
            .map(([k]) => k)
        : [];
      return [...fromInclude, ...fromSelect].sort();
    }

    const delegateOf = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

    /** The tenant context each read saw, recorded from one source and the app seam. */
    function recordContexts(): Array<{ orgId: string | null; source: string } | null> {
      const seen: Array<{ orgId: string | null; source: string } | null> = [];
      // A plain array, not a promise: the delegate's mock type wants a void
      // return, and the source awaits whatever it is handed.
      delegateFor('aiConversation').findMany.mockImplementation(() => {
        seen.push(getTenantContext());
        return [];
      });
      mockCollectAppSubjectData.mockImplementation(async () => {
        seen.push(getTenantContext());
        return {};
      });
      return seen;
    }

    const ACTIVE_ORG = 'cmorg00000000000000active';

    it('reads every source and the app seam in the system scope, whatever org the caller is in', async () => {
      // A session enters its active org, and the policy would AND every read
      // with it; an admin API key enters none. Both must read as the bypass.
      mockEnv.TENANCY_MODE = 'multi';
      const seen = recordContexts();

      await runAsOrg(ACTIVE_ORG, () => exportUserData(PARAMS), { source: 'session' });
      await exportUserData(PARAMS);

      const system = { orgId: null, source: 'system' };
      expect(seen).toEqual([system, system, system, system]);
    });

    it('enters no scope at single, where there is one org and no policy', async () => {
      // A collector or helper reading the implicit install org keeps working.
      const seen = recordContexts();

      await runAsOrg(ACTIVE_ORG, () => exportUserData(PARAMS), { source: 'session' });
      await exportUserData(PARAMS);

      const session = { orgId: ACTIVE_ORG, source: 'session', role: undefined };
      expect(seen).toEqual([session, session, null, null]);
    });

    it('pins every source on the subject, so the bypass widens it to their rows alone', async () => {
      await exportUserData(PARAMS);

      const unpinned = SUBJECT_DATA_SOURCES.map((source) => source.model).filter(
        (model) => !pinsSubject(model, argsTo(delegateOf(model)).where)
      );
      expect(unpinned).toEqual([]);
    });

    it('reads related rows only through relations named as the subject’s', async () => {
      await exportUserData(PARAMS);

      const reads = Object.fromEntries(
        SUBJECT_DATA_SOURCES.map((source) => [
          source.model,
          relationReads(argsTo(delegateOf(source.model))),
        ]).filter(([, relations]) => relations.length > 0)
      );
      expect(reads).toEqual(RELATION_READS);
    });

    it('does not count a subject named under OR, NOT, a negation or a list with others as pinned', () => {
      // The pinning check is only worth its pass if it can fail.
      const id = SUBJECT.id;
      for (const where of [
        { OR: [{ userId: id }, { isPublic: true }] },
        { NOT: { userId: id } },
        { userId: { not: id } },
        { userId: { notIn: [id] } },
        { userId: { in: [id, 'someone-else'] } },
        { memberships: { none: { userId: id } } },
        { agent: { createdBy: id } },
      ]) {
        expect(pinsSubject('AiConversation', where), JSON.stringify(where)).toBe(false);
      }
      expect(pinsSubject('Org', { memberships: { every: { userId: id } } })).toBe(false);

      expect(pinsSubject('AiConversation', { AND: [{ userId: id }, { isPublic: true }] })).toBe(
        true
      );
      expect(pinsSubject('AiConversation', { userId: { in: [id] } })).toBe(true);
      expect(pinsSubject('Org', { memberships: { some: { userId: id, role: 'OWNER' } } })).toBe(
        true
      );
      expect(pinsSubject('ContactSubmission', { email: NORMALISED_EMAIL })).toBe(true);
      expect(pinsSubject('ContactSubmission', { email: { equals: NORMALISED_EMAIL } })).toBe(true);
      expect(
        pinsSubject('ContactSubmission', { email: { equals: NORMALISED_EMAIL, mode: 'default' } })
      ).toBe(true);
      // A case-insensitive match is a pattern match in Postgres, not a pin.
      expect(
        pinsSubject('ContactSubmission', { email: { equals: SUBJECT.email, mode: 'insensitive' } })
      ).toBe(false);
    });

    /** Hold the first source's read open; return whether the second started meanwhile. */
    async function secondStartsWhileFirstIsOpen(): Promise<boolean> {
      const [first, second] = SUBJECT_DATA_SOURCES.map((source) => delegateOf(source.model));
      let release: (rows: unknown[]) => void = () => {};
      delegateFor(first).findMany.mockReturnValue(
        new Promise<unknown[]>((resolve) => {
          release = resolve;
        })
      );

      const pending = exportUserData(PARAMS);
      await vi.waitFor(() => expect(callsTo(first)).toHaveLength(1));
      // Let any reads that were started together reach their delegates.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const started = callsTo(second).length > 0;

      release([]);
      await pending;
      expect(callsTo(second)).toHaveLength(1);
      return started;
    }

    it('reads one source at a time at multi, so an export never queues its reads behind the pool', async () => {
      mockEnv.TENANCY_MODE = 'multi';
      expect(await secondStartsWhileFirstIsOpen()).toBe(false);
    });

    it('still reads the sources together at single, where no read holds a transaction', async () => {
      expect(await secondStartsWhileFirstIsOpen()).toBe(true);
    });
  });

  describe('bundle composition', () => {
    it('files each source under its declared section and disposition', async () => {
      const bundle = await exportUserData(PARAMS);

      for (const source of SUBJECT_DATA_SOURCES) {
        const target = source.disposition === 'export' ? bundle.personalData : bundle.attributions;
        expect(Object.keys(target), `${source.model} → ${source.section}`).toContain(
          source.section
        );
      }
    });

    it('keeps personal data and attribution in separate buckets', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(Object.keys(bundle.personalData)).toContain('sessions');
      expect(Object.keys(bundle.personalData)).not.toContain('agents');
      expect(Object.keys(bundle.attributions)).toContain('agents');
      expect(Object.keys(bundle.attributions)).not.toContain('sessions');
    });

    it('returns attribution rows as id + label + date only', async () => {
      delegateFor('aiAgent').findMany.mockResolvedValue([
        { id: 'agent-1', name: 'Support bot', createdAt: SUBJECT.createdAt },
      ]);

      const bundle = await exportUserData(PARAMS);

      expect(bundle.attributions.agents).toEqual([
        { id: 'agent-1', label: 'Support bot', createdAt: SUBJECT.createdAt },
      ]);
    });

    it('labels versioned attribution rows by version number', async () => {
      delegateFor('aiAgentVersion').findMany.mockResolvedValue([
        { id: 'ver-1', version: 3, createdAt: SUBJECT.createdAt },
      ]);

      const bundle = await exportUserData(PARAMS);

      expect(bundle.attributions.agentVersions).toEqual([
        { id: 'ver-1', label: 'v3', createdAt: SUBJECT.createdAt },
      ]);
    });

    it('labels Document Clean Up revisions by their source', async () => {
      delegateFor('aiKnowledgeDocumentRevision').findMany.mockResolvedValue([
        { id: 'rev-1', source: 'capability:strip_timestamps', createdAt: SUBJECT.createdAt },
      ]);

      const bundle = await exportUserData(PARAMS);

      expect(bundle.attributions.knowledgeDocumentRevisions).toEqual([
        { id: 'rev-1', label: 'capability:strip_timestamps', createdAt: SUBJECT.createdAt },
      ]);
    });

    it('labels Document Clean Up pending changes by their source', async () => {
      delegateFor('aiKnowledgeDocumentPendingChange').findMany.mockResolvedValue([
        { id: 'pending-1', source: 'rewrite_with_llm', createdAt: SUBJECT.createdAt },
      ]);

      const bundle = await exportUserData(PARAMS);

      expect(bundle.attributions.knowledgeDocumentPendingChanges).toEqual([
        { id: 'pending-1', label: 'rewrite_with_llm', createdAt: SUBJECT.createdAt },
      ]);
    });

    it('includes erasure receipts naming the subject', async () => {
      const receipt = { id: 'receipt-1', subjectUserId: 'user-1', reason: 'self_service' };
      delegateFor('dataErasureReceipt').findMany.mockResolvedValue([receipt]);

      const bundle = await exportUserData(PARAMS);

      expect(bundle.erasureReceipts).toEqual([receipt]);
      expect(argsTo('dataErasureReceipt').where).toEqual({ subjectUserId: 'user-1' });
    });
  });

  describe('the app seam', () => {
    it('passes the subject id and email to the collector', async () => {
      await exportUserData(PARAMS);

      expect(mockCollectAppSubjectData).toHaveBeenCalledWith({
        userId: 'user-1',
        email: 'Subject@Example.com',
      });
    });

    it('folds the collector result into the app section', async () => {
      mockCollectAppSubjectData.mockResolvedValue({ invoices: [{ id: 'inv-1' }] });

      const bundle = await exportUserData(PARAMS);

      expect(bundle.app).toEqual({ invoices: [{ id: 'inv-1' }] });
    });

    it('yields an empty app section on the vanilla default', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.app).toEqual({});
    });

    it('fails the export when the collector throws', async () => {
      // App-side trouble must not produce a bundle that reads as complete.
      mockCollectAppSubjectData.mockRejectedValue(new Error('app db down'));

      await expect(exportUserData(PARAMS)).rejects.toThrow('app db down');
    });
  });

  describe('the declared-source contract (#533)', () => {
    /** Register one app source through the seam the registry runs lazily. */
    const declare = (model: string, section: string): void => {
      mockInitAppSubjectSources.mockImplementation(() => {
        registerAppSubjectSources({
          tier: 'app',
          sources: [
            { model, section, disposition: 'export', description: 'Declared for this test.' },
          ],
        });
      });
    };

    it('fails the export when a declared section never arrives', async () => {
      declare('AppInvoice', 'invoices');
      mockCollectAppSubjectData.mockResolvedValue({});

      await expect(exportUserData(PARAMS)).rejects.toThrow(DeclaredAppSourceMissingError);
      await expect(exportUserData(PARAMS)).rejects.toThrow(/invoices/);
    });

    it('names every missing section, not just the first', async () => {
      mockInitAppSubjectSources.mockImplementation(() => {
        registerAppSubjectSources({
          tier: 'app',
          sources: [
            {
              model: 'AppInvoice',
              section: 'invoices',
              disposition: 'export',
              description: 'Invoices raised against the account.',
            },
            {
              model: 'AppBooking',
              section: 'bookings',
              disposition: 'export',
              description: 'Bookings made by the subject.',
            },
          ],
        });
      });
      mockCollectAppSubjectData.mockResolvedValue({});

      const error = await exportUserData(PARAMS).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(DeclaredAppSourceMissingError);
      expect((error as DeclaredAppSourceMissingError).sections).toEqual(['invoices', 'bookings']);
    });

    it('accepts an empty array — the contract is the key, not the rows', async () => {
      // The reason this is a key check and not a truthiness one: a subject who
      // owns nothing must still see the section, or "no rows" and "not asked"
      // look identical in the bundle.
      declare('AppInvoice', 'invoices');
      mockCollectAppSubjectData.mockResolvedValue({ invoices: [] });

      const bundle = await exportUserData(PARAMS);

      expect(bundle.app).toEqual({ invoices: [] });
    });

    it('rejects a declared section whose value is undefined', async () => {
      // `JSON.stringify({ invoices: undefined })` is `{}`, so the key exists in
      // memory and not in the bundle the subject receives. A collector doing
      // `rows.length ? rows : undefined` would otherwise certify a section it
      // then drops.
      declare('AppInvoice', 'invoices');
      mockCollectAppSubjectData.mockResolvedValue({ invoices: undefined });

      await expect(exportUserData(PARAMS)).rejects.toThrow(DeclaredAppSourceMissingError);
    });

    it('rejects a declared section named after an Object.prototype member', async () => {
      // `app['constructor'] === undefined` is false on any plain object, so a
      // bare lookup called this delivered and `countAppRows` then reported a
      // count for a key the JSON does not contain.
      declare('AppThing', 'constructor');
      mockCollectAppSubjectData.mockResolvedValue({});

      await expect(exportUserData(PARAMS)).rejects.toThrow(DeclaredAppSourceMissingError);
    });

    it('accepts a declared section that is null — null survives serialisation', async () => {
      declare('AppInvoice', 'invoices');
      mockCollectAppSubjectData.mockResolvedValue({ invoices: null });

      const bundle = await exportUserData(PARAMS);

      expect(JSON.parse(JSON.stringify(bundle)).app).toEqual({ invoices: null });
    });

    it('allows sections the tier did not declare', async () => {
      // A derived view is not a table, so it has nothing to declare. Extra keys
      // are the subject receiving more, which is not the failure being guarded.
      declare('AppInvoice', 'invoices');
      mockCollectAppSubjectData.mockResolvedValue({ invoices: [], activitySummary: { runs: 3 } });

      const bundle = await exportUserData(PARAMS);

      expect(bundle.app).toEqual({ invoices: [], activitySummary: { runs: 3 } });
    });

    it('is inert in vanilla Sunrise, where nothing is declared', async () => {
      mockCollectAppSubjectData.mockResolvedValue({});

      const bundle = await exportUserData(PARAMS);

      expect(bundle.app).toEqual({});
    });
  });

  describe('a fork tier’s sources reach meta (#530 review)', () => {
    it('summarises each declared source with its description and row count', async () => {
      // Without this the subject receives `app.invoices` with nothing in the
      // bundle's own manifest saying what it is or how much of it there is —
      // while the same manifest names the tables that were withheld. The
      // `description` every tier is required to write has nowhere else to go.
      mockInitAppSubjectSources.mockImplementation(() => {
        registerAppSubjectSources({
          tier: 'app',
          sources: [
            {
              model: 'AppInvoice',
              section: 'invoices',
              disposition: 'export',
              description: 'Invoices raised against your account.',
            },
            {
              model: 'AppAgreement',
              section: 'agreements',
              disposition: 'attribution',
              description: 'Agreements you authored, by name and date.',
            },
          ],
        });
      });
      mockCollectAppSubjectData.mockResolvedValue({
        invoices: [{ id: 'inv-1' }, { id: 'inv-2' }],
        agreements: [],
      });

      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.app).toEqual([
        {
          model: 'AppInvoice',
          section: 'invoices',
          disposition: 'export',
          description: 'Invoices raised against your account.',
          rows: 2,
        },
        {
          model: 'AppAgreement',
          section: 'agreements',
          disposition: 'attribution',
          description: 'Agreements you authored, by name and date.',
          rows: 0,
        },
      ]);
    });

    it('keeps app sections out of meta.exported, which maps to personalData', async () => {
      // The two lists are read against different objects. Folding them would
      // leave a reader looking up `invoices` in `personalData`, where it is not.
      mockInitAppSubjectSources.mockImplementation(() => {
        registerAppSubjectSources({
          tier: 'app',
          sources: [
            {
              model: 'AppInvoice',
              section: 'invoices',
              disposition: 'export',
              description: 'Invoices raised against your account.',
            },
          ],
        });
      });
      mockCollectAppSubjectData.mockResolvedValue({ invoices: [] });

      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.exported.map((entry) => entry.section)).not.toContain('invoices');
      expect(bundle.personalData).not.toHaveProperty('invoices');
      expect(bundle.app).toHaveProperty('invoices');
    });

    it('counts a non-list section as one record rather than inventing a number', async () => {
      mockInitAppSubjectSources.mockImplementation(() => {
        registerAppSubjectSources({
          tier: 'app',
          sources: [
            {
              model: 'AppProfile',
              section: 'profile',
              disposition: 'export',
              description: 'The single profile record we hold for you.',
            },
          ],
        });
      });
      mockCollectAppSubjectData.mockResolvedValue({ profile: { nickname: 'sam' } });

      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.app[0].rows).toBe(1);
    });

    it('is an empty list in vanilla Sunrise', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.app).toEqual([]);
    });
  });

  describe('a tier whose declarations failed to load', () => {
    it('refuses the export rather than shipping a bundle it cannot certify', async () => {
      // The collector is a separate static import, so it keeps working: without
      // this the subject gets app rows that `meta.app` describes none of, and
      // the tier's exclusions vanish from `meta.excluded`.
      mockInitAppSubjectSources.mockImplementation(() => {
        throw new Error('typo in the manifest');
      });
      mockCollectAppSubjectData.mockResolvedValue({ invoices: [{ id: 'inv-1' }] });

      await expect(exportUserData(PARAMS)).rejects.toThrow(AppSubjectDeclarationsUnavailableError);
    });

    it('refuses even when the collector returns nothing', async () => {
      // "No rows" and "we could not read the declarations" are different
      // answers, and only one of them can be certified.
      mockInitAppSubjectSources.mockImplementation(() => {
        throw new Error('typo in the manifest');
      });
      mockCollectAppSubjectData.mockResolvedValue({});

      await expect(exportUserData(PARAMS)).rejects.toThrow(AppSubjectDeclarationsUnavailableError);
    });

    it('exports normally when the init succeeds', async () => {
      mockInitAppSubjectSources.mockImplementation(() => undefined);
      mockCollectAppSubjectData.mockResolvedValue({});

      await expect(exportUserData(PARAMS)).resolves.toMatchObject({ app: {} });
    });
  });

  describe('a fork tier’s exclusions reach the subject', () => {
    it('discloses them in meta.excluded, alongside core’s', async () => {
      // The reason a tier writes is what the subject is shown in place of the
      // table's contents. Without this, a fork install's bundle states the
      // boundary for core's tables and stays silent about the fork's — the
      // subject cannot tell "we hold nothing about you" from "we decided not
      // to give it to you".
      mockInitAppSubjectSources.mockImplementation(() => {
        registerAppSubjectSources({
          tier: 'app',
          excluded: [
            {
              model: 'AppCountry',
              reason: 'Reference list of countries — holds no personal data.',
            },
          ],
        });
      });

      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.excluded).toEqual([
        ...EXCLUDED_SOURCES,
        { model: 'AppCountry', reason: 'Reference list of countries — holds no personal data.' },
      ]);
    });

    it('leaves meta.excluded as core’s alone in vanilla Sunrise', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.excluded).toEqual(EXCLUDED_SOURCES);
    });
  });

  describe('meta', () => {
    it('reports the format version', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    });

    it('summarises every source with its row count', async () => {
      delegateFor('aiUserMemory').findMany.mockResolvedValue([{ id: 'm-1' }, { id: 'm-2' }]);

      const bundle = await exportUserData(PARAMS);
      const memory = bundle.meta.exported.find((entry) => entry.model === 'AiUserMemory');

      expect(memory).toMatchObject({ section: 'agentMemory', rows: 2 });
      expect(memory?.description.length).toBeGreaterThan(10);
    });

    it('accounts for every manifest source across the two summaries', async () => {
      const bundle = await exportUserData(PARAMS);

      const summarised = [...bundle.meta.exported, ...bundle.meta.attribution].map(
        (entry) => entry.model
      );

      expect(summarised.sort()).toEqual(SUBJECT_DATA_SOURCES.map((s) => s.model).sort());
    });

    it('discloses a narrowed source’s scope to the subject', async () => {
      // A narrowed source that reported only a row count would be the
      // silent-omission failure at row granularity — the count reads like a
      // complete answer either way.
      //
      // No shipped source narrows today (#502 removed the last two, which
      // existed to contain inbound rows mis-attributed to an operator), so the
      // mechanism is exercised through a source pushed on for this test.
      // Without it, the next author to add a filtered `fetch` would find the
      // disclosure path untested.
      const narrowed: SubjectDataSource = {
        model: 'SmokeNarrowed',
        section: 'smokeNarrowed',
        disposition: 'export',
        description: 'Synthetic source used to exercise scope disclosure.',
        scopeNote: 'Covers only the rows this test says it covers, and nothing else.',
        fetch: () => Promise.resolve([]),
      };
      SUBJECT_DATA_SOURCES.push(narrowed);
      try {
        const bundle = await exportUserData(PARAMS);
        const entry = bundle.meta.exported.find((e) => e.model === 'SmokeNarrowed');

        expect(entry?.scopeNote).toBe(narrowed.scopeNote);
      } finally {
        SUBJECT_DATA_SOURCES.pop();
      }
    });

    it('leaves every shipped source unnarrowed', async () => {
      // The inverse pin. `AiConversation` and `AiWorkflowExecution` carried
      // filters and scope notes between #467 and #502, to keep a third party's
      // inbound messages out of an export that matched them on the operator's
      // `userId`. Those rows are system-owned now, so the export is whole
      // again — and if a filter ever comes back it must arrive with a note.
      const bundle = await exportUserData(PARAMS);
      const narrowedModels = bundle.meta.exported
        .filter((entry) => entry.scopeNote !== undefined)
        .map((entry) => entry.model);

      expect(narrowedModels).toEqual([]);
    });

    it('leaves scopeNote absent on sources that return every matching row', async () => {
      const bundle = await exportUserData(PARAMS);
      const memory = bundle.meta.exported.find((entry) => entry.model === 'AiUserMemory');

      expect(memory).not.toHaveProperty('scopeNote');
    });

    it('discloses what was deliberately withheld', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.excluded).toEqual(EXCLUDED_SOURCES);
      expect(bundle.meta.excluded.length).toBeGreaterThan(0);
    });

    it('stamps the subject and generation time', async () => {
      const bundle = await exportUserData(PARAMS);

      expect(bundle.meta.subjectUserId).toBe('user-1');
      expect(new Date(bundle.meta.generatedAt).getTime()).not.toBeNaN();
    });
  });

  describe('failing whole rather than partial', () => {
    it('rejects when any single source throws', async () => {
      // The opposite of the erasure path, which swallows hook failures. A
      // silently-missing section is undetectable to the person reading it.
      delegateFor('aiConversation').findMany.mockRejectedValue(new Error('conversations offline'));

      await expect(exportUserData(PARAMS)).rejects.toThrow('conversations offline');
    });

    it('rejects when the receipt lookup throws', async () => {
      delegateFor('dataErasureReceipt').findMany.mockRejectedValue(new Error('receipts offline'));

      await expect(exportUserData(PARAMS)).rejects.toThrow('receipts offline');
    });
  });

  describe('logging', () => {
    it('records the actor, reason and volume', async () => {
      delegateFor('aiUserMemory').findMany.mockResolvedValue([{ id: 'm-1' }]);

      await exportUserData({ userId: 'user-1', actorUserId: 'admin-9', reason: 'admin_action' });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Subject data export generated',
        expect.objectContaining({
          userId: 'user-1',
          actorUserId: 'admin-9',
          reason: 'admin_action',
          totalRows: 1,
        })
      );
    });
  });
});
