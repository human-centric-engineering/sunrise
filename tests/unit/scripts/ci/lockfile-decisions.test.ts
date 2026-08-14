/**
 * Tests for the `.lockfile-decisions` acknowledgement rules.
 *
 * This module exists to make a supply-chain gate WEAKER in one specific,
 * reviewed way, so the tests that matter most are the ones proving it does not
 * become weaker in any other way. An acknowledgement that matched on the
 * package name alone, or covered a downgrade it does not name, would turn the
 * whole check into a formality.
 *
 * @see scripts/ci/lockfile-decisions.ts
 */

import { describe, it, expect } from 'vitest';

import {
  acknowledgedOverrideKeys,
  parseDecisions,
  partitionDowngrades,
  unusedDecisions,
} from '@/scripts/ci/lockfile-decisions';

const ACK =
  'downgrade node_modules/@types/node 26.2.0 -> 24.13.3   # pinned to runtime major (#584)';

function downgrade(name: string, from: string, to: string) {
  return { name, from, to };
}

describe('parseDecisions', () => {
  it('reads a downgrade line with its reason', () => {
    const { decisions, errors } = parseDecisions(ACK);

    expect(errors).toEqual([]);
    expect(decisions).toEqual([
      {
        kind: 'downgrade',
        name: 'node_modules/@types/node',
        from: '26.2.0',
        to: '24.13.3',
        reason: 'pinned to runtime major (#584)',
        line: 1,
      },
    ]);
  });

  it('reads an overrides line', () => {
    const { decisions, errors } = parseDecisions(
      'overrides adm-zip none -> "^0.6.0"   # epub2 pins ^0.5.10 (#601)'
    );

    expect(errors).toEqual([]);
    expect(decisions[0]).toMatchObject({
      kind: 'overrides',
      key: 'adm-zip',
      from: 'none',
      to: '"^0.6.0"',
      reason: 'epub2 pins ^0.5.10 (#601)',
    });
  });

  it('ignores blank lines and whole-line comments', () => {
    const { decisions, errors } = parseDecisions(`# header\n\n   \n${ACK}\n# trailing note\n`);

    expect(errors).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].line).toBe(4);
  });

  it('does not truncate an overrides payload containing a git spec', () => {
    // npm override values accept git specs, and `github:owner/repo#semver:^1`
    // carries a bare `#`. Splitting on the FIRST `#` truncated the payload so
    // the block could never be acknowledged — a mismatch that looked like a
    // real change.
    const { decisions, errors } = parseDecisions(
      'overrides adm-zip none -> "github:owner/repo#semver:^0.6.0"   # vendored (#601)'
    );

    expect(errors).toEqual([]);
    expect(decisions[0]).toMatchObject({
      key: 'adm-zip',
      to: '"github:owner/repo#semver:^0.6.0"',
      reason: 'vendored (#601)',
    });
  });

  it('FAILS an unreadable line rather than skipping it', () => {
    // A typo'd ACK that silently does nothing sends someone hunting for why
    // their gate still fires on a change they thought they had signed off.
    const { errors } = parseDecisions('downgade pkg 2.0.0 -> 1.0.0  # typo in the directive');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('line 1');
  });

  it('FAILS a decision with no reason', () => {
    expect(parseDecisions('downgrade pkg 2.0.0 -> 1.0.0').errors[0]).toContain('no reason given');
  });

  it('reports an empty file as no decisions and no errors', () => {
    expect(parseDecisions('')).toEqual({ decisions: [], errors: [] });
  });
});

describe('partitionDowngrades — what an ACK must NOT cover', () => {
  const { decisions } = parseDecisions(ACK);

  it('acknowledges the exact move it names', () => {
    const { acknowledged, gating } = partitionDowngrades(
      [downgrade('node_modules/@types/node', '26.2.0', '24.13.3')],
      decisions
    );

    expect(acknowledged).toHaveLength(1);
    expect(gating).toEqual([]);
  });

  it('does NOT cover the same package moving between different versions', () => {
    // The danger case: a blanket "@types/node downgrades are fine" would wave
    // through a later, unreviewed move.
    const { gating } = partitionDowngrades(
      [downgrade('node_modules/@types/node', '26.2.0', '20.0.0')],
      decisions
    );

    expect(gating).toHaveLength(1);
  });

  it('does NOT cover a different `from` version', () => {
    const { gating } = partitionDowngrades(
      [downgrade('node_modules/@types/node', '27.0.0', '24.13.3')],
      decisions
    );

    expect(gating).toHaveLength(1);
  });

  it('does NOT cover a different package', () => {
    const { gating } = partitionDowngrades(
      [downgrade('node_modules/jsdom', '26.2.0', '24.13.3')],
      decisions
    );

    expect(gating).toHaveLength(1);
  });

  it('does NOT cover a nested copy of the same package', () => {
    // Lockfile keys are paths, so `a/node_modules/pkg` is a different install
    // from the top-level one and deserves its own decision.
    const { gating } = partitionDowngrades(
      [downgrade('node_modules/foo/node_modules/@types/node', '26.2.0', '24.13.3')],
      decisions
    );

    expect(gating).toHaveLength(1);
  });

  it('gates everything when there are no decisions at all', () => {
    const { gating } = partitionDowngrades(
      [downgrade('node_modules/@types/node', '26.2.0', '24.13.3')],
      []
    );

    expect(gating).toHaveLength(1);
  });

  it('separates a mix, acknowledging only the named one', () => {
    const { acknowledged, gating } = partitionDowngrades(
      [
        downgrade('node_modules/@types/node', '26.2.0', '24.13.3'),
        downgrade('node_modules/prisma', '7.9.1', '7.1.0'),
      ],
      decisions
    );

    expect(acknowledged.map((c) => c.name)).toEqual(['node_modules/@types/node']);
    expect(gating.map((c) => c.name)).toEqual(['node_modules/prisma']);
  });
});

describe('acknowledgedOverrideKeys — keyed on the transition, not the result', () => {
  const ADD = parseDecisions('overrides adm-zip none -> "^0.6.0"  # epub2 pins ^0.5.10 (#601)');

  it('acknowledges the exact transition it names', () => {
    const keys = acknowledgedOverrideKeys(
      [{ key: 'adm-zip', from: null, to: '"^0.6.0"' }],
      ADD.decisions
    );

    expect(keys).toEqual(['adm-zip']);
  });

  it('does NOT acknowledge the REMOVAL of an override it approved adding', () => {
    // The hole this shape closes. Adding `ws` to fix a CVE gates and is
    // acknowledged; a later revert that drops it returns the block to an
    // earlier, already-approved shape. An ACK keyed on the resulting block
    // would wave that through and walk the patched transitive back.
    const keys = acknowledgedOverrideKeys(
      [{ key: 'adm-zip', from: '"^0.6.0"', to: null }],
      ADD.decisions
    );

    expect(keys).toEqual([]);
  });

  it('does NOT acknowledge a different value for the same key', () => {
    const keys = acknowledgedOverrideKeys(
      [{ key: 'adm-zip', from: null, to: '"^0.7.0"' }],
      ADD.decisions
    );

    expect(keys).toEqual([]);
  });

  it('does NOT acknowledge a different key', () => {
    expect(
      acknowledgedOverrideKeys([{ key: 'hono', from: null, to: '"^0.6.0"' }], ADD.decisions)
    ).toEqual([]);
  });

  it('acknowledges only the keys named, leaving others gating', () => {
    const two = parseDecisions(
      [
        'overrides adm-zip none -> "^0.6.0"  # approved (#601)',
        'overrides ws "^8.21.0" -> none      # NOT approved elsewhere (#1)',
      ].join('\n')
    );

    const keys = acknowledgedOverrideKeys(
      [
        { key: 'adm-zip', from: null, to: '"^0.6.0"' },
        { key: 'hono', from: '"^4"', to: '"^5"' },
      ],
      two.decisions
    );

    expect(keys).toEqual(['adm-zip']);
  });

  it('reads an overrides removal line', () => {
    const { decisions, errors } = parseDecisions('overrides ws "^8.21.0" -> none  # dropped (#1)');

    expect(errors).toEqual([]);
    expect(decisions[0]).toMatchObject({
      kind: 'overrides',
      key: 'ws',
      from: '"^8.21.0"',
      to: 'none',
    });
  });
});

describe('unusedDecisions — the fork-sync case', () => {
  it('reports an entry that matched nothing, without gating', () => {
    // A fork syncing upstream inherits every upstream decision, and only those
    // whose exact move this particular sync reproduces will match. An earlier
    // design gated on unmatched NEW entries and therefore failed every
    // fork-sync PR, telling maintainers to delete upstream's decisions. This
    // list is reported and never gates.
    const { decisions } = parseDecisions(ACK);

    expect(unusedDecisions(decisions, new Set())).toHaveLength(1);
  });

  it('reports nothing when every entry was used', () => {
    const { decisions } = parseDecisions(ACK);

    expect(unusedDecisions(decisions, new Set([1]))).toEqual([]);
  });
});
