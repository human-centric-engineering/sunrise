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

A bare `vi.useFakeTimers()` does conflict with React Testing Library's async
utilities. Both `waitFor` and `userEvent` poll on `setTimeout`, so when the clock
stops they wait for a tick that never arrives and the test hangs to the 30s
`testTimeout`.

The fix is not to avoid fake timers in `beforeEach`. It is one option:

```typescript
vi.useFakeTimers({ shouldAdvanceTime: true });
```

`shouldAdvanceTime` keeps the clock advancing in real time (20ms per real
millisecond by default) while still letting you jump it forward with
`vi.advanceTimersByTime()`. `waitFor` and `userEvent` get their ticks; your
`setTimeout(…, 3000)` still fires the instant you advance to it.

### The Standard Pattern

Enable it in `beforeEach`, restore in `afterEach`, and use `userEvent` and
`waitFor` normally:

```typescript
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers(); // CRITICAL: prevents pollution if a test fails mid-flight
});

it('should hide the success message after 3 seconds', async () => {
  const user = userEvent.setup();
  render(<Component />);

  await user.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(screen.getByText(/success/)).toBeInTheDocument());

  act(() => {
    vi.advanceTimersByTime(3000);
  });

  await waitFor(() => expect(screen.queryByText(/success/)).not.toBeInTheDocument());
});
```

This is what the suite actually does: 13 files use `shouldAdvanceTime: true`,
eight of them from `beforeEach`, and they are the most `userEvent`/`waitFor`-heavy
component tests in the repo — `chat-interface.test.tsx` alone has 73 of each.

**One caveat that is real.** Because the clock keeps moving, a timer whose delay
is close to the wall-clock duration of the surrounding work can fire on its own
before you advance to it. If a test is sensitive to _exactly when_ a timer fires
rather than to the state after it fires, prefer an explicit
`vi.advanceTimersByTime()` immediately after the triggering action, or drop to
real timers for that one test. See the notes in `agents-table.test.tsx:859` and
`capabilities-table.test.tsx:299` where this was hit and worked around.

### Key Rules

**Note**: These rules apply specifically to **React component tests** using React Testing Library. For unit tests without React components, fake timers can be used more freely.

| Rule                                                        | Why                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| Pass `{ shouldAdvanceTime: true }` whenever RTL is involved | Bare `vi.useFakeTimers()` starves `waitFor` and `userEvent` of ticks     |
| Always add `vi.useRealTimers()` to `afterEach`              | Prevents test pollution if a test fails mid-execution                    |
| Wrap `vi.advanceTimersByTime()` in `act()`                  | Lets React process state updates from timers                             |
| Keep using `userEvent` and `waitFor`                        | With `shouldAdvanceTime` they work normally; `fireEvent` is not required |

### When to Use Fake Timers

Only use fake timers when testing time-dependent behavior:

- Auto-hiding success/error messages (`setTimeout`)
- Debounced inputs
- Polling intervals
- Animation timing

For tests with no timing dimension, real timers are simpler — but reaching for
them to dodge a hang is treating the symptom; `shouldAdvanceTime` is the fix.

### Complete Example

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('NotificationForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers(); // Safety net for test pollution
  });

  // No timing dimension — the fake clock is simply not in the way.
  it('should show success message on save', async () => {
    const user = userEvent.setup();
    vi.mocked(api.save).mockResolvedValue({ success: true });

    render(<NotificationForm />);

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();
    });
  });

  // Timing behaviour — same setup, plus an explicit advance.
  it('should auto-hide success message after 3 seconds', async () => {
    const user = userEvent.setup();
    vi.mocked(api.save).mockResolvedValue({ success: true });

    render(<NotificationForm />);

    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();
    });

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    await waitFor(() => {
      expect(screen.queryByText(/saved successfully/i)).not.toBeInTheDocument();
    });
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
3. Pass `{ shouldAdvanceTime: true }` to `vi.useFakeTimers()` in React component tests
4. Always restore real timers in `afterEach`
5. Wrap `vi.advanceTimersByTime()` in `act()`
6. `userEvent` and `waitFor` work under fake timers — you do not need `fireEvent`
7. Use `delayed()` for timing-sensitive mocks

**Related Documentation**:

- [Testing Overview](./overview.md) - Testing philosophy
- [Testing Patterns](./patterns.md) - General patterns
- [Mocking Strategies](./mocking.md) - Mock patterns
- [Testing History](./history.md) - Key learnings
