/**
 * The precision and recall gate for core's local detectors (§127, t-989).
 *
 * Runs the labelled synthetic corpus through the detectors exactly as a call
 * would — `runPrivacyDetectors()`, so through the registry and core's
 * defaults — and compares every type's figures with what
 * `tests/fixtures/privacy/pii-corpus/baseline.json` records, for the
 * development set and the held-out set separately. It fails when any type's
 * recall or precision drops, and when the corpus itself changes without the
 * baseline being re-recorded: a deleted label raises recall, and the gate
 * would otherwise read that as an improvement.
 *
 * Raising a figure passes, and does not update the file. Record the new
 * figures (the failure message prints them) when a change is meant to move
 * them, and say why in the PR.
 *
 * The scorer is tested first, on detections whose answer is known, because a
 * scorer that cannot report a miss would make this gate pass on anything.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPrivacyAdaptersForTests } from '@/lib/privacy/adapters/registry';
import { runPrivacyDetectors } from '@/lib/privacy/adapters/run';
import { DEVELOPMENT_CORPUS, HELD_OUT_CORPUS } from '@/tests/fixtures/privacy/pii-corpus';
import baseline from '@/tests/fixtures/privacy/pii-corpus/baseline.json';
import {
  labelRanges,
  scoreCorpus,
  type CorpusScore,
} from '@/tests/fixtures/privacy/pii-corpus/score';
import type { CorpusCase } from '@/tests/fixtures/privacy/pii-corpus/types';

// Core's detectors only: a fork's own detectors are not what this measures.
vi.mock('@/lib/app/privacy-adapters', () => ({ initAppPrivacyAdapters: () => undefined }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

interface RecordedType {
  labelled: number;
  recall: number | null;
  precision: number | null;
}

interface RecordedSet {
  cases: number;
  types: Record<string, RecordedType>;
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);

function measured(cases: readonly CorpusCase[], score: CorpusScore): RecordedSet {
  return {
    cases: cases.length,
    types: Object.fromEntries(
      Object.entries(score.byType)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, s]) => [
          type,
          { labelled: s.labelled, recall: round(s.recall), precision: round(s.precision) },
        ])
    ),
  };
}

async function scoreWithCore(cases: readonly CorpusCase[]): Promise<CorpusScore> {
  return scoreCorpus(cases, async (c) => {
    const result = await runPrivacyDetectors(c.text, {
      scopeId: c.id,
      knownValues: c.knownValues ?? [],
    });
    // A core detector failing would make every figure meaningless.
    expect(result.failures).toEqual([]);
    return result.spans;
  });
}

/** Every way `now` is worse than `recorded`, as readable lines. */
function regressions(recorded: RecordedSet, now: RecordedSet): string[] {
  const problems: string[] = [];
  if (recorded.cases !== now.cases) {
    problems.push(`case count ${recorded.cases} → ${now.cases}: the corpus changed`);
  }
  const types = new Set([...Object.keys(recorded.types), ...Object.keys(now.types)]);
  for (const type of [...types].sort()) {
    const r = recorded.types[type];
    const n = now.types[type];
    if (!r) {
      problems.push(`${type}: measured but not recorded`);
      continue;
    }
    if (!n) {
      problems.push(`${type}: recorded but no longer labelled or detected`);
      continue;
    }
    if (r.labelled !== n.labelled) {
      problems.push(`${type}: labelled ${r.labelled} → ${n.labelled}: the corpus changed`);
    }
    if (r.recall !== null && (n.recall ?? 0) < r.recall) {
      problems.push(`${type}: recall ${r.recall} → ${n.recall}`);
    }
    // No detections at all leaves precision undefined; recall catches that case.
    if (r.precision !== null && n.precision !== null && n.precision < r.precision) {
      problems.push(`${type}: precision ${r.precision} → ${n.precision}`);
    }
  }
  return problems;
}

beforeEach(() => {
  __resetPrivacyAdaptersForTests();
});

describe('the scorer', () => {
  const one: CorpusCase = {
    id: 'scorer',
    domain: 'support',
    text: 'Email jo@example.com or ring Sam.',
    labels: [
      { type: 'EMAIL', value: 'jo@example.com' },
      { type: 'PERSON', value: 'Sam' },
    ],
  };

  it('counts a value covered by a span of any type as recalled', async () => {
    const score = await scoreCorpus([one], () =>
      Promise.resolve([
        { type: 'EMAIL', start: 6, end: 20 },
        { type: 'ORG', start: 29, end: 32 },
      ])
    );
    expect(score.byType.EMAIL.recall).toBe(1);
    expect(score.byType.PERSON.recall).toBe(1);
    expect(score.misses).toEqual([]);
  });

  it('counts a value covered only in part as missed', async () => {
    const score = await scoreCorpus([one], () =>
      Promise.resolve([{ type: 'EMAIL', start: 6, end: 18 }])
    );
    expect(score.byType.EMAIL.recall).toBe(0);
    expect(score.byType.PERSON.recall).toBe(0);
    expect(score.misses.map((m) => m.value)).toEqual(['jo@example.com', 'Sam']);
  });

  it('counts a span over nothing labelled against its type’s precision', async () => {
    const score = await scoreCorpus([one], () =>
      Promise.resolve([
        { type: 'EMAIL', start: 6, end: 20 },
        { type: 'PERSON', start: 0, end: 5 },
      ])
    );
    expect(score.byType.EMAIL.precision).toBe(1);
    expect(score.byType.PERSON.precision).toBe(0);
    expect(score.falsePositives).toEqual([{ caseId: 'scorer', type: 'PERSON', value: 'Email' }]);
  });

  it('labels whole words only, and the occurrence asked for', () => {
    const text = 'Sam met Samantha and Sam.';
    expect(labelRanges(text, { type: 'PERSON', value: 'Sam' }, 'c')).toEqual([
      { start: 0, end: 3 },
      { start: 21, end: 24 },
    ]);
    expect(labelRanges(text, { type: 'PERSON', value: 'Sam', occurrence: 2 }, 'c')).toEqual([
      { start: 21, end: 24 },
    ]);
  });

  it('fails loudly on a label that is not in the text', () => {
    expect(() => labelRanges('hello', { type: 'PERSON', value: 'Sam' }, 'c')).toThrow(
      /not in the text/
    );
    expect(() => labelRanges('Sam', { type: 'PERSON', value: 'Sam', occurrence: 2 }, 'c')).toThrow(
      /no occurrence 2/
    );
  });

  it('reports a drop in recall or precision, and a changed corpus, as a regression', () => {
    const recorded: RecordedSet = {
      cases: 2,
      types: { EMAIL: { labelled: 4, recall: 1, precision: 1 } },
    };
    expect(regressions(recorded, recorded)).toEqual([]);
    expect(
      regressions(recorded, {
        cases: 2,
        types: { EMAIL: { labelled: 4, recall: 0.75, precision: 1 } },
      })
    ).toEqual(['EMAIL: recall 1 → 0.75']);
    expect(
      regressions(recorded, {
        cases: 2,
        types: { EMAIL: { labelled: 4, recall: 1, precision: 0.5 } },
      })
    ).toEqual(['EMAIL: precision 1 → 0.5']);
    expect(
      regressions(recorded, {
        cases: 2,
        types: { EMAIL: { labelled: 3, recall: 1, precision: 1 } },
      })
    ).toEqual(['EMAIL: labelled 4 → 3: the corpus changed']);
    expect(regressions(recorded, { cases: 2, types: {} })).toEqual([
      'EMAIL: recorded but no longer labelled or detected',
    ]);
  });
});

describe.each([
  ['development', DEVELOPMENT_CORPUS, baseline.development],
  ['heldOut', HELD_OUT_CORPUS, baseline.heldOut],
] as const)('the %s corpus', (name, cases, recorded) => {
  it('covers every domain', () => {
    const domains = new Set(cases.map((c) => c.domain));
    expect([...domains].sort()).toEqual([
      'adversarial',
      'b2b',
      'finance',
      'health',
      'hr',
      'support',
    ]);
  });

  it('has unique case ids', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('scores no lower than the recorded figures for any type', async () => {
    const now = measured(cases, await scoreWithCore(cases));
    const problems = regressions(recorded, now);
    expect(
      problems,
      `${name} regressed:\n  ${problems.join('\n  ')}\n\nTo record the new figures, replace baseline.json's "${name}" with:\n${JSON.stringify(now, null, 2)}`
    ).toEqual([]);
  });
});
