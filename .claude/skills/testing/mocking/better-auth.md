# Mocking better-auth

**When to use**: Unit tests for authentication utilities, component tests using auth client

**What to mock**: Session management, sign-in/sign-up/sign-out operations

## Server-Side Session Mocking

### Mock `auth.api.getSession()`

```typescript
import { vi } from 'vitest';

// Mock the auth config module
vi.mock('@/lib/auth/config', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// In tests, import and use
import { auth } from '@/lib/auth/config';

// Mock authenticated admin session
vi.mocked(auth.api.getSession).mockResolvedValue({
  session: {
    id: 'session-123',
    userId: 'user-123',
    token: 'session-token',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  },
  user: {
    id: 'user-123',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'ADMIN',
    emailVerified: new Date(),
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
});

// Mock unauthenticated (no session)
vi.mocked(auth.api.getSession).mockResolvedValue(null);

// Mock specific user role
vi.mocked(auth.api.getSession).mockResolvedValue({
  session: { id: 'session-123', userId: 'user-123' },
  user: { id: 'user-123', email: 'user@example.com', role: 'USER', ...otherFields },
});
```

## Client-Side Auth Mocking

### Mock `authClient.signIn/signUp/signOut()`

```typescript
import { vi } from 'vitest';

// Mock the auth client module
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signIn: {
      email: vi.fn(),
    },
    signUp: {
      email: vi.fn(),
    },
    signOut: vi.fn(),
  },
}));

// In tests, import and use
import { authClient } from '@/lib/auth/client';

// Mock successful sign-in
vi.mocked(authClient.signIn.email).mockResolvedValue({
  data: {
    user: { id: '1', email: 'test@example.com' },
    session: { id: 'session-1', token: 'token-123' },
  },
  error: null,
});

// Mock sign-in failure
vi.mocked(authClient.signIn.email).mockResolvedValue({
  data: null,
  error: { message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' },
});

// Mock sign-up success
vi.mocked(authClient.signUp.email).mockResolvedValue({
  data: {
    user: { id: '2', email: 'newuser@example.com' },
    session: { id: 'session-2', token: 'token-456' },
  },
  error: null,
});

// Mock sign-out
vi.mocked(authClient.signOut).mockResolvedValue({ success: true });
```

## Test Utilities with Mock Sessions

### Create Mock Session Helper

```typescript
// lib/test-utils/factories.ts
import type { User } from '@prisma/client';

export function createMockSession(user: User | null = null) {
  const mockUser = user || {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
    role: 'USER' as const,
    emailVerified: new Date(),
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return {
    session: {
      id: 'test-session-id',
      userId: mockUser.id,
      token: 'test-session-token',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
    user: mockUser,
  };
}
```

### Usage in Tests

```typescript
import { createMockSession } from '@/lib/test-utils/factories';
import { auth } from '@/lib/auth/config';

it('should require admin role', async () => {
  // Mock admin session
  const adminSession = createMockSession({
    ...defaultUser,
    role: 'ADMIN',
  });

  vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);

  // Test code that requires admin
  const result = await requireRole('ADMIN');
  expect(result).toEqual(adminSession);
});
```

## Common Test Scenarios

### Test: Authenticated User

```typescript
it('should return user data for authenticated request', async () => {
  const mockSession = createMockSession();
  vi.mocked(auth.api.getSession).mockResolvedValue(mockSession);

  const result = await getServerUser();

  expect(result).toEqual(mockSession.user);
});
```

### Test: Unauthenticated User

```typescript
it('should return null for unauthenticated request', async () => {
  vi.mocked(auth.api.getSession).mockResolvedValue(null);

  const result = await getServerUser();

  expect(result).toBeNull();
});
```

### Test: Role-Based Access

```typescript
describe('hasRole', () => {
  it('should return true when user has required role', async () => {
    const adminSession = createMockSession({
      ...defaultUser,
      role: 'ADMIN',
    });

    vi.mocked(auth.api.getSession).mockResolvedValue(adminSession);

    const result = await hasRole('ADMIN');

    expect(result).toBe(true);
  });

  it('should return false when user has different role', async () => {
    const userSession = createMockSession({
      ...defaultUser,
      role: 'USER',
    });

    vi.mocked(auth.api.getSession).mockResolvedValue(userSession);

    const result = await hasRole('ADMIN');

    expect(result).toBe(false);
  });
});
```

### Test: Component Sign-In Flow

```typescript
it('should call signIn with form data', async () => {
  const user = userEvent.setup();
  const mockSignIn = vi.fn().mockResolvedValue({
    data: { user: { id: '1' } },
    error: null,
  });

  vi.mocked(authClient.signIn.email).mockImplementation(mockSignIn);

  render(<LoginForm />);

  await user.type(screen.getByLabelText(/email/i), 'test@example.com');
  await user.type(screen.getByLabelText(/password/i), 'Password123!');
  await user.click(screen.getByRole('button', { name: /sign in/i }));

  expect(mockSignIn).toHaveBeenCalledWith({
    email: 'test@example.com',
    password: 'Password123!',
  });
});
```

## Tips

1. **Mock at module level**: Place `vi.mock()` at the top of the test file
2. **Use factories**: Create reusable session factories with defaults
3. **Clear mocks**: Use `beforeEach(() => vi.clearAllMocks())`
4. **Test all roles**: Test USER, ADMIN, MODERATOR, unauthenticated
5. **Mock minimally**: Only mock better-auth, not your auth utilities
6. **Verify calls**: Use `expect(mock).toHaveBeenCalledWith(...)` to verify

## Related Files

- **Source**: `lib/auth/utils.ts`, `lib/auth/client.ts`, `lib/auth/config.ts`
- **Test utilities**: `lib/test-utils/factories.ts`
- **Templates**: See `../templates/medium.md` for auth utility tests
