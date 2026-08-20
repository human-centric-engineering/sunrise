/**
 * Tests for the `[Unreleased]` staleness rules.
 *
 * The headline case is `per line, not per bullet`, which reproduces the shape
 * that made a whole-bullet reading miss two of #625's six stale claims: round 4
 * rewrote the tail of an entry, and the entry then looked freshly written.
 *
 * @see scripts/ci/changelog-drift.ts
 */

import { describe, it, expect } from 'vitest';

import {
  extractUnreleasedBullets,
  findDrift,
  identifiersIn,
  MIN_IDENTIFIER,
  PREDATES_BRANCH,
  shaCandidatesIn,
  summarise,
  type BranchCommit,
  type ChangelogBullet,
} from '@/scripts/ci/changelog-drift';

const commit = (index: number, sha = `${index}`.repeat(8)): BranchCommit => ({
  index,
  sha,
  subject: `commit ${index}`,
});

describe('extractUnreleasedBullets', () => {
  it('returns nothing when there is no [Unreleased] section', () => {
    // Legitimate: this is the state right after a release is cut.
    expect(
      extractUnreleasedBullets('# Changelog\n\n## [0.9.0] — 2026-08-17\n\n- a thing\n')
    ).toEqual([]);
  });

  it('absorbs wrapped lines and nested bullets into the entry that owns them', () => {
    const source = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Fixed',
      '',
      '- **First.** This entry wraps',
      '  onto a second line,',
      '  - and carries a nested bullet.',
      '',
      '- **Second.** Standalone.',
      '',
      '## [0.9.0] — 2026-08-17',
      '',
      '- not this one',
    ].join('\n');

    const bullets = extractUnreleasedBullets(source);

    expect(bullets).toHaveLength(2);
    expect(bullets[0]).toMatchObject({ startLine: 7, endLine: 9 });
    expect(bullets[0].text).toContain('nested bullet');
    expect(bullets[1]).toMatchObject({ startLine: 11, endLine: 11 });
  });

  it('stops at the next section rather than running into the last release', () => {
    const source = [
      '## [Unreleased]',
      '',
      '- kept',
      '',
      '## [0.9.0] — 2026-08-17',
      '',
      '- dropped',
    ].join('\n');

    expect(extractUnreleasedBullets(source).map((b) => b.text)).toEqual(['- kept']);
  });

  it('ignores bullets inside a fenced code block', () => {
    // A changelog entry quoting a shell session is sample text, not a claim.
    const source = [
      '## [Unreleased]',
      '',
      '- **Real.** See below.',
      '',
      '```sh',
      '- not a bullet',
      '```',
      '',
      '- **Also real.**',
    ].join('\n');

    expect(extractUnreleasedBullets(source).map((b) => b.startLine)).toEqual([3, 9]);
  });

  it('does not let a fence of one character close a block opened by the other', () => {
    const source = [
      '## [Unreleased]',
      '',
      '~~~',
      '- inside',
      '```',
      '- still inside',
      '~~~',
      '',
      '- outside',
    ].join('\n');

    expect(extractUnreleasedBullets(source).map((b) => b.startLine)).toEqual([9]);
  });

  it('excludes trailing blank lines from an entry', () => {
    const source = ['## [Unreleased]', '', '- one line', '', '', '- another'].join('\n');

    expect(extractUnreleasedBullets(source)[0]).toMatchObject({ startLine: 3, endLine: 3 });
  });

  it('ends an entry at a category heading', () => {
    const source = [
      '## [Unreleased]',
      '',
      '### Added',
      '',
      '- added',
      '',
      '### Fixed',
      '',
      '- fixed',
    ].join('\n');

    expect(extractUnreleasedBullets(source).map((b) => b.text)).toEqual(['- added', '- fixed']);
  });
});

describe('identifiersIn', () => {
  it('takes backticked spans in order, without duplicates', () => {
    expect(identifiersIn('`lib/a.ts` then `lib/b.ts` then `lib/a.ts`')).toEqual([
      'lib/a.ts',
      'lib/b.ts',
    ]);
  });

  it('does not swallow the prose between two spans', () => {
    // A greedy match would return "a.ts` and `b.ts", which finds nothing.
    expect(identifiersIn('`a.ts` and `b.ts`')).toEqual(['a.ts', 'b.ts']);
  });

  it('strips a trailing call, because code never contains the empty form', () => {
    expect(identifiersIn('a new `useTimeout()` in `lib/hooks/`')).toEqual([
      'useTimeout',
      'lib/hooks/',
    ]);
  });

  it.each([['null'], ['false'], ['validate'], ['build'], ['lockfile'], ['hono']])(
    'drops `%s` — lowercase-only spans are prose, not names',
    (word) => {
      expect(identifiersIn(`something \`${word}\` something`)).toEqual([]);
    }
  );

  it.each([
    ['setTimeout', 'an internal capital'],
    ['CI_NODE_HEAP_MB', 'an underscore'],
    ['tests/setup.ts', 'a path separator'],
    ['node:http', 'a colon'],
    ['cores - 1', 'spaces and a digit'],
    ['chat-interface', 'a hyphen'],
    ['epub2', 'a digit'],
  ])('keeps `%s` — %s makes it a name', (token) => {
    expect(identifiersIn(`quoting \`${token}\` here`)).toEqual([token]);
  });

  it('drops spans too short to locate anything', () => {
    const short = 'x'.repeat(MIN_IDENTIFIER - 1);

    expect(identifiersIn(`\`${short}\` and \`${short}Y\``)).toEqual([`${short}Y`]);
  });
});

describe('shaCandidatesIn', () => {
  it('finds a short SHA', () => {
    expect(shaCandidatesIn('fixed in d23d458 on the branch')).toEqual(['d23d458']);
  });

  it.each([['defaced'], ['effaced'], ['facade']])(
    'ignores `%s` — hex-clean English, no digit',
    (word) => {
      expect(shaCandidatesIn(`the ${word} thing`)).toEqual([]);
    }
  );

  it('ignores a run of digits with no letter', () => {
    expect(shaCandidatesIn('raised to 81920000 bytes')).toEqual([]);
  });

  it('finds one inside a URL, which dies at a squash merge just the same', () => {
    expect(shaCandidatesIn('see https://example.com/commit/a1b2c3d')).toEqual(['a1b2c3d']);
  });

  it('deduplicates', () => {
    expect(shaCandidatesIn('a1b2c3d and again a1b2c3d')).toEqual(['a1b2c3d']);
  });
});

describe('findDrift', () => {
  const bullet: ChangelogBullet = {
    startLine: 10,
    endLine: 11,
    text: '- **Thing.** Uses `lib/a.ts`\n  and also `lib/b.ts`.',
  };

  it('flags an identifier a later commit changed', () => {
    const drift = findDrift(
      [bullet],
      new Map([
        [10, 2],
        [11, 2],
      ]),
      new Map([['lib/a.ts', [commit(5)]]])
    );

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ line: 10, token: 'lib/a.ts' });
    expect(drift[0].commits.map((c) => c.index)).toEqual([5]);
  });

  it('says nothing about a commit at or before the line it wrote', () => {
    const writtenAt = new Map([
      [10, 5],
      [11, 5],
    ]);

    expect(findDrift([bullet], writtenAt, new Map([['lib/a.ts', [commit(5), commit(4)]]]))).toEqual(
      []
    );
  });

  it('per line, not per bullet — a later edit must not mask an earlier claim', () => {
    // #625's CI-heap entry: round 4 rewrote its tail, so the whole bullet read
    // as freshly written and a round-1 claim on line 10 went unflagged.
    const drift = findDrift(
      [bullet],
      new Map([
        [10, 1], // written in round 1
        [11, 9], // rewritten in round 4
      ]),
      new Map([
        ['lib/a.ts', [commit(3)]], // changed after line 10 was written
        ['lib/b.ts', [commit(3)]], // but before line 11 was
      ])
    );

    expect(drift.map((finding) => finding.token)).toEqual(['lib/a.ts']);
  });

  it('treats a bullet inherited from before the branch as open to everything', () => {
    const drift = findDrift(
      [bullet],
      new Map([
        [10, PREDATES_BRANCH],
        [11, PREDATES_BRANCH],
      ]),
      new Map([['lib/b.ts', [commit(0)]]])
    );

    expect(drift.map((finding) => finding.token)).toEqual(['lib/b.ts']);
  });

  it('reports a repeated identifier once per entry', () => {
    const repeated: ChangelogBullet = {
      startLine: 10,
      endLine: 11,
      text: '- **Thing.** `lib/a.ts`\n  and `lib/a.ts` again.',
    };

    expect(
      findDrift(
        [repeated],
        new Map([
          [10, 1],
          [11, 1],
        ]),
        new Map([['lib/a.ts', [commit(4)]]])
      )
    ).toHaveLength(1);
  });

  it('stays silent about a line git could not attribute', () => {
    // Absent is not the same as PREDATES_BRANCH: one means "before the branch",
    // the other means "not read at all", and inventing a position for the
    // second would manufacture findings out of a git failure.
    expect(findDrift([bullet], new Map(), new Map([['lib/a.ts', [commit(9)]]]))).toEqual([]);
  });

  it('ignores an identifier no commit touched', () => {
    expect(findDrift([bullet], new Map([[10, 0]]), new Map())).toEqual([]);
  });
});

describe('summarise', () => {
  it('drops the bullet marker and keeps the first line', () => {
    expect(summarise({ startLine: 1, endLine: 2, text: '-   **Thing.** Detail\n  wrapped' })).toBe(
      '**Thing.** Detail'
    );
  });

  it('truncates to the requested width', () => {
    const long = { startLine: 1, endLine: 1, text: `- ${'x'.repeat(200)}` };

    expect(summarise(long, 10)).toHaveLength(10);
    expect(summarise(long, 10).endsWith('…')).toBe(true);
  });
});
