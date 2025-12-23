# Success Criteria & Quality Gates

This document defines the criteria for successful test implementation, including coverage thresholds, verification commands, and quality gates.

## Coverage Thresholds

### By Module

| Module                 | Threshold | Rationale                                   |
| ---------------------- | --------- | ------------------------------------------- |
| **Validation schemas** | **95%+**  | Mission-critical input validation, security |
| **Auth utilities**     | **90%+**  | Security-sensitive, session management      |
| **Error handler**      | **90%+**  | PII scrubbing must be exhaustive            |
| **API utilities**      | **85%+**  | Core infrastructure, error handling         |
| **Database utilities** | **85%+**  | Transaction management, health checks       |
| **General utilities**  | **85%+**  | Password strength, formatting               |
| **API endpoints**      | **80%+**  | Integration tests, HTTP lifecycle           |
| **Components**         | **70%+**  | Focus on critical user paths                |
| **Overall project**    | **80%+**  | Minimum acceptable coverage                 |

### Coverage Types

**Line Coverage**: Percentage of executable lines executed

- **Target**: 80%+ overall
- **Critical paths**: 90%+

**Branch Coverage**: Percentage of conditional branches tested

- **Target**: 75%+ overall
- **Critical paths**: 85%+

**Function Coverage**: Percentage of functions called

- **Target**: 80%+ overall
- **Critical paths**: 90%+

**Statement Coverage**: Percentage of statements executed

- **Target**: 80%+ overall
- **Critical paths**: 90%+

## Verification Commands

### Run All Tests

```bash
# Run all tests
npm test

# Expected output:
# ✓ All tests passing
# ✓ No failing or skipped tests
# ✓ Coverage report generated
```

### Run Specific Test Files

```bash
# Run single test file
npm test -- __tests__/lib/validations/auth.test.ts

# Run all validation tests
npm test -- __tests__/lib/validations

# Run all API tests
npm test -- __tests__/app/api
```

### Watch Mode (Development)

```bash
# Run tests in watch mode
npm run test:watch

# Automatically re-runs tests on file changes
# Useful during test-driven development
```

### Coverage Reports

```bash
# Generate coverage report
npm run test:coverage

# Output:
# - Terminal summary (coverage percentages)
# - HTML report: coverage/index.html
# - JSON report: coverage/coverage-final.json
```

### View Coverage Report

```bash
# Open HTML coverage report in browser
open coverage/index.html

# Or on Linux:
xdg-open coverage/index.html
```

## Quality Gates

### Pre-Commit Gates

**All tests must pass before committing:**

```bash
# Run validation script
npm run validate

# This runs:
# 1. Type check (tsc --noEmit)
# 2. Lint (eslint)
# 3. Format check (prettier --check)
# 4. Tests (vitest)
```

### CI/CD Gates

**Pull requests must pass:**

- ✅ All tests passing
- ✅ Coverage meets thresholds (80%+ overall)
- ✅ No TypeScript errors
- ✅ No ESLint warnings in test files
- ✅ All security tests passing (auth, PII scrubbing)

### Performance Gates

**Test execution time:**

- Unit tests: < 5 seconds (all)
- Integration tests: < 30 seconds (all)
- Total test suite: < 60 seconds

**If tests are too slow:**

- Review database cleanup (might be creating too much data)
- Check for unnecessary `await` statements
- Consider mocking instead of real database for some tests
- Parallelize test execution if needed

## Phase 2.4 Completion Checklist

### Infrastructure Setup

- [ ] Vitest installed and configured (`vitest.config.ts`)
- [ ] React Testing Library installed (`@testing-library/react`)
- [ ] Testcontainers installed (`@testcontainers/postgresql`)
- [ ] Test utilities created:
  - [ ] `lib/test-utils/setup.ts`
  - [ ] `lib/test-utils/factories.ts`
  - [ ] `lib/test-utils/mocks.ts`
  - [ ] `lib/test-utils/database.ts`

### Test Files Created

**Priority 1-2 (Simple):**

- [ ] `__tests__/lib/validations/auth.test.ts` (95%+ coverage)
- [ ] `__tests__/lib/validations/user.test.ts` (95%+ coverage)
- [ ] `__tests__/lib/validations/common.test.ts` (95%+ coverage)
- [ ] `__tests__/lib/utils/password-strength.test.ts` (85%+ coverage)
- [ ] `__tests__/lib/db/utils.test.ts` (85%+ coverage)

**Priority 3-4 (Medium):**

- [ ] `__tests__/lib/api/validation.test.ts` (85%+ coverage)
- [ ] `__tests__/lib/api/errors.test.ts` (85%+ coverage)
- [ ] `__tests__/lib/api/responses.test.ts` (85%+ coverage)
- [ ] `__tests__/lib/api/client.test.ts` (85%+ coverage)
- [ ] `__tests__/lib/errors/handler.test.ts` (90%+ coverage)

**Priority 5-6 (Complex):**

- [ ] `__tests__/lib/auth/utils.test.ts` (90%+ coverage)
- [ ] `__tests__/app/api/v1/users/route.test.ts` (80%+ coverage)
- [ ] `__tests__/app/api/v1/users/[id]/route.test.ts` (80%+ coverage)
- [ ] `__tests__/app/api/v1/users/me/route.test.ts` (80%+ coverage)

**Priority 7 (Components):**

- [ ] `__tests__/components/forms/login-form.test.tsx` (70%+ coverage)
- [ ] `__tests__/components/forms/signup-form.test.tsx` (70%+ coverage)

### Documentation

- [ ] Testing documentation created in `.context/testing/`:
  - [ ] `overview.md` - Testing philosophy, tech stack
  - [ ] `patterns.md` - Common testing patterns
  - [ ] `mocking.md` - Mock strategies
  - [ ] `integration.md` - Testcontainers setup
  - [ ] `troubleshooting.md` - Common issues
- [ ] `.context/guidelines.md` updated with testing workflow
- [ ] `.context/substrate.md` updated with testing domain

### Final Verification

- [ ] **All tests passing**: `npm test` shows all green
- [ ] **Coverage met**: `npm run test:coverage` shows 80%+ overall
- [ ] **No TypeScript errors**: `npm run type-check` passes
- [ ] **No lint errors**: `npm run lint` passes
- [ ] **Format check passes**: `npm run format:check` passes
- [ ] **Validate script passes**: `npm run validate` succeeds

## Troubleshooting

### Common Issues

**Issue: Tests timeout**

- **Cause**: Integration tests with Testcontainers can take 10-30s
- **Solution**: Increase timeout in `beforeAll`:
  ```typescript
  beforeAll(async () => {
    prisma = await startTestDatabase();
  }, 30000); // 30s timeout
  ```

**Issue: Coverage not meeting threshold**

- **Cause**: Missing edge cases or error paths
- **Solution**: Review coverage report, add tests for red lines
  ```bash
  npm run test:coverage
  open coverage/index.html  # Find untested code
  ```

**Issue: Flaky tests (sometimes pass, sometimes fail)**

- **Cause**: Test data not cleaned between tests
- **Solution**: Add `beforeEach` cleanup:
  ```typescript
  beforeEach(async () => {
    await clearTestDatabase(prisma);
  });
  ```

**Issue: Mocks not resetting between tests**

- **Cause**: Mock state carries over
- **Solution**: Clear mocks in `beforeEach`:
  ```typescript
  beforeEach(() => {
    vi.clearAllMocks();
  });
  ```

**Issue: "Cannot find module" errors**

- **Cause**: Path aliases not configured in Vitest
- **Solution**: Check `vitest.config.ts` has path alias:
  ```typescript
  resolve: {
    alias: { '@': path.resolve(__dirname, './') }
  }
  ```

**Issue: Tests fail in CI but pass locally**

- **Cause**: Environment differences (Node version, env vars)
- **Solution**: Check Node version, ensure env vars set in CI

## Next Steps After Phase 2.4

Once all success criteria are met:

1. **Commit tests**: Create PR with comprehensive test suite
2. **Enable CI/CD**: Add test runs to GitHub Actions / GitLab CI
3. **Monitor coverage**: Track coverage over time, maintain 80%+
4. **Add pre-commit hooks**: Ensure tests run before every commit
5. **Document patterns**: Add new patterns to `.context/testing/` as discovered
6. **Continuous improvement**: Refactor tests as codebase evolves

## Related Files

- **Priority Guide**: See `priority-guide.md` for test implementation order
- **Templates**: See `templates/` for test structure examples
- **Mocking**: See `mocking/` for dependency mocking strategies
