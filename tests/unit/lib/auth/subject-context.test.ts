/**
 * Tests: the subject context (§115 t-800)
 *
 * The primitive on its own — what it answers inside and outside a subject, that
 * the policy is asked at most once per request, that `runAcrossOwners` lifts
 * the narrowing only for its callback, and that the scope follows the async
 * subtree (concurrent requests, a background job, a streamed body). The guards'
 * use of it is `guards-subject.test.ts`; the interactive-transaction case is
 * pinned beside the other layering tests in `tenancy-extension.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  getSubjectReadScope,
  noteConfinedRead,
  noteUncheckedRead,
  runAcrossOwners,
  runAsSubject,
  type SubjectEntry,
} from '@/lib/auth/subject-context';
import { sseResponse } from '@/lib/api/sse';

const NO_UNATTRIBUTED_READS = {
  conversation: false,
  dataset: false,
  execution: false,
  experiment: false,
  webhookDelivery: false,
  webhookSubscription: false,
} as const;

function entryFor(userId: string, overrides: Partial<SubjectEntry> = {}): SubjectEntry {
  return {
    principal: { userId, role: 'USER', credential: 'session' },
    resolveFilter: vi.fn(() => Promise.resolve({ userId })),
    unattributedReads: NO_UNATTRIBUTED_READS,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('outside any subject', () => {
  it('answers none — a job or a guard-less route is not narrowed', async () => {
    expect(await getSubjectReadScope()).toEqual({ kind: 'none' });
  });

  it('runAcrossOwners changes nothing and logs nothing', async () => {
    const scope = await runAcrossOwners('fixture', () => getSubjectReadScope());
    expect(scope).toEqual({ kind: 'none' });
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('inside a subject', () => {
  it('answers the subject, its filter and its ownerless reads', async () => {
    const entry = entryFor('member-1');
    const scope = await runAsSubject(entry, () => getSubjectReadScope());
    expect(scope).toEqual({
      kind: 'subject',
      principal: entry.principal,
      filter: { userId: 'member-1' },
      unattributedReads: NO_UNATTRIBUTED_READS,
      // Absent from the entry: the narrower answer.
      readsShared: false,
    });
  });

  it('carries whether a share admits rows, as the guard entered it', async () => {
    const entry = entryFor('member-1', { readsShared: true });
    const scope = await runAsSubject(entry, () => getSubjectReadScope());
    expect(scope).toMatchObject({ kind: 'subject', readsShared: true });
  });

  it('reuses the filter the guard already computed, and never asks again', async () => {
    const entry = entryFor('member-1', { filter: {} });
    const scope = await runAsSubject(entry, () => getSubjectReadScope());
    expect(scope).toMatchObject({ kind: 'subject', filter: {} });
    expect(entry.resolveFilter).not.toHaveBeenCalled();
  });

  it('asks the policy lazily, and once however many reads race for it', async () => {
    const entry = entryFor('member-1');
    await runAsSubject(entry, async () => {
      expect(entry.resolveFilter).not.toHaveBeenCalled();
      await Promise.all([getSubjectReadScope(), getSubjectReadScope(), getSubjectReadScope()]);
    });
    expect(entry.resolveFilter).toHaveBeenCalledTimes(1);
  });

  it('hands each reader a copy, so one mutating it cannot widen the next', async () => {
    await runAsSubject(entryFor('member-1'), async () => {
      const first = await getSubjectReadScope();
      if (first.kind !== 'subject') throw new Error('expected a subject');
      delete first.filter.userId;
      expect(await getSubjectReadScope()).toMatchObject({ filter: { userId: 'member-1' } });
    });
  });

  it('copies the filter the guard handed over, so the route mutating its own cannot widen the data layer', async () => {
    const routeFilter: { userId?: string } = { userId: 'member-1' };
    await runAsSubject(entryFor('member-1', { filter: routeFilter }), async () => {
      delete routeFilter.userId;
      expect(await getSubjectReadScope()).toMatchObject({ filter: { userId: 'member-1' } });
    });
  });

  it('does not memoise a failed answer — the next read asks again', async () => {
    const resolveFilter = vi
      .fn<SubjectEntry['resolveFilter']>()
      .mockRejectedValueOnce(new Error('fallback failed'))
      .mockResolvedValueOnce({ userId: 'member-1' });
    await runAsSubject(entryFor('member-1', { resolveFilter }), async () => {
      await expect(getSubjectReadScope()).rejects.toThrow('fallback failed');
      expect(await getSubjectReadScope()).toMatchObject({ filter: { userId: 'member-1' } });
    });
    expect(resolveFilter).toHaveBeenCalledTimes(2);
  });

  it('does not leak past the callback, even when it throws', async () => {
    await expect(
      runAsSubject(entryFor('member-1'), () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
    expect(await getSubjectReadScope()).toEqual({ kind: 'none' });
  });

  it('keeps concurrent requests apart', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    const [a, b] = await Promise.all([
      runAsSubject(entryFor('member-a'), async () => {
        await tick();
        return getSubjectReadScope();
      }),
      runAsSubject(entryFor('member-b'), async () => {
        await tick();
        return getSubjectReadScope();
      }),
    ]);
    expect(a).toMatchObject({ filter: { userId: 'member-a' } });
    expect(b).toMatchObject({ filter: { userId: 'member-b' } });
  });
});

describe('runAcrossOwners', () => {
  it('admits its callback with the reason, logs it, and restores the subject after', async () => {
    await runAsSubject(entryFor('member-1'), async () => {
      const inside = await runAcrossOwners('org-wide count for the dashboard', () =>
        getSubjectReadScope()
      );
      expect(inside).toMatchObject({
        kind: 'admitted',
        reason: 'org-wide count for the dashboard',
        principal: { userId: 'member-1' },
      });
      expect(await getSubjectReadScope()).toMatchObject({ kind: 'subject' });
    });
    expect(logger.info).toHaveBeenCalledWith('Reading across owners', {
      reason: 'org-wide count for the dashboard',
      userId: 'member-1',
    });
  });
});

describe('runAcrossOwners logging', () => {
  it('logs each reason once per request, however many times it is entered', async () => {
    await runAsSubject(entryFor('member-1'), async () => {
      for (let i = 0; i < 3; i += 1) {
        await runAcrossOwners('a per-row helper', () => getSubjectReadScope());
      }
      await runAcrossOwners('another reason', () => getSubjectReadScope());
    });
    expect(vi.mocked(logger.info).mock.calls.map((c) => c[1])).toEqual([
      { reason: 'a per-row helper', userId: 'member-1' },
      { reason: 'another reason', userId: 'member-1' },
    ]);

    // A second request logs the same reason again: the dedupe is per request.
    await runAsSubject(entryFor('member-2'), () =>
      runAcrossOwners('a per-row helper', () => getSubjectReadScope())
    );
    expect(logger.info).toHaveBeenCalledTimes(3);
  });

  it('logs nothing when nothing was crossed', async () => {
    // A caller the policy does not narrow (a platform admin) had no check to cross.
    await runAsSubject(
      entryFor('admin-1', { resolveFilter: vi.fn(() => Promise.resolve({})) }),
      () => runAcrossOwners('an admin export', () => getSubjectReadScope())
    );
    // A narrowed caller whose crossing made no read the owner layer checks.
    await runAsSubject(entryFor('member-1'), () =>
      runAcrossOwners('a crossing that read nothing personal', () => Promise.resolve())
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('noteConfinedRead', () => {
  it("calls the entering guard's callback, and is a no-op outside a subject", async () => {
    const onConfinedRead = vi.fn();
    noteConfinedRead();
    await runAsSubject({ ...entryFor('member-1'), onConfinedRead }, () => {
      noteConfinedRead();
      return Promise.resolve();
    });
    expect(onConfinedRead).toHaveBeenCalledTimes(1);
  });
});

describe('noteUncheckedRead', () => {
  it("calls the entering guard's callback, and is a no-op outside a subject", async () => {
    const onUncheckedRead = vi.fn();
    noteUncheckedRead();
    await runAsSubject({ ...entryFor('member-1'), onUncheckedRead }, () => {
      noteUncheckedRead();
      return Promise.resolve();
    });
    expect(onUncheckedRead).toHaveBeenCalledTimes(1);
  });
});

describe('a streamed response', () => {
  it('keeps the subject in a body produced after the handler returned', async () => {
    // The chat stream's shape: the handler returns an SSE response at once and
    // the events — and the reads behind them — are produced as the client reads.
    async function* events() {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const scope = await getSubjectReadScope();
      yield {
        type: 'scope',
        kind: scope.kind,
        userId: scope.kind === 'subject' ? scope.filter.userId : null,
      };
    }
    const response = await runAsSubject(entryFor('member-1'), () =>
      Promise.resolve(sseResponse(events(), { keepaliveIntervalMs: 60_000 }))
    );

    // Read entirely outside the subject.
    expect(await getSubjectReadScope()).toEqual({ kind: 'none' });
    const body = await response.text();
    expect(body).toContain('"kind":"subject"');
    expect(body).toContain('"userId":"member-1"');
  });
});
