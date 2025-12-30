# Testing Gotchas & Solutions

Common pitfalls and their solutions for testing in Sunrise. These patterns have been validated across 559 tests.

---

## Critical Gotchas

### 1. ESLint Auto-Fix Removes `async` Keywords

**Problem**: ESLint auto-fix removes `async` from test functions that use helper functions with internal `await`, breaking tests with "await only valid in async function" errors.

**Solution**: ESLint rule `@typescript-eslint/require-await` is disabled for test files in `eslint.config.mjs`.

```typescript
// ✅ Safe - ESLint won't remove async
it('should handle async operations', async () => {
  const result = await someAsyncFunction();
  expect(result).toBeDefined();
});
```

**Status**: ✅ FIXED - Rule disabled in ESLint config

---

### 2. Unbound Method False Positives

**Problem**: ESLint rule `@typescript-eslint/unbound-method` flags Vitest mock assertions as unsafe, even though they follow official Vitest patterns.

**Solution**: Rule disabled for test files in `eslint.config.mjs`.

```typescript
// ✅ Safe - Standard Vitest pattern
import { vi } from 'vitest';
import { logger } from '@/lib/logging';

expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Error message', error);
expect(prisma.$queryRaw).toHaveBeenCalledWith(['SELECT 1']);
```

**Status**: ✅ FIXED - Rule disabled for test files

---

### 3. NODE_ENV Is Read-Only

**Problem**: Cannot set `process.env.NODE_ENV` directly in tests because Node.js marks it as read-only.

**Solution**: Use `Object.defineProperty()` to override the property descriptor.

```typescript
beforeEach(() => {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: 'production',
    writable: true,
    enumerable: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value: 'test',
    writable: true,
    enumerable: true,
    configurable: true,
  });
});
```

**Status**: ✅ DOCUMENTED - Use this pattern when testing environment-dependent behavior

---

### 4. Response.json() Type Safety

**Problem**: `Response.json()` returns `Promise<any>`, losing all type safety in tests.

**Solution**: Use `parseJSON()` helper from `tests/helpers/assertions.ts`.

```typescript
import { parseJSON } from '@/tests/helpers/assertions';

interface SuccessResponse {
  success: boolean;
  data: { id: string };
}

it('should return user data', async () => {
  const response = await GET();
  const body = await parseJSON<SuccessResponse>(response);

  expect(body.success).toBe(true); // Type-safe!
  expect(body.data.id).toBeDefined(); // Autocomplete works!
});
```

**Status**: ✅ IMPLEMENTED - Use `parseJSON()` helper for all response parsing

---

### 5. Mock Setup Timing

**Problem**: Environment variables must be set BEFORE module imports in `setup.ts`, otherwise modules that validate env vars at import time will fail.

**Solution**: Always set environment variables FIRST in test setup files.

```typescript
// ✅ CORRECT - tests/setup.ts

// 1. Set environment variables FIRST (before any imports)
Object.defineProperty(process.env, 'DATABASE_URL', {
  value: 'postgresql://test:test@localhost:5432/test',
  writable: true,
  enumerable: true,
  configurable: true,
});

// 2. NOW it's safe to import modules
import '@testing-library/jest-dom';
import { expect, vi } from 'vitest';
```

**Status**: ✅ DOCUMENTED - Follow this pattern in all setup files

---

### 6. Incomplete Mock Types

**Problem**: Inline mocks with incomplete type definitions cause recurring lint/type error cycles.

**Solution**: Always use shared mock factories from `tests/types/mocks.ts`.

```typescript
import { createMockHeaders, createMockSession } from '@/tests/types/mocks';

// ✅ CORRECT - Use factory functions
vi.mocked(headers).mockResolvedValue(createMockHeaders({ 'x-request-id': 'test-123' }) as any);

vi.mocked(auth.api.getSession).mockResolvedValue(
  createMockSession({ user: { id: 'user-123' } }) as any
);

// ❌ AVOID - Inline incomplete mocks
vi.mocked(headers).mockResolvedValue({
  get: vi.fn(() => null),
} as any);
```

**Status**: ✅ IMPLEMENTED - Shared factories in `tests/types/mocks.ts`

---

### 7. Type-Safe Assertions

**Problem**: Direct property access causes "possibly undefined" errors. Non-null assertions (`!`) have no runtime safety.

**Solution**: Use type guard helpers from `tests/helpers/assertions.ts`.

```typescript
import { assertDefined, assertHasProperty } from '@/tests/helpers/assertions';

// ✅ CORRECT - Use type guards
const parsed = JSON.parse(output);
assertDefined(parsed.meta);
expect(parsed.meta.userId).toBe('user-123'); // Type-safe!

assertHasProperty(response, 'error');
expect(response.error.code).toBe('VALIDATION_ERROR');

// ❌ AVOID - Direct access or non-null assertion
expect(parsed.meta.userId).toBe('user-123'); // Error: possibly undefined
expect(parsed.meta!.userId).toBe('user-123'); // Runtime risk
```

**Status**: ✅ IMPLEMENTED - Type guard helpers in `tests/helpers/assertions.ts`

---

### 8. PrismaPromise Type Compatibility

**Problem**: Prisma 7 returns `PrismaPromise<T>`, not standard `Promise<T>`, causing type mismatches in mocks.

**Solution**: Use `mockResolvedValue()` or `delayed()` helper, never manual Promise creation.

```typescript
import { delayed } from '@/tests/types/mocks';

// ✅ CORRECT - For immediate responses
vi.mocked(prisma.$queryRaw).mockResolvedValue([{ result: 1 }]);

// ✅ CORRECT - For timed async operations
vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 50) as any);

// ❌ AVOID - Manual Promise creation
vi.mocked(prisma.$queryRaw).mockImplementation(
  () => new Promise((resolve) => setTimeout(() => resolve([{ result: 1 }]), 50))
);
```

**Status**: ✅ IMPLEMENTED - Use `delayed()` helper from `tests/types/mocks.ts`

---

## Best Practices Summary

**Before Writing Tests**:

1. Import shared mock factories: `createMockHeaders()`, `createMockSession()`, `delayed()`
2. Import type guards: `assertDefined()`, `assertHasProperty()`, `parseJSON()`
3. Read `.context/testing/patterns.md` for AAA structure and code patterns
4. Check `.context/testing/mocking.md` for dependency-specific mocking strategies

**During Test Development**:

1. Use AAA (Arrange-Act-Assert) pattern with comments
2. Define response type interfaces for type-safe assertions
3. Mock at boundaries (database, auth, external APIs), not internal logic
4. Reset mocks in `beforeEach()` with `vi.clearAllMocks()`
5. Restore mocks in `afterEach()` with `vi.restoreAllMocks()`

**Before Committing**:

1. Run `npm test` - All tests must pass
2. Run `npm run lint` - Zero errors, zero warnings in test files
3. Run `npm run type-check` - Zero type errors
4. Check coverage with `npm run test:coverage`
5. Run `npm run validate` - All checks in one command

---

## ESLint Configuration

Test files have specific ESLint overrides in `eslint.config.mjs`:

```javascript
{
  files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
  rules: {
    '@typescript-eslint/require-await': 'off',        // Prevents async removal
    '@typescript-eslint/unbound-method': 'off',       // Allows Vitest mocks
    '@typescript-eslint/no-explicit-any': 'off',      // Allows strategic any in mocks
    '@typescript-eslint/no-unsafe-*': 'off',          // Allows test workarounds
    'no-console': 'off',                              // Allows debugging
  },
}
```

**Why**: Test code has different patterns than application code. These overrides prevent false positives while maintaining type safety where it matters.

---

## Related Documentation

**For implementation patterns and best practices**:

- `.context/testing/patterns.md` - AAA structure, shared mocks, type-safe assertions
- `.context/testing/mocking.md` - Dependency mocking strategies (Prisma, better-auth, Next.js, logger)
- `.context/testing/decisions.md` - Architectural rationale and ESLint rule decisions
- `.context/testing/history.md` - Key learnings and solutions (lint/type cycle prevention)
