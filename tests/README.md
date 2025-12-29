# Sunrise Test Suite

This directory contains all tests for the Sunrise starter template.

## Quick Start

```bash
# Install dependencies (if not already installed)
npm install -D vitest @vitest/ui @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom @vitejs/plugin-react

# Run all tests
npm test

# Run tests in watch mode (recommended during development)
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run tests with UI
npm run test:ui
```

## Directory Structure

```
tests/
├── README.md                       # This file
├── setup.ts                        # Global test setup and mocks
├── helpers/                        # Test utilities and helpers
│   ├── mocks/                      # Mock implementations
│   │   ├── auth.ts                 # Mock auth sessions and users
│   │   ├── database.ts             # Mock Prisma client
│   │   ├── next.ts                 # Mock Next.js modules
│   │   └── logger.ts               # Mock logger
│   ├── factories/                  # Data factories for test fixtures
│   │   ├── user.ts                 # User data factory
│   │   ├── session.ts              # Session data factory
│   │   └── api.ts                  # API request/response factory
│   └── assertions/                 # Custom assertions
│       └── api.ts                  # API response assertions
├── unit/                           # Unit tests (isolated, mocked dependencies)
│   ├── auth/
│   │   └── utils.test.ts           # Auth utility tests
│   ├── validations/
│   │   ├── auth.test.ts            # Auth validation schema tests
│   │   ├── user.test.ts            # User validation schema tests
│   │   └── common.test.ts          # Common validation schema tests
│   ├── utils/
│   │   ├── utils.test.ts           # General utility tests (cn function)
│   │   └── password-strength.test.ts  # Password strength calculator tests
│   ├── api/
│   │   ├── responses.test.ts       # API response utility tests
│   │   ├── errors.test.ts          # Error handling tests
│   │   └── validation.test.ts      # Request validation tests
│   ├── db/
│   │   └── utils.test.ts           # Database utility tests
│   └── logging/
│       ├── logger.test.ts          # Logger class tests
│       └── context.test.ts         # Logging context utility tests
└── integration/                    # Integration tests (real dependencies where possible)
    ├── api/
    │   └── health.test.ts          # Health endpoint integration test
    └── README.md                   # Integration test guidelines
```

## Testing Philosophy

1. **Example-Driven**: Tests serve as examples of best practices, not exhaustive coverage
2. **Quality over Quantity**: Well-crafted tests that demonstrate patterns
3. **Independence**: Each test is independent and can run in any order
4. **Clarity**: Test names explain what is being tested and why
5. **Pragmatism**: Mock external dependencies, test real logic

## Test Types

### Unit Tests (`tests/unit/`)

Tests for individual functions and modules in isolation. External dependencies are mocked.

**When to write unit tests:**

- Pure functions (validation, utilities)
- Complex algorithms (password strength, scoring)
- API utilities (response formatting, error handling)
- Authentication logic (session management, role checking)

**Example:**

```typescript
describe('passwordSchema', () => {
  it('should accept valid password', () => {
    const result = passwordSchema.parse('Test@123');
    expect(result).toBe('Test@123');
  });

  it('should reject password without uppercase', () => {
    expect(() => passwordSchema.parse('test@123')).toThrow(
      'must contain at least one uppercase letter'
    );
  });
});
```

### Integration Tests (`tests/integration/`)

Tests that verify multiple components working together. Use real implementations where practical.

**When to write integration tests:**

- API endpoints (request → validation → business logic → response)
- Database operations (queries, transactions)
- Authentication flows (login → session → protected route)

**Example:**

```typescript
describe('GET /api/health', () => {
  it('should return healthy status with database connection', async () => {
    const response = await fetch('http://localhost:3000/api/health');
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.status).toBe('healthy');
  });
});
```

## Mock Strategy

### What to Mock

**Always Mock:**

- External APIs and services
- Next.js server-only modules (`next/headers`, `next/navigation`)
- Authentication (better-auth sessions)
- Database calls (Prisma client for unit tests)
- Environment variables
- Date/time (for deterministic tests)

**Never Mock:**

- Validation schemas (Zod)
- Pure utility functions
- Type definitions
- Constants

**Sometimes Mock:**

- Logger (mock for unit tests, use real for integration tests)
- Configuration objects (use real unless testing specific config scenarios)

### How to Mock

**Global Mocks** (in `tests/setup.ts`):

```typescript
// Mock Next.js modules for all tests
vi.mock('next/headers', () => ({
  headers: vi.fn(() => ({ get: vi.fn() })),
}));
```

**Per-Test Mocks**:

```typescript
// Mock specific behavior for this test
import { auth } from '@/lib/auth/config';
vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);
```

**Using Mock Helpers**:

```typescript
// Use predefined mocks from helpers
import { mockSession } from '@/tests/helpers/mocks/auth';
import { mockPrisma } from '@/tests/helpers/mocks/database';
```

## Test Patterns

### Arrange-Act-Assert (AAA)

Structure every test with clear sections:

```typescript
it('should calculate password strength correctly', () => {
  // Arrange: Set up test data
  const password = 'MyP@ssw0rd123';

  // Act: Execute the code under test
  const result = calculatePasswordStrength(password);

  // Assert: Verify the outcome
  expect(result.score).toBeGreaterThanOrEqual(3);
  expect(result.label).toBe('Good');
});
```

### Testing Async Functions

```typescript
it('should return user session when authenticated', async () => {
  // Mock async dependency
  vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

  // Await async function
  const result = await getServerSession();

  // Assert result
  expect(result).toEqual(mockSession);
});
```

### Testing Error Handling

```typescript
it('should throw error when user not found', async () => {
  // Mock to throw error
  vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('Not found'));

  // Assert error is thrown
  await expect(getUser('invalid-id')).rejects.toThrow('Not found');
});
```

### Testing Validation

```typescript
it('should validate email format', () => {
  // Valid case
  expect(emailSchema.parse('user@example.com')).toBe('user@example.com');

  // Invalid case
  expect(() => emailSchema.parse('invalid')).toThrow('Invalid email');
});
```

## Writing Good Tests

### Good Test Names

✅ **Good**: Descriptive and explains the scenario

- `should return user when authenticated`
- `should throw error when password is too short`
- `should sanitize PII from log output`

❌ **Bad**: Vague or implementation-focused

- `test getUser`
- `should work`
- `returns data`

### Test One Thing

✅ **Good**: Each test verifies one behavior

```typescript
it('should return 400 when email is invalid', () => {
  const response = validateEmail('invalid');
  expect(response.status).toBe(400);
});

it('should return error message when email is invalid', () => {
  const response = validateEmail('invalid');
  expect(response.error.message).toContain('Invalid email');
});
```

❌ **Bad**: Testing multiple behaviors

```typescript
it('should validate email and password and username', () => {
  // Testing too many things
});
```

### Keep Tests Independent

✅ **Good**: Each test sets up its own data

```typescript
it('should create user', () => {
  const user = createUser({ email: 'test@example.com' });
  expect(user).toBeDefined();
});

it('should update user', () => {
  const user = createUser({ email: 'test@example.com' });
  const updated = updateUser(user.id, { name: 'New Name' });
  expect(updated.name).toBe('New Name');
});
```

❌ **Bad**: Tests depend on shared state

```typescript
let sharedUser;

it('should create user', () => {
  sharedUser = createUser(); // Don't share state
});

it('should update user', () => {
  updateUser(sharedUser.id, ...); // Depends on previous test
});
```

## Coverage Goals

We aim for **meaningful coverage**, not 100%:

- **Critical paths** (auth, validation, security): 80%+
- **Business logic** (API routes, utilities): 70%+
- **UI components** (forms, layouts): 60%+
- **Simple utilities** (helpers): 50%+

**Priority**: Focus on testing complex logic, edge cases, and security-critical code.

## Running Tests

### All Tests

```bash
npm test
```

### Watch Mode (Best for Development)

```bash
npm run test:watch
```

### Specific Test File

```bash
npx vitest run tests/unit/validations/auth.test.ts
```

### Tests Matching Pattern

```bash
npx vitest run --grep "passwordSchema"
```

### Coverage Report

```bash
npm run test:coverage
```

### UI Mode (Browser-based)

```bash
npm run test:ui
```

## Debugging Tests

### VSCode Debugging

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Vitest Tests",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["run", "test:watch"],
  "console": "integratedTerminal",
  "internalConsoleOptions": "neverOpen"
}
```

### Console Logging

```typescript
it('should debug test', () => {
  const result = myFunction();
  console.log('Result:', result); // Shows in test output
  expect(result).toBe(expected);
});
```

### Inspect Mocks

```typescript
it('should call mock', () => {
  myFunction();
  console.log(mockFn.mock.calls); // See all calls
  expect(mockFn).toHaveBeenCalled();
});
```

## Common Issues

### Issue: "Cannot find module '@/lib/...'"

**Solution**: Check `vitest.config.ts` has path aliases:

```typescript
resolve: {
  alias: {
    '@': path.resolve(__dirname, './'),
  },
}
```

### Issue: Tests pass individually but fail together

**Solution**: Clear mocks in `beforeEach`:

```typescript
beforeEach(() => {
  vi.clearAllMocks();
});
```

### Issue: "Cannot access before initialization"

**Solution**: Use `vi.mocked()` for typed mocks:

```typescript
import { myModule } from '@/lib/module';
vi.mocked(myModule.method).mockReturnValue('value');
```

## Resources

- **Vitest Docs**: https://vitest.dev/
- **Testing Library**: https://testing-library.com/docs/react-testing-library/intro/
- **Test Plan**: See `/TEST-PLAN.md` for comprehensive implementation guide
- **Quick Reference**: See `/TEST-PLAN-SUMMARY.md` for quick start guide

## Contributing

When adding new features:

1. Write tests BEFORE or ALONGSIDE implementation
2. Follow existing test patterns in this directory
3. Use factories and mocks from `helpers/`
4. Keep tests focused and independent
5. Update this README if adding new patterns

---

**Happy Testing!** 🧪
