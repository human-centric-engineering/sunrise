/**
 * Tests for the `npm audit` triage rules.
 *
 * The fixtures are shaped from this repo's real `npm audit --json` output, not
 * invented: the gating decision turns on `fixAvailable`, which npm writes as
 * three different types, and a rule tested only against the convenient one is
 * a rule that has not been tested.
 *
 * @see scripts/ci/audit-advisories.ts
 */

import { describe, it, expect } from 'vitest';

import {
  atLeast,
  auditError,
  auditIsUsable,
  formatSummary,
  parseAuditReport,
  readFix,
  summarise,
  triage,
  type Advisory,
} from '@/scripts/ci/audit-advisories';

/** A report in npm's `auditReportVersion: 2` shape. */
function report(vulnerabilities: Record<string, unknown>): unknown {
  return { auditReportVersion: 2, vulnerabilities };
}

const advisory = (over: Partial<Advisory> = {}): Advisory => ({
  name: 'pkg',
  severity: 'high',
  direct: false,
  fix: 'available',
  fixTarget: null,
  titles: [],
  via: [],
  ...over,
});

describe('atLeast', () => {
  it.each([
    ['critical', 'high', true],
    ['high', 'high', true],
    ['moderate', 'high', false],
    ['low', 'moderate', false],
    ['info', 'info', true],
  ] as const)('%s vs floor %s → %s', (severity, floor, expected) => {
    expect(atLeast(severity, floor)).toBe(expected);
  });
});

describe('readFix', () => {
  it('reads npm’s boolean true as a plain available fix', () => {
    expect(readFix(true)).toEqual({ fix: 'available', fixTarget: null });
  });

  it('reads false as nothing published', () => {
    expect(readFix(false)).toEqual({ fix: 'none', fixTarget: null });
  });

  it('reads the object form and names the target', () => {
    expect(readFix({ name: 'next', version: '16.3.0', isSemVerMajor: false })).toEqual({
      fix: 'available',
      fixTarget: 'next@16.3.0',
    });
  });

  it('separates a fix that needs a major bump', () => {
    // Reported, never gated — a cron job must not decide a breaking upgrade.
    expect(readFix({ name: 'foo', version: '2.0.0', isSemVerMajor: true })).toEqual({
      fix: 'major',
      fixTarget: 'foo@2.0.0',
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'yes'],
  ])('treats %s as no fix rather than assuming one', (_label, value) => {
    expect(readFix(value).fix).toBe('none');
  });
});

describe('parseAuditReport', () => {
  it('flattens npm’s map into advisories', () => {
    const parsed = parseAuditReport(
      report({
        next: {
          name: 'next',
          severity: 'high',
          isDirect: true,
          fixAvailable: { name: 'next', version: '16.3.0', isSemVerMajor: false },
          via: [{ title: 'Next.js SSRF', url: 'https://example.test/1' }],
        },
      })
    );
    expect(parsed).toEqual([
      {
        name: 'next',
        severity: 'high',
        direct: true,
        fix: 'available',
        fixTarget: 'next@16.3.0',
        titles: ['Next.js SSRF'],
        via: [],
      },
    ]);
  });

  it('sorts by severity descending, then name', () => {
    const parsed = parseAuditReport(
      report({
        zeta: { severity: 'low', fixAvailable: true },
        alpha: { severity: 'critical', fixAvailable: true },
        beta: { severity: 'high', fixAvailable: true },
        gamma: { severity: 'high', fixAvailable: true },
      })
    );
    expect(parsed.map((a) => a.name)).toEqual(['alpha', 'beta', 'gamma', 'zeta']);
  });

  it('dedupes advisory titles, which via repeats per path', () => {
    const parsed = parseAuditReport(
      report({
        pkg: {
          severity: 'high',
          fixAvailable: true,
          via: [{ title: 'Same' }, { title: 'Same' }, { title: 'Other' }],
        },
      })
    );
    expect(parsed[0].titles).toEqual(['Same', 'Other']);
  });

  it('separates the bare package names npm mixes into via', () => {
    // `via` holds advisory objects AND bare package names for a package that
    // inherits the problem. Both halves are kept — the names are the only
    // thing there is to say about a row with no advisory of its own.
    const parsed = parseAuditReport(
      report({ pkg: { severity: 'high', fixAvailable: true, via: ['other-package'] } })
    );
    expect(parsed[0].titles).toEqual([]);
    expect(parsed[0].via).toEqual(['other-package']);
  });

  it('falls back to the map key when the entry omits a name', () => {
    expect(parseAuditReport(report({ 'some-pkg': { severity: 'high' } }))[0].name).toBe('some-pkg');
  });

  it('skips an entry with an unrecognised severity rather than guessing', () => {
    expect(parseAuditReport(report({ pkg: { severity: 'catastrophic' } }))).toEqual([]);
  });

  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['a report with no vulnerabilities block', { auditReportVersion: 2 }],
  ])('returns nothing for %s', (_label, input) => {
    expect(parseAuditReport(input)).toEqual([]);
  });
});

describe('auditIsUsable', () => {
  it('accepts a v2 report, including a clean one', () => {
    expect(auditIsUsable(report({}))).toBe(true);
  });

  it.each([
    ['a v1 report', { auditReportVersion: 1, vulnerabilities: {} }],
    ['no version marker', { vulnerabilities: {} }],
    ['no vulnerabilities block', { auditReportVersion: 2 }],
    ['an error payload', { error: { code: 'ENETUNREACH' } }],
    ['a non-object', 'nope'],
  ])('rejects %s', (_label, input) => {
    // A shape we cannot read parses to zero advisories, which looks exactly
    // like a clean tree. Green-because-blind is the worst failure available to
    // a security check, so the shape is checked rather than the count.
    expect(auditIsUsable(input)).toBe(false);
  });
});

describe('auditError', () => {
  it('reads npm’s registry-failure payload', () => {
    expect(
      auditError({ error: { code: 'ENETUNREACH', summary: 'request to registry failed' } })
    ).toBe('ENETUNREACH — request to registry failed');
  });

  it('says something even when the payload carries no detail', () => {
    expect(auditError({ error: {} })).toBe('npm reported an error with no detail');
  });

  it.each([
    ['a real report', { auditReportVersion: 2, vulnerabilities: {} }],
    ['a non-object', 'nope'],
    ['null', null],
  ])('returns null for %s', (_label, input) => {
    expect(auditError(input)).toBeNull();
  });
});

describe('triage', () => {
  const advisories: Advisory[] = [
    advisory({ name: 'fixable-high', severity: 'high', fix: 'available' }),
    advisory({ name: 'fixable-critical', severity: 'critical', fix: 'available' }),
    advisory({ name: 'major-high', severity: 'high', fix: 'major' }),
    advisory({ name: 'stuck-high', severity: 'high', fix: 'none' }),
    advisory({ name: 'fixable-moderate', severity: 'moderate', fix: 'available' }),
    advisory({ name: 'stuck-low', severity: 'low', fix: 'none' }),
  ];

  it('gates only on findings that are actionable today', () => {
    expect(triage(advisories).blocking.map((a) => a.name)).toEqual([
      'fixable-high',
      'fixable-critical',
    ]);
  });

  it('reports a major-only fix without gating on it', () => {
    const result = triage(advisories);
    expect(result.needsMajor.map((a) => a.name)).toEqual(['major-high']);
    expect(result.blocking).not.toContainEqual(expect.objectContaining({ name: 'major-high' }));
  });

  it('reports an unfixable high without gating on it', () => {
    // Two of this repo's eight high advisories had no fix when this landed.
    // Gating on them would red-line the job permanently for something nobody
    // can clear, and a job that is always red stops being read.
    const result = triage(advisories);
    expect(result.unfixable.map((a) => a.name)).toEqual(['stuck-high']);
    expect(result.blocking).not.toContainEqual(expect.objectContaining({ name: 'stuck-high' }));
  });

  it('puts everything below the floor aside regardless of fix state', () => {
    expect(triage(advisories).belowFloor.map((a) => a.name)).toEqual([
      'fixable-moderate',
      'stuck-low',
    ]);
  });

  it('starts gating the moment a fix is published', () => {
    // The self-clearing property that makes the allowlist unnecessary.
    const stuck = [advisory({ name: 'adm-zip', fix: 'none' })];
    expect(triage(stuck).blocking).toEqual([]);

    const fixed = [advisory({ name: 'adm-zip', fix: 'available', fixTarget: 'adm-zip@0.6.0' })];
    expect(triage(fixed).blocking.map((a) => a.name)).toEqual(['adm-zip']);
  });

  it('honours a raised floor', () => {
    const result = triage(advisories, 'critical');
    expect(result.blocking.map((a) => a.name)).toEqual(['fixable-critical']);
    // Everything else, including the three highs, is now below the floor.
    expect(result.belowFloor).toHaveLength(5);
    expect(result.unfixable).toEqual([]);
  });

  it('loses nothing — every advisory lands in exactly one bucket', () => {
    const result = triage(advisories);
    const total =
      result.blocking.length +
      result.needsMajor.length +
      result.unfixable.length +
      result.belowFloor.length;
    expect(total).toBe(advisories.length);
  });
});

describe('summarise', () => {
  it('counts every bucket, so a gate on a subset cannot imply the rest is clean', () => {
    const result = triage([
      advisory({ name: 'a', fix: 'available' }),
      advisory({ name: 'b', fix: 'none' }),
      advisory({ name: 'c', severity: 'low' }),
    ]);
    expect(summarise(result, 'high')).toBe(
      '1 fixable at high+, 0 needing a major bump, 1 with no fix, 1 below high.'
    );
  });
});

describe('formatSummary', () => {
  it('renders every bucket, including the ones that do not gate', () => {
    const markdown = formatSummary(
      triage([
        advisory({ name: 'next', fix: 'available', fixTarget: 'next@16.3.0' }),
        advisory({ name: 'adm-zip', fix: 'none' }),
        advisory({ name: 'big', fix: 'major', fixTarget: 'big@2.0.0' }),
        advisory({ name: 'undici', severity: 'moderate' }),
      ]),
      'high'
    );
    expect(markdown).toContain('`next`');
    expect(markdown).toContain('next@16.3.0');
    expect(markdown).toContain('`adm-zip`');
    expect(markdown).toContain('none published');
    expect(markdown).toContain('`big`');
    expect(markdown).toContain('`undici`');
  });

  it('says none rather than leaving an empty table', () => {
    expect(formatSummary(triage([]), 'high')).toContain('_None._');
  });

  it('does not announce a clean tree when unfixable findings remain', () => {
    const markdown = formatSummary(triage([advisory({ name: 'adm-zip', fix: 'none' })]), 'high');
    expect(markdown).toContain('No fixable high+ advisories.');
    expect(markdown).toContain('`adm-zip`');
  });

  it('cannot be made to restructure the table from an advisory title', () => {
    // Titles are third-party prose from the advisory database. A `|` adds
    // cells and a newline ends the table, which would let a crafted advisory
    // render its own text into a summary a maintainer reads as this job's
    // output — including a convincing all-clear.
    const markdown = formatSummary(
      triage([
        advisory({
          name: 'evil',
          titles: ['pwn |\n\n**No advisories found.**\n\n| x | y | z | w | v |'],
        }),
      ]),
      'high'
    );

    // The property that matters is containment, not absence: the text may
    // still appear, but only inside its own cell, visibly attributed to the
    // `evil` row. It must never reach a line of its own, where it would read
    // as this job's verdict.
    const lines = markdown.split('\n');
    const payloadLines = lines.filter((line) => line.includes('No advisories found.'));
    expect(payloadLines).toHaveLength(1);
    expect(payloadLines[0]).toContain('`evil`');

    // One row, still exactly five cells.
    const rows = lines.filter((line) => line.includes('`evil`'));
    expect(rows).toHaveLength(1);
    expect(rows[0].split('|')).toHaveLength(7); // 5 cells + leading/trailing
  });

  it('names what a package is vulnerable through when it has no advisory of its own', () => {
    // Two of the eight real high findings were in this shape and rendered an
    // empty Advisory cell: @react-email/ui via next, epub2 via adm-zip.
    const markdown = formatSummary(
      triage([advisory({ name: '@react-email/ui', titles: [], via: ['next'] })]),
      'high'
    );
    const row = markdown.split('\n').find((line) => line.includes('`@react-email/ui`'));
    expect(row).toContain('via next');
    // And no empty trailing cell.
    expect(row).not.toMatch(/\|\s*\|\s*$/);
  });

  it('prefers a real advisory title over the via fallback', () => {
    const markdown = formatSummary(
      triage([advisory({ name: 'next', titles: ['Next.js SSRF'], via: ['something'] })]),
      'high'
    );
    const row = markdown.split('\n').find((line) => line.includes('`next`'));
    expect(row).toContain('Next.js SSRF');
    expect(row).not.toContain('via something');
  });

  it('flags the extra advisories behind a package with several', () => {
    const markdown = formatSummary(
      triage([advisory({ name: 'next', titles: ['One', 'Two', 'Three'] })]),
      'high'
    );
    expect(markdown).toContain('One (+2 more)');
  });
});
