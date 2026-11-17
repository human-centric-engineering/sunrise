/**
 * The precision and recall gate for core's sensitivity classifier (§130,
 * t-1036).
 *
 * Runs the labelled synthetic corpus through the classifiers exactly as a call
 * would — `runSensitivityClassifiers()`, so through the registry and core's
 * defaults, each message as a `user` part — and compares every group's and
 * category's figures with `tests/fixtures/privacy/sensitivity-corpus/baseline.json`,
 * for the development set and the held-out set separately. It fails when any
 * recall or precision drops, and when the corpus itself changes without the
 * baseline being re-recorded: a deleted label raises recall, and the gate
 * would otherwise read that as an improvement.
 *
 * Raising a figure passes, and does not update the file. Record the new
 * figures (the failure message prints them) when a change is meant to move
 * them, and say why in the PR.
 *
 * The scorer is tested first, on answers whose score is known, because a
 * scorer that cannot report a miss would make this gate pass on anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPrivacyAdaptersForTests } from '@/lib/privacy/adapters/registry';
import { runSensitivityClassifiers } from '@/lib/privacy/adapters/run';
import { CORE_SENSITIVITY_CATEGORIES } from '@/lib/privacy/adapters/types';
import { DEVELOPMENT_CORPUS, HELD_OUT_CORPUS } from '@/tests/fixtures/privacy/sensitivity-corpus';
import baseline from '@/tests/fixtures/privacy/sensitivity-corpus/baseline.json';
import {
  scoreSensitivity,
  type Score,
  type SensitivityScore,
} from '@/tests/fixtures/privacy/sensitivity-corpus/score';
import type { SensitivityCorpusCase } from '@/tests/fixtures/privacy/sensitivity-corpus/types';

// Core's classifier only: a fork's own classifiers are not what this measures.
vi.mock('@/lib/app/privacy-adapters', () => ({ initAppPrivacyAdapters: () => undefined }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface Recorded {
  labelled: number;
  recall: number | null;
  precision: number | null;
}

interface RecordedSet {
  cases: number;
  groups: Record<string, Recorded>;
  categories: Record<string, Recorded>;
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);

function recorded(s: Score): Recorded {
  return { labelled: s.labelled, recall: round(s.recall), precision: round(s.precision) };
}

function sorted(scores: Record<string, Score>): Record<string, Recorded> {
  return Object.fromEntries(
    Object.entries(scores)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, s]) => [k, recorded(s)])
  );
}

function measured(cases: readonly SensitivityCorpusCase[], score: SensitivityScore): RecordedSet {
  return {
    cases: cases.length,
    groups: sorted(score.byGroup),
    categories: sorted(score.byCategory),
  };
}

async function scoreWithCore(cases: readonly SensitivityCorpusCase[]): Promise<SensitivityScore> {
  return scoreSensitivity(cases, async (c) => {
    const result = await runSensitivityClassifiers(
      { parts: [{ role: 'user', text: c.text }] },
      { scopeId: c.id }
    );
    // A core classifier failing would make every figure meaningless.
    expect(result.failures).toEqual([]);
    return result.categories.map((x) => x.category);
  });
}

function compare(
  kind: string,
  recordedFigures: Record<string, Recorded>,
  now: Record<string, Recorded>,
  problems: string[]
): void {
  const keys = new Set([...Object.keys(recordedFigures), ...Object.keys(now)]);
  for (const key of [...keys].sort()) {
    const r = recordedFigures[key];
    const n = now[key];
    if (!r) {
      problems.push(`${kind} ${key}: measured but not recorded`);
      continue;
    }
    if (!n) {
      problems.push(`${kind} ${key}: recorded but no longer measured`);
      continue;
    }
    if (r.labelled !== n.labelled) {
      problems.push(`${kind} ${key}: labelled ${r.labelled} → ${n.labelled}: the corpus changed`);
    }
    if (r.recall !== null && (n.recall ?? 0) < r.recall) {
      problems.push(`${kind} ${key}: recall ${r.recall} → ${n.recall}`);
    }
    // Nothing flagged leaves precision undefined; recall catches that case.
    if (r.precision !== null && n.precision !== null && n.precision < r.precision) {
      problems.push(`${kind} ${key}: precision ${r.precision} → ${n.precision}`);
    }
  }
}

/** Every way `now` is worse than `recordedSet`, as readable lines. */
function regressions(recordedSet: RecordedSet, now: RecordedSet): string[] {
  const problems: string[] = [];
  if (recordedSet.cases !== now.cases) {
    problems.push(`case count ${recordedSet.cases} → ${now.cases}: the corpus changed`);
  }
  compare('group', recordedSet.groups, now.groups, problems);
  compare('category', recordedSet.categories, now.categories, problems);
  return problems;
}

beforeEach(() => {
  __resetPrivacyAdaptersForTests();
});

describe('the scorer', () => {
  const cases: SensitivityCorpusCase[] = [
    { id: 'a', text: 'a', categories: ['health'] },
    { id: 'b', text: 'b', categories: ['deal', 'not_public'] },
    { id: 'c', text: 'c', categories: [] },
  ];

  it('scores a perfect answer as perfect, per group and per category', async () => {
    const score = await scoreSensitivity(cases, (c) => Promise.resolve(c.categories));
    expect(score.byGroup.personal).toMatchObject({ labelled: 1, recall: 1, precision: 1 });
    expect(score.byGroup.commercial).toMatchObject({ labelled: 1, recall: 1, precision: 1 });
    expect(score.byCategory.deal).toMatchObject({ labelled: 1, recall: 1, precision: 1 });
    expect(score.misses).toEqual([]);
    expect(score.falsePositives).toEqual([]);
  });

  it('reports a missed category as a miss, and lowers its recall', async () => {
    const score = await scoreSensitivity(cases, (c) =>
      Promise.resolve(c.id === 'b' ? ['deal'] : c.categories)
    );
    expect(score.byCategory.not_public.recall).toBe(0);
    // The group was still flagged, by `deal`.
    expect(score.byGroup.commercial.recall).toBe(1);
    expect(score.misses).toEqual([{ caseId: 'b', label: 'not_public' }]);
  });

  it('counts a flag on a message that must not flag against precision', async () => {
    const score = await scoreSensitivity(cases, (c) =>
      Promise.resolve(c.id === 'c' ? ['health'] : c.categories)
    );
    expect(score.byGroup.personal.precision).toBe(0.5);
    expect(score.byCategory.health.precision).toBe(0.5);
    expect(score.falsePositives).toEqual([{ caseId: 'c', label: 'health' }]);
  });

  it('reports a drop in recall or precision, and a changed corpus, as a regression', () => {
    const before: RecordedSet = {
      cases: 2,
      groups: { personal: { labelled: 4, recall: 1, precision: 1 } },
      categories: {},
    };
    expect(regressions(before, before)).toEqual([]);
    expect(
      regressions(before, {
        ...before,
        groups: { personal: { labelled: 4, recall: 0.75, precision: 1 } },
      })
    ).toEqual(['group personal: recall 1 → 0.75']);
    expect(
      regressions(before, {
        ...before,
        groups: { personal: { labelled: 4, recall: 1, precision: 0.5 } },
      })
    ).toEqual(['group personal: precision 1 → 0.5']);
    expect(regressions(before, { ...before, cases: 3 })).toEqual([
      'case count 2 → 3: the corpus changed',
    ]);
    expect(regressions(before, { ...before, groups: {} })).toEqual([
      'group personal: recorded but no longer measured',
    ]);
  });
});

describe.each([
  ['development', DEVELOPMENT_CORPUS, baseline.development],
  ['heldOut', HELD_OUT_CORPUS, baseline.heldOut],
] as const)('the %s corpus', (name, cases, recordedSet: RecordedSet) => {
  it('has unique case ids', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('labels every core category, and carries messages that must not flag', () => {
    const labelled = new Set(cases.flatMap((c) => c.categories));
    expect([...labelled].sort()).toEqual(Object.keys(CORE_SENSITIVITY_CATEGORIES).sort());
    expect(cases.filter((c) => c.categories.length === 0).length).toBeGreaterThanOrEqual(25);
  });

  it('scores no lower than the recorded figures for any group or category', async () => {
    const now = measured(cases, await scoreWithCore(cases));
    const problems = regressions(recordedSet, now);
    expect(
      problems,
      `${name} regressed:\n  ${problems.join('\n  ')}\n\nTo record the new figures, replace baseline.json's "${name}" with:\n${JSON.stringify(now, null, 2)}`
    ).toEqual([]);
  });
});
