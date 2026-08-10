/**
 * Tests for the CHANGELOG structure rules.
 *
 * Every rule here exists because of a specific way the release process can
 * damage `CHANGELOG.md` — see the header of the module under test. The most
 * important case in this file is `the 0.8.1 incident`, which reproduces the
 * shape of the commit that actually shipped (`c968e131`) rather than an
 * invented one.
 *
 * @see scripts/ci/changelog-structure.ts
 */

import { describe, it, expect } from 'vitest';

import {
  checkChangelogStructure,
  checkReleaseHistoryPreserved,
  parseChangelog,
} from '@/scripts/ci/changelog-structure';

/** The shape of a healthy file, trimmed to the parts the rules look at. */
const VALID = `# Changelog

All notable changes to Sunrise will be documented in this file.

## [Unreleased]

## [0.2.0] — 2026-06-25

### Added

- A thing.

## [0.1.0] — 2026-06-24

### Fixed

- Another thing.
`;

/** Collapse to messages so assertions read as the failure a human would see. */
function messages(violations: Array<{ message: string }>): string[] {
  return violations.map((violation) => violation.message);
}

function check(source: string, sunriseVersion = '0.2.0'): string[] {
  return messages(checkChangelogStructure(source, { sunriseVersion }));
}

/** Asserts the comparison actually RAN and found nothing — not that it skipped. */
function expectCleanHistory(base: string, head: string): void {
  expect(checkReleaseHistoryPreserved(base, head)).toEqual({ violations: [], skipped: null });
}

describe('parseChangelog', () => {
  it('classifies Unreleased, releases and categories', () => {
    const parsed = parseChangelog(VALID);

    expect(parsed.unreleased).toEqual([5]);
    expect(parsed.releases).toEqual([
      { line: 7, version: '0.2.0', date: '2026-06-25' },
      { line: 13, version: '0.1.0', date: '2026-06-24' },
    ]);
    expect(parsed.categories).toEqual([
      { line: 9, label: 'Added', sectionLine: 7 },
      { line: 15, label: 'Fixed', sectionLine: 13 },
    ]);
    expect(parsed.violations).toEqual([]);
  });

  it('ignores headings inside fenced code blocks', () => {
    // Not hypothetical: CONTRIBUTING's release steps contain this literal
    // string, and quoting them into an entry would otherwise register as a
    // release heading whose version is `X.Y.Z`.
    const source = `## [Unreleased]

Quoting the release instructions:

\`\`\`
## [X.Y.Z] — YYYY-MM-DD
### Nonsense
\`\`\`

## [0.2.0] — 2026-06-25
`;
    const parsed = parseChangelog(source);

    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(parsed.categories).toEqual([]);
    expect(parsed.violations).toEqual([]);
  });

  it('reopens parsing after a tilde fence closes', () => {
    const source = `## [Unreleased]

~~~
## [9.9.9] — 2026-01-01
~~~

## [0.2.0] — 2026-06-25
`;
    expect(parseChangelog(source).releases.map((r) => r.version)).toEqual(['0.2.0']);
  });

  it('does not let a shorter inner fence close a longer outer one', () => {
    // CommonMark closes only on a run at least as long as the opening one, so
    // a ``` block nested inside a ```` block is content. Comparing the fence
    // *character* alone reopened parsing at the inner close and read the
    // headings between them as real — two bogus violations on a correct file.
    const source = `## [Unreleased]

\`\`\`\`md
\`\`\`
## [Unreleased]
## [9.9.9] — 2026-09-01
\`\`\`
\`\`\`\`

## [0.2.0] — 2026-06-25
`;
    const parsed = parseChangelog(source);

    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(parsed.unreleased).toEqual([1]);
    expect(check(source)).toEqual([]);
  });

  it('does not let a fence carrying an info string close an open block', () => {
    // A closing fence may not have an info string, so ```ts inside a ``` block
    // is content — otherwise a changelog entry showing two adjacent code
    // samples would reopen parsing between them.
    const source = `## [Unreleased]

\`\`\`
\`\`\`ts
## [9.9.9] — 2026-09-01
\`\`\`

## [0.2.0] — 2026-06-25
`;

    expect(parseChangelog(source).releases.map((r) => r.version)).toEqual(['0.2.0']);
  });

  it('reports an unclosed fence rather than silently skipping the rest', () => {
    // Silence is the worst response here: everything below goes unread and the
    // static rules then call the file clean. Before this, the fixture below
    // returned zero violations while 0.1.0 was never parsed at all.
    const source = `## [Unreleased]

## [0.2.0] — 2026-06-25

\`\`\`md
## [0.1.0] — 2026-06-24
`;

    expect(check(source)).toEqual([
      expect.stringContaining('Unclosed code fence — everything below line 5 was skipped'),
    ]);
    expect(parseChangelog(source).truncation).toEqual({ line: 5, kind: 'fence' });
  });

  it('reports ONLY the fence when the parse is truncated', () => {
    // Naming the fence is half the job. The heading lists are truncated, so
    // every cross-heading rule below is reasoning about a file nobody finished
    // reading — and would here add a confident, wrong "no release headings
    // found, but SUNRISE_VERSION is 0.2.0" on top.
    const source = `## [Unreleased]

\`\`\`

## [0.2.0] — 2026-06-25

## [0.1.0] — 2026-06-24
`;

    expect(check(source)).toEqual([expect.stringContaining('Unclosed code fence')]);
  });

  it('still reports per-heading problems found above the fence', () => {
    // Those were read before parsing stopped, so they are sound and worth
    // having — suppressing everything would trade one blind spot for another.
    const source = `## [Unreleased]

## [Next] — 2026-06-25

\`\`\`
`;

    expect(check(source)).toEqual([
      expect.stringContaining('Heading label "[Next]" is not a version'),
      expect.stringContaining('Unclosed code fence'),
    ]);
  });

  it('sees a heading indented up to three spaces', () => {
    // Markdown renders it as a heading, so the parser has to see it as one.
    // Otherwise the append-only rule reports it DELETED — a true failure
    // carrying a message that names the wrong cause.
    const source = `## [Unreleased]

  ## [0.2.0] — 2026-06-25

   ### Added
`;
    const parsed = parseChangelog(source);

    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(parsed.categories.map((category) => category.label)).toEqual(['Added']);
  });

  it('does not let a different fence character close an open fence', () => {
    // A `~~~` line inside a ``` block is content, not a closing fence — which
    // is exactly why one gets nested inside the other in the first place.
    // Treating it as a close would reopen parsing mid-block and read the
    // headings after it as real.
    const source = `## [Unreleased]

\`\`\`
~~~
## [9.9.9] — 2026-01-01
\`\`\`

## [0.2.0] — 2026-06-25
`;
    const parsed = parseChangelog(source);

    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(parsed.violations).toEqual([]);
  });

  it('does not read a heading inside an HTML comment as live', () => {
    // Commenting a heading out rather than deleting it satisfied the
    // append-only rule while the heading was invisible in the rendered file —
    // a clean bypass of the one rule this whole check exists for.
    const source = `## [Unreleased]

<!--
## [9.9.9] — 2026-09-01
### Draft
-->

## [0.2.0] — 2026-06-25
`;
    const parsed = parseChangelog(source);

    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(parsed.categories).toEqual([]);
    expect(parsed.violations).toEqual([]);
  });

  it('does not let a comment marker inside a fence start a comment', () => {
    // Whichever construct opened first stays in charge. A `<!--` in a code
    // sample is sample text, and treating it as a comment opener would swallow
    // everything after the fence closed.
    const source = `## [Unreleased]

\`\`\`html
<!--
\`\`\`

## [0.2.0] — 2026-06-25
`;
    const parsed = parseChangelog(source);

    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(parsed.truncation).toBeNull();
  });

  it('does not let a fence inside a comment start a code block', () => {
    // The mirror of the case above.
    const source = `## [Unreleased]

<!--
\`\`\`
-->

## [0.2.0] — 2026-06-25
`;
    const parsed = parseChangelog(source);

    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(parsed.truncation).toBeNull();
  });

  it('reports an unclosed HTML comment', () => {
    const source = `## [Unreleased]

## [0.2.0] — 2026-06-25

<!--
## [0.1.0] — 2026-06-24
`;

    expect(check(source)).toEqual([
      expect.stringContaining('Unclosed HTML comment — everything below line 5 was skipped'),
    ]);
    expect(parseChangelog(source).truncation).toEqual({ line: 5, kind: 'comment' });
  });

  it('treats a single-line comment as closed', () => {
    const source = `## [Unreleased]

<!-- a note -->

## [0.2.0] — 2026-06-25
`;
    const parsed = parseChangelog(source);

    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
    expect(parsed.truncation).toBeNull();
  });

  it('does not open a fence on a line of inline code spans', () => {
    // CommonMark forbids backticks in a backtick fence's info string, so this
    // is a paragraph. Reading it as a fence swallowed the rest of the file and
    // failed the run with "Unclosed code fence" on a correct changelog.
    const source = `## [Unreleased]

\`\`\`npm run validate\`\`\` is now first in the chain.

## [0.2.0] — 2026-06-25
`;
    const parsed = parseChangelog(source);

    expect(parsed.truncation).toBeNull();
    expect(parsed.releases.map((release) => release.version)).toEqual(['0.2.0']);
  });

  it('still opens a tilde fence whose info string contains backticks', () => {
    // The backtick restriction is specific to backtick fences.
    const source = `## [Unreleased]

~~~\`js\`
## [9.9.9] — 2026-09-01
~~~

## [0.2.0] — 2026-06-25
`;

    expect(parseChangelog(source).releases.map((r) => r.version)).toEqual(['0.2.0']);
  });

  it('leaves #### and deeper headings alone', () => {
    const parsed = parseChangelog(`## [Unreleased]

#### Not a category
`);
    expect(parsed.categories).toEqual([]);
    expect(parsed.violations).toEqual([]);
  });
});

describe('checkChangelogStructure', () => {
  it('passes a well-formed file', () => {
    expect(check(VALID)).toEqual([]);
  });

  it('accepts the real CHANGELOG.md', async () => {
    // The rules are worthless if they do not hold on the file they guard, and
    // this is the cheapest way to notice a rule that is subtly too strict.
    const { readFileSync } = await import('node:fs');
    const { SUNRISE_VERSION } = await import('@/lib/sunrise-version');
    const source = readFileSync('CHANGELOG.md', 'utf8');

    expect(check(source, SUNRISE_VERSION)).toEqual([]);
  });

  describe('version headings', () => {
    it('rejects a duplicated version', () => {
      const source = VALID.replace('## [0.1.0] — 2026-06-24', '## [0.2.0] — 2026-06-24');

      // Exactly one message. The order rule uses a strict comparison so
      // equality belongs to the duplicate rule alone; firing both turned one
      // bad edit into a summary line reading "2 structural problems".
      expect(check(source)).toEqual([
        expect.stringContaining('Duplicate heading for 0.2.0 (first is at line 7)'),
      ]);
    });

    it('rejects ascending order', () => {
      const source = `## [Unreleased]

## [0.1.0] — 2026-06-24

## [0.2.0] — 2026-06-25
`;

      expect(check(source, '0.1.0')).toEqual([
        expect.stringContaining('0.2.0 is not below 0.1.0 in descending order'),
      ]);
    });

    it('compares minor and patch, not just major', () => {
      const source = `## [Unreleased]

## [1.2.3] — 2026-06-25

## [1.2.10] — 2026-06-24
`;

      // String ordering would put "1.2.10" below "1.2.3"; SemVer does not.
      expect(check(source, '1.2.3')).toEqual([
        expect.stringContaining('1.2.10 is not below 1.2.3 in descending order'),
      ]);
    });

    // These mangle the OLDER heading so the topmost release still agrees with
    // SUNRISE_VERSION and the assertion isolates the rule under test.
    it('rejects a release heading with no date', () => {
      const source = VALID.replace('## [0.1.0] — 2026-06-24', '## [0.1.0]');

      expect(check(source)).toEqual([expect.stringContaining('`## [0.1.0]` is missing its date')]);
    });

    it.each([
      ['2026-13-01', 'a month that does not exist'],
      ['2026-02-30', 'a day that does not exist in that month'],
      ['26-06-24', 'a two-digit year'],
    ])('rejects the invalid date %s (%s)', (date) => {
      const source = VALID.replace('— 2026-06-24', `— ${date}`);

      expect(check(source)).toEqual([expect.stringContaining(`invalid date "${date}"`)]);
    });

    it('accepts the Keep a Changelog [YANKED] marker', () => {
      // Rejecting it would mean this check blocks the one edit it most exists
      // to support: recording that a release went out wrong.
      const source = VALID.replace('## [0.2.0] — 2026-06-25', '## [0.2.0] — 2026-06-25 [YANKED]');

      expect(check(source)).toEqual([]);
      expect(parseChangelog(source).releases[0]).toEqual({
        line: 7,
        version: '0.2.0',
        date: '2026-06-25',
      });
    });

    it('still rejects trailing junk that is not [YANKED]', () => {
      // Guard against the [YANKED] relaxation over-widening, not a regression
      // test — this passed before that change too, and is here so it keeps
      // passing after it.
      const source = VALID.replace(
        '## [0.1.0] — 2026-06-24',
        '## [0.1.0] — 2026-06-24 [WITHDRAWN]'
      );

      expect(check(source)).toEqual([
        expect.stringContaining('invalid date "2026-06-24 [WITHDRAWN]"'),
      ]);
    });

    it.each(['—', '–', '-'])('accepts "%s" as the date separator', (separator) => {
      // Sunrise writes an em dash; Keep a Changelog's own examples use a
      // hyphen. A fork choosing either is not making the mistake this file
      // exists to catch.
      const source = VALID.replace('— 2026-06-25', `${separator} 2026-06-25`);

      expect(check(source)).toEqual([]);
    });

    it('rejects a level-2 heading with no bracketed label', () => {
      const source = VALID.replace('## [0.2.0] — 2026-06-25', '## 0.2.0 — 2026-06-25');

      expect(check(source)).toEqual([
        expect.stringContaining('Level-2 heading "0.2.0 — 2026-06-25" is neither'),
        // …and the version is then genuinely absent, so the version rule fires
        // too. Reporting both is the point: one run, every problem.
        expect.stringContaining('Topmost release is 0.1.0'),
      ]);
    });

    it('rejects a bracketed label that is not a version', () => {
      const source = VALID.replace('## [0.2.0] — 2026-06-25', '## [Next] — 2026-06-25');

      expect(check(source)).toContainEqual(
        expect.stringContaining('Heading label "[Next]" is not a version')
      );
    });
  });

  describe('Unreleased', () => {
    it('requires it', () => {
      expect(check(VALID.replace('## [Unreleased]\n\n', ''))).toEqual([
        expect.stringContaining('No `## [Unreleased]` heading'),
      ]);
    });

    it('rejects a second one', () => {
      const source = VALID.replace('## [0.1.0] — 2026-06-24', '## [Unreleased]');

      expect(check(source)).toEqual([
        expect.stringContaining('Duplicate `## [Unreleased]` heading (first is at line 5)'),
      ]);
    });

    it('rejects a date on it', () => {
      const source = VALID.replace('## [Unreleased]', '## [Unreleased] — 2026-06-26');

      expect(check(source)).toEqual([
        expect.stringContaining('`## [Unreleased]` must not carry a date'),
      ]);
    });

    it('requires it above every release', () => {
      const source = `## [0.2.0] — 2026-06-25

## [Unreleased]

## [0.1.0] — 2026-06-24
`;

      expect(check(source)).toContainEqual(
        expect.stringContaining('`## [0.2.0]` appears above `## [Unreleased]` (line 3)')
      );
    });
  });

  describe('categories', () => {
    it('rejects a category outside the Keep a Changelog set', () => {
      const source = VALID.replace('### Added', '### Security Fixes');

      expect(check(source)).toEqual([
        expect.stringContaining('"### Security Fixes" is not a Keep a Changelog category'),
      ]);
    });

    it('rejects the same category twice in one section', () => {
      const source = VALID.replace('### Fixed', '### Added');
      const withDuplicate = `## [Unreleased]

### Added

- One.

### Added

- Two.

## [0.2.0] — 2026-06-25
`;

      expect(check(source)).toEqual([]); // different sections — see next case
      expect(check(withDuplicate)).toEqual([
        expect.stringContaining('Second "### Added" in the same section (first is at line 3)'),
      ]);
    });

    it('allows the same category in different sections', () => {
      // Keyed on the enclosing section, not globally — every release has an
      // `### Added`, so a global key would fail the whole file.
      const source = `## [Unreleased]

### Added

## [0.2.0] — 2026-06-25

### Added

## [0.1.0] — 2026-06-24

### Added
`;

      expect(check(source)).toEqual([]);
    });
  });

  describe('SUNRISE_VERSION agreement', () => {
    it('rejects a bump with no entry', () => {
      expect(check(VALID, '0.3.0')).toEqual([
        expect.stringContaining('Topmost release is 0.2.0 but `SUNRISE_VERSION`'),
      ]);
    });

    it('rejects an entry with no bump', () => {
      // The inverse of the above and just as damaging: the release reports
      // itself as the previous version at runtime, via /api/health.
      expect(check(VALID, '0.1.0')).toEqual([
        expect.stringContaining('Topmost release is 0.2.0 but `SUNRISE_VERSION`'),
      ]);
    });

    it('reports a file with no releases at all', () => {
      expect(check('## [Unreleased]\n', '0.2.0')).toEqual([
        expect.stringContaining('No release headings found, but `SUNRISE_VERSION` is 0.2.0'),
      ]);
    });
  });

  it('reports every problem in one pass', () => {
    // A release cut that got the heading wrong usually got it wrong more than
    // once, and a check that surfaces one problem per run is a check people
    // learn to route around.
    const source = `## [0.2.0] — 2026-13-01

### Nope

## [0.2.0] — 2026-06-24
`;

    expect(check(source, '0.3.0').length).toBeGreaterThanOrEqual(4);
  });
});

describe('checkReleaseHistoryPreserved', () => {
  it('accepts an unchanged file', () => {
    expectCleanHistory(VALID, VALID);
  });

  it('accepts a new release on top', () => {
    const next = VALID.replace(
      '## [Unreleased]',
      '## [Unreleased]\n\n## [0.3.0] — 2026-06-26\n\n### Added\n\n- New.'
    );

    expectCleanHistory(VALID, next);
  });

  it('accepts entries being moved out of Unreleased', () => {
    const base = `## [Unreleased]

### Added

- Pending.

## [0.2.0] — 2026-06-25
`;
    const released = `## [Unreleased]

## [0.3.0] — 2026-06-26

### Added

- Pending.

## [0.2.0] — 2026-06-25
`;

    expectCleanHistory(base, released);
  });

  it('rejects a deleted release heading', () => {
    const damaged = VALID.replace('## [0.1.0] — 2026-06-24\n\n', '');

    expect(messages(checkReleaseHistoryPreserved(VALID, damaged).violations)).toEqual([
      expect.stringContaining('`## [0.1.0] — 2026-06-24` was deleted (it was at line 13'),
    ]);
  });

  it('rejects a released heading renamed to another version', () => {
    // The literal 0.8.1 slip: the previous release's heading is consumed by
    // the replacement rather than left in place.
    const damaged = VALID.replace('## [0.1.0] — 2026-06-24', '## [0.2.1] — 2026-06-26');

    expect(messages(checkReleaseHistoryPreserved(VALID, damaged).violations)).toEqual([
      expect.stringContaining('`## [0.1.0] — 2026-06-24` was deleted'),
    ]);
  });

  it('tolerates a date correction', () => {
    // Presence only, deliberately: pinning dates would block the occasional
    // legitimate fix with no escape hatch, and a wrong date is a smaller harm
    // than a block of entries changing which release it belongs to.
    const corrected = VALID.replace('## [0.1.0] — 2026-06-24', '## [0.1.0] — 2026-06-23');

    expectCleanHistory(VALID, corrected);
  });

  it('ignores malformed headings in the base revision', () => {
    // The base may predate this check, and a contributor cannot fix history
    // from their branch anyway.
    const base = `## [Unreleased]

## [0.2.0]

## [0.1.0] — 2026-06-24
`;

    expectCleanHistory(base, VALID);
  });

  describe('when a parse is truncated by an unclosed fence', () => {
    const base = `## [Unreleased]

## [0.2.0] — 2026-06-25

## [0.1.0] — 2026-06-24
`;

    it('makes no comparison at all when HEAD is truncated', () => {
      // Every swallowed release looks deleted. Reporting that told the author
      // to re-add two headings sitting right there in the file, and buried the
      // one message naming the real defect.
      const head = `## [Unreleased]

\`\`\`

## [0.2.0] — 2026-06-25

## [0.1.0] — 2026-06-24
`;

      expect(checkReleaseHistoryPreserved(base, head)).toEqual({
        violations: [],
        skipped: 'head-truncated',
      });
    });

    it('makes no comparison when HEAD hides a heading in a comment', () => {
      // Commenting out `## [0.1.0]` used to pass the append-only rule outright:
      // the parser read it as live while the rendered file no longer showed it.
      // Now the comment is honoured, so 0.1.0 is genuinely absent and reported.
      const head = `## [Unreleased]

## [0.2.0] — 2026-06-25

<!--
## [0.1.0] — 2026-06-24
-->
`;

      expect(messages(checkReleaseHistoryPreserved(base, head).violations)).toEqual([
        expect.stringContaining('`## [0.1.0] — 2026-06-24` was deleted'),
      ]);
    });

    it('makes no comparison at all when the BASE is truncated', () => {
      // The opposite failure and the worse one: releases we never read cannot
      // be missed, so this genuine deletion of 0.1.0 would otherwise pass as a
      // clean comparison. `skipped` is what stops that reading as a pass.
      const truncatedBase = `## [Unreleased]

\`\`\`

## [0.2.0] — 2026-06-25

## [0.1.0] — 2026-06-24
`;
      const reallyDeleted = `## [Unreleased]

## [0.2.0] — 2026-06-25
`;

      expect(checkReleaseHistoryPreserved(truncatedBase, reallyDeleted)).toEqual({
        violations: [],
        skipped: 'base-truncated',
      });
    });
  });

  describe('the 0.8.1 incident', () => {
    // Reproduces the shape of c968e131, which merged to main and was tagged.
    // Cutting 0.8.1 replaced the block "## [Unreleased]\n\n## [0.8.0] — …"
    // and never re-added the 0.8.0 heading, so 0.8.0's entries — including two
    // migrations and two breaking changes — read as part of a patch release.
    const before = `## [Unreleased]

### Security

- Pending fix.

## [0.8.0] — 2026-08-04

### Security

- A prior fix.

## [0.7.0] — 2026-07-09
`;
    const shipped = `## [Unreleased]

## [0.8.1] — 2026-08-06

### Security

- Pending fix.

### Security

- A prior fix.

## [0.7.0] — 2026-07-09
`;

    it('is invisible to the four rules #550 proposed', () => {
      // Uniqueness, descending order, dates, and SUNRISE_VERSION agreement all
      // hold on the shipped file. Verified against the real commit, not just
      // this fixture. That is why the history rule exists.
      const parsed = parseChangelog(shipped);
      const versions = parsed.releases.map((release) => release.version);

      expect(new Set(versions).size).toBe(versions.length);
      expect(versions).toEqual(['0.8.1', '0.7.0']);
      expect(parsed.releases.every((release) => release.date !== '')).toBe(true);
      expect(versions[0]).toBe('0.8.1');
    });

    it('is caught statically by the duplicate-category rule', () => {
      // The absorbed section brings its own `### Security` with it, so this
      // fails in `npm run validate` with no git access at all.
      expect(check(shipped, '0.8.1')).toEqual([
        expect.stringContaining('Second "### Security" in the same section'),
      ]);
    });

    it('is caught by the history rule', () => {
      expect(messages(checkReleaseHistoryPreserved(before, shipped).violations)).toEqual([
        expect.stringContaining('`## [0.8.0] — 2026-08-04` was deleted'),
      ]);
    });
  });
});
