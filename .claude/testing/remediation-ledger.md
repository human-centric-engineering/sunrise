---
version: 1
scope: unit-tests
rubric_version: 2
rubric:
  clean: '0 signature hits AND 0 block patterns'
  minor: 'any sig hit or block finding, under Bad thresholds'
  bad: 'block_density >= 0.1 OR sig_density > 0.2'
  rotten: 'block_density > 0.3 OR block_sum > 8'
signatures:
  - empty_not_throw
  - find_then_defined
  - no_arg_called
  - tobe_true
  - clear_then_notcalled
block_patterns:
  - happy-path-only (hpo)
  - mock-proving (mp)
  - missing-error (me)
  - test-code-mismatch (tcm)
block_summary_format: 'hpo=N,mp=N,me=N,tcm=N'
---

# Test Remediation Ledger

Tracks grading of unit tests for codebase-wide remediation. Updated by `/test-triage scan` and `/test-triage rescan`. Used by `/test-triage worklist` to prioritise fixes.

Grades are deterministic given the signature/block counts — see rubric above.

## lib/auth

| file                                                      | grade | sig_hits | block_patterns        | test_count | last_head                                | last_scanned         | notes                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ----- | -------- | --------------------- | ---------- | ---------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/unit/lib/auth/config-database-hook.test.ts          | Minor | 0        | hpo=0,mp=0,me=1,tcm=0 | 26         | e6197f7c789f59f02fa513d2c685ef34fbba9bcf | 2026-04-18T20:46:00Z | Rescan→fix shortcut applied: A2 title corrected, getValidInvitation-throw test added. Remaining gap: `deleteInvitationToken` throwing after `getValidInvitation` succeeds is untested (outer catch logs + unblocks). Sonnet surfaced this on rescan (previous scan missed it) — classic narrow-audit variance.                                                                                                                    |
| tests/unit/lib/auth/config-sendResetPassword.test.ts      | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 17         | e6197f7c789f59f02fa513d2c685ef34fbba9bcf | 2026-04-18T22:39:11Z | Path B end-to-end: `sendResetPasswordHook` extracted as named export at `lib/auth/config.ts:245` (2nd hook extraction alongside `userCreateBefore/AfterHook`). All 14 tests rewritten to call real hook; 3 adds for `userName`/`resetUrl`/`expiresAt` prop-wiring via `ResetPasswordEmail` mock. Zero regex hits (6 `.not.toHaveBeenCalled()` correctly excluded by tightened `no_arg_called` regex). Rotten → Clean in one pass. |
| tests/unit/lib/auth/verification-status.test.ts           | Bad   | 4        | hpo=0,mp=3,me=0,tcm=1 | 21         | 6140d99a9c9d6ef42bda6d2514f8369323b3165d | 2026-04-18T18:12:06Z | 3 tests assert args/shape without checking returned status; "expired token" test indistinguishable from not-sent                                                                                                                                                                                                                                                                                                                  |
| tests/unit/lib/auth/config-afterEmailVerification.test.ts | Bad   | 0        | hpo=0,mp=3,me=0,tcm=0 | 11         | 7dfe6e5781e5e020e284e5393a56a7b7209f65b4 | 2026-04-18T18:12:06Z | Tests hit simulateAfterEmailVerification helper not real callback; 3 skip-path tests would pass with source deleted                                                                                                                                                                                                                                                                                                               |
| tests/unit/lib/auth/guards.test.ts                        | Bad   | 7        | hpo=0,mp=2,me=0,tcm=1 | 25         | 57587618184afca24f340c1451c35e535924bb03 | 2026-04-18T18:12:06Z | Handler-invocation tests mock-prove; duplicate USER 403 test                                                                                                                                                                                                                                                                                                                                                                      |
| tests/unit/lib/auth/client.test.ts                        | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 26         | 6c5d7099686e5cb214d2d7fc59c8dea5a41df612 | 2026-04-18T21:37:20Z | All 3 `tobe_true` matches annotated with `// test-review:accept tobe_true — <rationale>` (isPending x2, emailVerified x1) — legitimate structural assertions on boolean fields. First worked example of cross-tool accept annotations.                                                                                                                                                                                            |
| tests/unit/lib/auth/utils.test.ts                         | Minor | 2        | hpo=0,mp=2,me=0,tcm=1 | 36         | 6c5d7099686e5cb214d2d7fc59c8dea5a41df612 | 2026-04-18T18:12:06Z | isAuthenticated type-narrowing tests cannot falsify runtime; solid error coverage otherwise                                                                                                                                                                                                                                                                                                                                       |

## components/analytics

| file                                                       | grade | sig_hits | block_patterns        | test_count | last_head                                | last_scanned         | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ----- | -------- | --------------------- | ---------- | ---------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/unit/components/analytics/analytics-scripts.test.tsx | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 37         | c20354feffbedc3eeece51b70acec1464eb7cd3c | 2026-04-18T21:59:14Z | Zero confirmed sigs. 2 raw `find_then_defined` hits (L625, L680) are false positives — both followed by `getAttribute('nonce')` assertions on the found element. Candidates for `// test-review:accept find_then_defined` annotations if we want to kill regex noise on re-scans.                                                                                                                                                                        |
| tests/unit/components/analytics/page-tracker.test.tsx      | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 21         | 1e65f65773015ea1e76b6bc3b2cc5071a8bc709f | 2026-04-18T21:59:14Z | Zero-hit file — no regex matches, skipped Sonnet. Post-review-fix state on this folder is evidently holding up.                                                                                                                                                                                                                                                                                                                                          |
| tests/unit/components/analytics/user-identifier.test.tsx   | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 44         | 26fc6ab1aa5a957dc1e6bc83e919d362299c1ccc | 2026-04-18T21:59:14Z | Zero confirmed sigs. 23 raw `no_arg_called` hits on first scan — ALL `.not.toHaveBeenCalled()` (negative form, semantically specific). Surfaced a regex false-positive class; `no_arg_called` tightened post-scan to `[^t]\.toHaveBeenCalled\(\s*\)` (excludes negative form). Re-running the tightened regex on this file now yields 0 hits — future rescans skip Sonnet. 3 pre-existing `untested-path` annotations for jsdom SSR-guard limits remain. |
