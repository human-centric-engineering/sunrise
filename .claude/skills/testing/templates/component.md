# Component Test Template - React Components

**Use Case**: Forms, interactive components, UI behavior with React Testing Library

**Complexity**: Medium (Hybrid Autonomy)
**Dependencies**: React, Next.js, better-auth client, react-hook-form
**Mocking**: Required for Next.js router, better-auth client

## Template Structure

```typescript
// __tests__/components/forms/login-form.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '@/components/forms/login-form';
import { authClient } from '@/lib/auth/client';

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => ({
    get: vi.fn(),
  }),
}));

// Mock better-auth client
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signIn: {
      email: vi.fn(),
    },
  },
}));

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render email and password fields', () => {
    render(<LoginForm />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('should allow user to type in fields', async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    const emailInput = screen.getByLabelText(/email/i);
    const passwordInput = screen.getByLabelText(/password/i);

    await user.type(emailInput, 'test@example.com');
    await user.type(passwordInput, 'password123');

    expect(emailInput).toHaveValue('test@example.com');
    expect(passwordInput).toHaveValue('password123');
  });

  it('should show validation errors for invalid email', async () => {
    const user = userEvent.setup();
    render(<LoginForm />);

    const emailInput = screen.getByLabelText(/email/i);
    const submitButton = screen.getByRole('button', { name: /sign in/i });

    await user.type(emailInput, 'invalid-email');
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/invalid email/i)).toBeInTheDocument();
    });
  });

  it('should call signIn on form submission', async () => {
    const user = userEvent.setup();
    const mockSignIn = vi.fn().mockResolvedValue({ data: { id: '1' } });

    vi.mocked(authClient.signIn.email).mockImplementation(mockSignIn);

    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Password123!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'Password123!',
      });
    });
  });

  it('should disable form during submission', async () => {
    const user = userEvent.setup();
    const mockSignIn = vi.fn(() => new Promise((resolve) => setTimeout(resolve, 100)));

    vi.mocked(authClient.signIn.email).mockImplementation(mockSignIn);

    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Password123!');

    const submitButton = screen.getByRole('button', { name: /sign in/i });
    await user.click(submitButton);

    expect(submitButton).toBeDisabled();
  });

  it('should show error message on failed login', async () => {
    const user = userEvent.setup();
    const mockSignIn = vi.fn().mockRejectedValue(new Error('Invalid credentials'));

    vi.mocked(authClient.signIn.email).mockImplementation(mockSignIn);

    render(<LoginForm />);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'WrongPassword!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument();
    });
  });
});
```

## Testing Checklist

For component tests, ensure you cover:

- [ ] **Rendering**: Component renders without errors
- [ ] **User interactions**: Typing, clicking, selecting work
- [ ] **Form validation**: Validation errors display correctly
- [ ] **Form submission**: Correct data passed to API
- [ ] **Loading states**: Buttons disabled, spinners shown
- [ ] **Error states**: Error messages displayed
- [ ] **Accessibility**: Proper labels, roles, ARIA attributes

## React Testing Library Queries (Priority Order)

Use queries in this priority (most to least accessible):

1. **`getByRole`**: Best for accessibility (buttons, links, inputs)
2. **`getByLabelText`**: Best for form fields
3. **`getByPlaceholderText`**: When labels aren't available
4. **`getByText`**: For non-interactive text
5. **`getByDisplayValue`**: For input values
6. **`getByAltText`**: For images
7. **`getByTitle`**: For tooltips
8. **`getByTestId`**: Last resort

## User Event Patterns

```typescript
import userEvent from '@testing-library/user-event';

// Setup user event
const user = userEvent.setup();

// Type in input
await user.type(screen.getByLabelText(/email/i), 'test@example.com');

// Click button
await user.click(screen.getByRole('button', { name: /submit/i }));

// Select option
await user.selectOptions(screen.getByLabelText(/country/i), 'US');

// Upload file
const file = new File(['content'], 'test.png', { type: 'image/png' });
await user.upload(screen.getByLabelText(/upload/i), file);

// Clear input
await user.clear(screen.getByLabelText(/search/i));

// Keyboard navigation
await user.tab(); // Move focus
await user.keyboard('{Enter}'); // Press key
```

## Async Testing Patterns

```typescript
// Wait for element to appear
await waitFor(() => {
  expect(screen.getByText(/success/i)).toBeInTheDocument();
});

// Wait for element to disappear
await waitFor(() => {
  expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
});

// Find (async query)
const element = await screen.findByText(/async content/i);
expect(element).toBeInTheDocument();

// Wait for assertion
await waitFor(
  () => {
    expect(mockFunction).toHaveBeenCalled();
  },
  { timeout: 3000 }
);
```

## Mocking Patterns

### Mock Next.js Router

```typescript
const mockPush = vi.fn();
const mockRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: mockRefresh,
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/current-path',
}));

// In test: verify navigation
expect(mockPush).toHaveBeenCalledWith('/dashboard');
```

### Mock better-auth Client

```typescript
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
  },
}));

// In test: setup mock behavior
vi.mocked(authClient.signIn.email).mockResolvedValue({
  data: { id: '1', email: 'test@example.com' },
});
```

## Tips

1. **Test user behavior**: Focus on what users see and do
2. **Use accessible queries**: Prefer `getByRole` and `getByLabelText`
3. **Async operations**: Always use `waitFor` for async UI updates
4. **User event over fireEvent**: `userEvent` is more realistic
5. **Don't test implementation**: Don't test state, test behavior
6. **Clear mocks**: Use `beforeEach(() => vi.clearAllMocks())`
7. **Mock at module level**: Mock Next.js/auth at top of file

## Common Pitfalls

❌ **Don't do this**:

```typescript
// Testing implementation details
expect(component.state.isLoading).toBe(true);

// Using getByTestId unnecessarily
expect(screen.getByTestId('submit-button')).toBeInTheDocument();

// Not waiting for async
user.type(input, 'text');
expect(screen.getByText(/submitted/i)).toBeInTheDocument(); // Might fail!
```

✅ **Do this instead**:

```typescript
// Test what user sees
expect(screen.getByRole('status')).toHaveTextContent('Loading...');

// Use accessible queries
expect(screen.getByRole('button', { name: /submit/i })).toBeInTheDocument();

// Wait for async
await user.type(input, 'text');
await waitFor(() => {
  expect(screen.getByText(/submitted/i)).toBeInTheDocument();
});
```

## Verification

```bash
# Run component tests
npm test -- __tests__/components

# Expected: All tests pass, 70%+ coverage
```

## Related Files

- **Source**: `components/forms/login-form.tsx`, `components/forms/signup-form.tsx`
- **Mocking**: See `../mocking/nextjs.md` and `../mocking/better-auth.md`
- **Other templates**: See `simple.md` for unit tests
