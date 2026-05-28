/**
 * Tests: Sunrise platform version constant
 *
 * `SUNRISE_VERSION` is Sunrise's source-of-truth for the platform version
 * (the public-surface contract lives in `VERSIONING.md`). These tests defend
 * the two properties the rest of the codebase relies on:
 *
 *  1. The constant matches a **valid SemVer 2.0.0 shape**, so anything
 *     consuming it (the health endpoint payload, the eventual Hub discovery,
 *     CHANGELOG tooling) can rely on the format without re-validating.
 *  2. The Phase-1 value is the **explicit `'0.0.0'` placeholder**. The Phase 2
 *     PR (post-migration-squash) flips this to `'0.0.1'` and tags `v0.0.1` —
 *     this test makes that flip a deliberate, diff-visible change rather than
 *     a silent one. It is NOT a tautology: it asserts the *intended Phase-1
 *     placeholder*, which is a real, separate fact from the constant's value
 *     at any given moment. When Phase 2 lands, this expectation updates with
 *     the same commit that flips the constant.
 *
 * @see lib/sunrise-version.ts
 * @see VERSIONING.md
 * @see .instructions/versioning-proposal.md (Phase 1 vs Phase 2 sequencing)
 */

import { describe, it, expect } from 'vitest';
import { SUNRISE_VERSION } from '@/lib/sunrise-version';

/**
 * SemVer 2.0.0 regex from the official spec:
 *   https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
 *
 * Accepts MAJOR.MINOR.PATCH plus optional pre-release / build-metadata tails.
 * We don't relax it — even during 0.x, the *shape* is fixed; only the
 * stability guarantees attached to the number are loose.
 */
const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

describe('SUNRISE_VERSION', () => {
  it('matches the SemVer 2.0.0 shape', () => {
    // Guards a fork (or a Phase-2 typo) from setting the constant to a
    // non-SemVer string like 'unreleased' or '0.0' — downstream consumers
    // (health endpoint, Hub discovery) assume the shape.
    expect(SUNRISE_VERSION).toMatch(SEMVER_REGEX);
  });

  it('is the Phase-1 placeholder (0.0.0)', () => {
    // Phase 1 ships the versioning infrastructure with this explicit
    // placeholder; Phase 2 flips it to '0.0.1' along with dating the
    // CHANGELOG and tagging v0.0.1. If this assertion fails outside the
    // Phase-2 PR, someone has bumped the version without the rest of the
    // release process — read VERSIONING.md + CONTRIBUTING.md "Cutting a
    // release" before adjusting this test.
    expect(SUNRISE_VERSION).toBe('0.0.0');
  });
});
