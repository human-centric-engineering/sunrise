---
version: 2
scope: tests
rubric_version: 3
routing:
  tests/integration/**: integration
  tests/unit/**: unit
  default: unit
signatures:
  - empty_not_throw
  - find_then_defined
  - no_arg_called
  - tobe_true
  - clear_then_notcalled
rubrics:
  unit:
    clean: '0 signature hits AND 0 block patterns'
    minor: 'any sig hit or block finding, under Bad thresholds'
    bad: 'block_density >= 0.10 OR sig_density > 0.20'
    rotten: 'block_density > 0.30 OR block_sum > 8'
    block_patterns:
      - happy-path-only (hpo)
      - mock-proving (mp)
      - missing-error (me)
      - test-code-mismatch (tcm)
    block_summary_format: 'hpo=N,mp=N,me=N,tcm=N'
  integration:
    clean: '0 signature hits AND 0 block patterns'
    minor: 'any sig hit or block finding, under Bad thresholds'
    bad: 'block_density >= 0.15 OR sig_density > 0.25'
    rotten: 'block_density > 0.35 OR block_sum > 10'
    block_patterns:
      - auth-boundary-missing (abm)
      - status-code-missing (scm)
      - db-state-unchecked (dsu)
      - error-response-mismatch (erm)
    block_summary_format: 'abm=N,scm=N,dsu=N,erm=N'
---

# Test Remediation Ledger

Tracks grading of unit and integration tests for codebase-wide remediation. Updated by `/test-triage scan` and `/test-triage rescan`. Used by `/test-triage worklist` to prioritise fixes.

Test type is auto-detected from path (`tests/integration/**` → integration, else unit). Each row carries a `type` column so mixed-type folders sort/filter cleanly. Block patterns and rubric thresholds differ by type — see frontmatter.

Grades are deterministic given the signature/block counts — see rubric above.

## lib/auth

| file                                                      | type | grade | sig_hits | block_patterns        | test_count | last_head                                | last_scanned         | notes                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---- | ----- | -------- | --------------------- | ---------- | ---------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/unit/lib/auth/config-database-hook.test.ts          | unit | Minor | 0        | hpo=0,mp=0,me=1,tcm=0 | 27         | 9f336cd0a73061b9adaa8af9fbc14c9000139c4b | 2026-04-19T11:25:30Z | Rescan post /test-fix Finding 3: added isPasswordInvitation+requiresVerification=true coverage in 'after' hook. Remaining gap (me=1): deleteInvitationToken throwing inside the 'before' hook's valid-invitation branch (outer catch at config.ts:112). Regex false-positive on clear_then_notcalled — mid-loop clearAllMocks at L1129/L1154 are re-setups followed only by positive toHaveBeenCalledWith; consider adding `// test-review:accept clear_then_notcalled — <rationale>` to suppress future regex hits. |
| tests/unit/lib/auth/config-sendResetPassword.test.ts      | unit | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 17         | e6197f7c789f59f02fa513d2c685ef34fbba9bcf | 2026-04-18T22:39:11Z | Path B end-to-end: `sendResetPasswordHook` extracted as named export at `lib/auth/config.ts:245` (2nd hook extraction alongside `userCreateBefore/AfterHook`). All 14 tests rewritten to call real hook; 3 adds for `userName`/`resetUrl`/`expiresAt` prop-wiring via `ResetPasswordEmail` mock. Zero regex hits (6 `.not.toHaveBeenCalled()` correctly excluded by tightened `no_arg_called` regex). Rotten → Clean in one pass. |
| tests/unit/lib/auth/verification-status.test.ts           | unit | Bad   | 4        | hpo=0,mp=3,me=0,tcm=1 | 21         | 6140d99a9c9d6ef42bda6d2514f8369323b3165d | 2026-04-18T18:12:06Z | 3 tests assert args/shape without checking returned status; "expired token" test indistinguishable from not-sent                                                                                                                                                                                                                                                                                                                  |
| tests/unit/lib/auth/config-afterEmailVerification.test.ts | unit | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 11         | 9f336cd0a73061b9adaa8af9fbc14c9000139c4b | 2026-04-19T11:24:55Z | Bad→Clean after /test-fix: S1 extracted afterEmailVerificationHook as named export; simulate helper deleted; all 11 tests now call the real hook via direct import. Fourth and final hook extraction from config.ts — matches userCreateBefore/AfterHook and sendResetPasswordHook pattern.                                                                                                                                       |
| tests/unit/lib/auth/guards.test.ts                        | unit | Bad   | 7        | hpo=0,mp=2,me=0,tcm=1 | 25         | 57587618184afca24f340c1451c35e535924bb03 | 2026-04-18T18:12:06Z | Handler-invocation tests mock-prove; duplicate USER 403 test                                                                                                                                                                                                                                                                                                                                                                      |
| tests/unit/lib/auth/client.test.ts                        | unit | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 26         | 6c5d7099686e5cb214d2d7fc59c8dea5a41df612 | 2026-04-18T21:37:20Z | All 3 `tobe_true` matches annotated with `// test-review:accept tobe_true — <rationale>` (isPending x2, emailVerified x1) — legitimate structural assertions on boolean fields. First worked example of cross-tool accept annotations.                                                                                                                                                                                            |
| tests/unit/lib/auth/utils.test.ts                         | unit | Minor | 2        | hpo=0,mp=2,me=0,tcm=1 | 36         | 6c5d7099686e5cb214d2d7fc59c8dea5a41df612 | 2026-04-18T18:12:06Z | isAuthenticated type-narrowing tests cannot falsify runtime; solid error coverage otherwise                                                                                                                                                                                                                                                                                                                                       |

## components/analytics

| file                                                       | type | grade | sig_hits | block_patterns        | test_count | last_head                                | last_scanned         | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ---- | ----- | -------- | --------------------- | ---------- | ---------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/unit/components/analytics/analytics-scripts.test.tsx | unit | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 37         | c20354feffbedc3eeece51b70acec1464eb7cd3c | 2026-04-18T21:59:14Z | Zero confirmed sigs. 2 raw `find_then_defined` hits (L625, L680) are false positives — both followed by `getAttribute('nonce')` assertions on the found element. Candidates for `// test-review:accept find_then_defined` annotations if we want to kill regex noise on re-scans.                                                                                                                                                                        |
| tests/unit/components/analytics/page-tracker.test.tsx      | unit | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 21         | 1e65f65773015ea1e76b6bc3b2cc5071a8bc709f | 2026-04-18T21:59:14Z | Zero-hit file — no regex matches, skipped Sonnet. Post-review-fix state on this folder is evidently holding up.                                                                                                                                                                                                                                                                                                                                          |
| tests/unit/components/analytics/user-identifier.test.tsx   | unit | Clean | 0        | hpo=0,mp=0,me=0,tcm=0 | 44         | 26fc6ab1aa5a957dc1e6bc83e919d362299c1ccc | 2026-04-18T21:59:14Z | Zero confirmed sigs. 23 raw `no_arg_called` hits on first scan — ALL `.not.toHaveBeenCalled()` (negative form, semantically specific). Surfaced a regex false-positive class; `no_arg_called` tightened post-scan to `[^t]\.toHaveBeenCalled\(\s*\)` (excludes negative form). Re-running the tightened regex on this file now yields 0 hits — future rescans skip Sonnet. 3 pre-existing `untested-path` annotations for jsdom SSR-guard limits remain. |

## app/api/v1/contact

| file                                              | type        | grade | sig_hits | block_patterns        | test_count | last_head                                | last_scanned         | notes                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------- | ----- | -------- | --------------------- | ---------- | ---------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/unit/app/api/v1/contact/route.test.ts       | unit        | Bad   | 5        | hpo=0,mp=0,me=1,tcm=0 | 10         | ec7bbc166e48c1c43622aa4fb3f448b09bbb4c84 | 2026-04-19T14:53:07Z | First mixed-folder triage (unit+integration scanned together, per-type rubric applied). 5 `tobe_true` sigs all on `body.success`/`settled` — Sonnet confirms legitimate structural; candidates for `// test-review:accept tobe_true —` annotations. me=1: `sendEmail` throw path (catch block at route.ts:149) untested — email returning `{success:false}` is covered but sendEmail itself throwing is not. Density: block=0.10, sig=0.50. |
| tests/integration/api/v1/contact/route.test.ts    | integration | Bad   | 17       | abm=0,scm=0,dsu=0,erm=0 | 32         | ec7bbc166e48c1c43622aa4fb3f448b09bbb4c84 | 2026-04-19T14:53:07Z | First integration-rubric scan. All sigs structural — annotation-fixable (`tobe_true`, `no_arg_called`). 13 `tobe_true` on public-route `body.success` contract; 4 `no_arg_called` on duplicate `prisma.create` presence checks where write-path tests at L211/555 already assert full `toHaveBeenCalledWith` payload. Zero block-tier findings (public route so abm=0, every POST asserts response.status, DB state verified via prisma mock, errorResponse contract matches). Use `/test-triage fix` Path 0 → annotate then rescan. Density: block=0.00, sig=0.53. |
