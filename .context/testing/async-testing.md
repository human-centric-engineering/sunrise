# Async Testing Patterns

Patterns for testing asynchronous code and time-dependent behavior in Sunrise.

---

## Testing Async Functions

### Basic Async Pattern

```typescript
describe('validateRequestBody()', () => {
  it('should parse and validate correct data', async () => {
    // Arrange: Mock async request.json()
    const validData = { name: 'John', email: 'john@example.com' };
    const mockJsonFn = vi.fn().mockResolvedValue(validData);
    const mockRequest = {
      json: mockJsonFn,
    } as unknown as NextRequest;

    // Act: Await async validation
    const result = await validateRequestBody(mockRequest, schema);

    // Assert: Verify result and mock call
    expect(result).toEqual(validData);
    expect(mockJsonFn).toHaveBeenCalledTimes(1);
  });
});
```

### Testing Promise Rejections

```typescript
it('should throw error for malformed JSON', async () => {
  // Arrange: Mock json() to reject
  const mockRequest = {
    json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
  } as unknown as NextRequest;

  // Act & Assert: Use expect().rejects
  await expect(validateRequestBody(mockRequest, schema)).rejects.toThrow(
    'Invalid JSON in request body'
  );
});
```

---

## Fake Timers with React Testing Library

### The Problem

Vitest's fake timers (`vi.useFakeTimers()`) conflict with React Testing Library's async utilities. This causes tests to timeout because:

1. **`waitFor` uses real timers** - It polls with `setTimeout` internally, which never fires when fake timers are active
2. **`userEvent` uses real timers** - Its internal delays and async handling break with fake timers
3. **Test pollution** - If a test with fake timers fails or doesn't clean up, subsequent tests inherit broken timer state

### Anti-Pattern: Global Fake Timers

```typescript
// WRONG - This causes widespread timeouts
beforeEach(() => {
  vi.useFakeTimers();  // Breaks ALL async utilities
});

it('should hide message after timeout', async () => {
  const user = userEvent.setup();
  render(<Component />);

  await user.click(button);           // TIMEOUT - userEvent broken
  await waitFor(() => expect(...));   // TIMEOUT - waitFor broken

  vi.advanceTimersByTime(3000);

  await waitFor(() => expect(...));   // TIMEOUT - still broken
});
```

### Correct Pattern: Localized Fake Timers

```typescript
// Always clean up fake timers in afterEach
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();  // CRITICAL: Prevents test pollution
});

it('should hide success message after 3 seconds', async () => {
  // 1. Enable fake timers at START of test
  vi.useFakeTimers();

  // 2. Set up mocks
  vi.mocked(apiClient.patch).mockResolvedValue({ success: true });

  render(<Component />);

  // 3. Use fireEvent (not userEvent) for fake timer compatibility
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
    await Promise.resolve();  // Flush microtasks
  });

  // 4. Use synchronous assertions (not waitFor)
  expect(screen.getByText(/success/)).toBeInTheDocument();

  // 5. Advance time with act()
  act(() => {
    vi.advanceTimersByTime(3000);
  });

  // 6. Assert final state synchronously
  expect(screen.queryByText(/success/)).not.toBeInTheDocument();

  // 7. Restore real timers (also done in afterEach as safety net)
  vi.useRealTimers();
});
```

### Key Rules

**Note**: These rules apply specifically to **React component tests** using React Testing Library. For unit tests without React components, fake timers can be used more freely.

| Rule                                                  | Why                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| Never use `vi.useFakeTimers()` in `beforeEach`        | Breaks userEvent and waitFor for ALL tests                      |
| Always add `vi.useRealTimers()` to `afterEach`        | Prevents test pollution if a test fails mid-execution           |
| Use `fireEvent` instead of `userEvent`                | fireEvent is synchronous, userEvent has internal async handling |
| Wrap clicks in `act()` with `await Promise.resolve()` | Flushes React's microtask queue                                 |
| Use synchronous assertions, not `waitFor`             | waitFor's polling uses real setTimeout                          |
| Wrap `vi.advanceTimersByTime()` in `act()`            | Lets React process state updates from timers                    |

### When to Use Fake Timers

Only use fake timers when testing time-dependent behavior:

- Auto-hiding success/error messages (`setTimeout`)
- Debounced inputs
- Polling intervals
- Animation timing

For most tests, **real timers with `waitFor` work better** and are less error-prone.

### Complete Example

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('NotificationForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Do NOT use vi.useFakeTimers() here
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();  // Safety net for test pollution
  });

  // Regular test - uses real timers (preferred)
  it('should show success message on save', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(api.save).mockResolvedValue({ success: true });

    render(<NotificationForm />);

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();
    });
  });

  // Fake timer test - for testing auto-hide behavior
  it('should auto-hide success message after 3 seconds', async () => {
    vi.useFakeTimers();
    vi.mocked(api.save).mockResolvedValue({ success: true });

    render(<NotificationForm />);

    // Use fireEvent + act for fake timer compatibility
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      await Promise.resolve();
    });

    expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByText(/saved successfully/i)).not.toBeInTheDocument();

    vi.useRealTimers();
  });
});
```

---

## Timing Tests with delayed()

For database operations that need timing verification, use the `delayed()` helper:

```typescript
import { delayed } from '@/tests/types/mocks';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';

it('should measure database latency', async () => {
  // Arrange: Mock query with known 50ms delay
  vi.mocked(prisma.$queryRaw).mockImplementation(() => delayed([{ result: 1 }], 50) as any);

  // Act
  const result = await getDatabaseHealth();

  // Assert
  expect(result.latency).toBeGreaterThanOrEqual(50);
  expect(result.latency).toBeLessThan(100);
});
```

---

## Summary

**Key Rules**:

1. Use `async/await` for async functions
2. Use `expect().rejects` for testing rejections
3. Never use `vi.useFakeTimers()` in `beforeEach`
4. Always restore real timers in `afterEach`
5. Use `fireEvent` + `act()` with fake timers
6. Use `waitFor` with real timers (preferred)
7. Use `delayed()` for timing-sensitive mocks

**Related Documentation**:

- [Testing Overview](./overview.md) - Testing philosophy
- [Testing Patterns](./patterns.md) - General patterns
- [Mocking Strategies](./mocking.md) - Mock patterns
- [Testing History](./history.md) - Key learnings
