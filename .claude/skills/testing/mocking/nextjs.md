# Mocking Next.js

**When to use**: Unit tests and component tests using Next.js APIs

**What to mock**: `headers()`, `redirect()`, `useRouter()`, `useSearchParams()`, `usePathname()`

## Server Component Mocking

### Mock `headers()`

```typescript
import { vi } from 'vitest';

// Mock Next.js headers
vi.mock('next/headers', () => ({
  headers: vi.fn(
    () =>
      new Headers({
        'content-type': 'application/json',
        'user-agent': 'test-agent',
      })
  ),
  cookies: vi.fn(() => ({
    get: vi.fn((name: string) => ({ name, value: 'test-value' })),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

// In tests
import { headers } from 'next/headers';

it('should read headers', () => {
  const headersList = headers();
  expect(headersList.get('content-type')).toBe('application/json');
});
```

### Mock `redirect()`

**Important**: Next.js `redirect()` throws a special error to trigger redirects. Mock it correctly:

```typescript
import { vi } from 'vitest';

// Mock Next.js redirect (throws error)
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  }),
}));

// In tests
import { redirect } from 'next/navigation';

it('should redirect to dashboard', () => {
  expect(() => redirect('/dashboard')).toThrow('NEXT_REDIRECT: /dashboard');
  expect(redirect).toHaveBeenCalledWith('/dashboard');
});
```

## Client Component Mocking

### Mock `useRouter()`

```typescript
import { vi } from 'vitest';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockRefresh = vi.fn();
const mockBack = vi.fn();
const mockForward = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    refresh: mockRefresh,
    back: mockBack,
    forward: mockForward,
    prefetch: vi.fn(),
  }),
  usePathname: () => '/current-path',
  useSearchParams: () => new URLSearchParams('?page=1&limit=10'),
}));

// In tests
import { useRouter } from 'next/navigation';

it('should navigate to dashboard on success', async () => {
  // Component code calls router.push('/dashboard')
  render(<MyComponent />);

  await userEvent.click(screen.getByRole('button', { name: /submit/i }));

  expect(mockPush).toHaveBeenCalledWith('/dashboard');
});
```

### Mock `useSearchParams()`

```typescript
import { vi } from 'vitest';

// Mock with specific params
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({
    page: '2',
    limit: '20',
    search: 'test query',
    sortBy: 'createdAt',
    sortOrder: 'desc',
  }),
  useRouter: () => ({ push: vi.fn() }),
}));

// In tests
it('should read search params', () => {
  render(<MyComponent />);

  // Component reads searchParams.get('page')
  expect(screen.getByText('Page: 2')).toBeInTheDocument();
});
```

### Mock `usePathname()`

```typescript
import { vi } from 'vitest';

// Mock current pathname
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/settings',
  useRouter: () => ({ push: vi.fn() }),
}));

// In tests
it('should highlight active nav item', () => {
  render(<Navigation />);

  const settingsLink = screen.getByRole('link', { name: /settings/i });
  expect(settingsLink).toHaveClass('active');
});
```

## Server Actions Mocking

### Mock Server Actions

```typescript
import { vi } from 'vitest';

// Mock server action
vi.mock('@/app/actions', () => ({
  submitForm: vi.fn(),
}));

// In tests
import { submitForm } from '@/app/actions';

it('should call server action with form data', async () => {
  vi.mocked(submitForm).mockResolvedValue({ success: true });

  render(<MyForm />);

  await userEvent.click(screen.getByRole('button', { name: /submit/i }));

  expect(submitForm).toHaveBeenCalledWith({
    name: 'John',
    email: 'john@example.com',
  });
});
```

## Next.js Image Mocking

```typescript
import { vi } from 'vitest';

// Mock Next.js Image component
vi.mock('next/image', () => ({
  default: (props: any) => {
    // eslint-disable-next-line jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

// In tests - Image renders as regular img
it('should render image', () => {
  render(<Avatar src="/avatar.png" alt="User avatar" />);

  const img = screen.getByAltText('User avatar');
  expect(img).toHaveAttribute('src', '/avatar.png');
});
```

## Next.js Link Mocking

**Usually not needed** - `next/link` works in tests without mocking. If needed:

```typescript
import { vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: any) => {
    return <a href={href}>{children}</a>;
  },
}));
```

## Test Examples

### Testing Navigation

```typescript
import { vi, describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardNav } from '@/components/dashboard-nav';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/dashboard',
}));

describe('DashboardNav', () => {
  it('should navigate to settings', async () => {
    const user = userEvent.setup();
    render(<DashboardNav />);

    await user.click(screen.getByRole('link', { name: /settings/i }));

    expect(mockPush).toHaveBeenCalledWith('/dashboard/settings');
  });
});
```

### Testing Search Params

```typescript
import { vi, describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserList } from '@/components/user-list';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ page: '2', search: 'john' }),
}));

describe('UserList', () => {
  it('should display current page', () => {
    render(<UserList />);

    expect(screen.getByText('Page: 2')).toBeInTheDocument();
  });

  it('should filter by search param', () => {
    render(<UserList />);

    // Component filters users based on 'search' param
    expect(screen.getByText(/filtering by: john/i)).toBeInTheDocument();
  });
});
```

### Testing Redirects

```typescript
import { vi, describe, it, expect } from 'vitest';
import { clearInvalidSession } from '@/lib/auth/clear-session';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  }),
}));

describe('clearInvalidSession', () => {
  it('should redirect to login with return URL', () => {
    expect(() => clearInvalidSession('/dashboard')).toThrow(
      'NEXT_REDIRECT: /auth/clear-session?returnUrl=%2Fdashboard'
    );
  });

  it('should use default return URL', () => {
    expect(() => clearInvalidSession()).toThrow('NEXT_REDIRECT: /auth/clear-session?returnUrl=%2F');
  });
});
```

## Tips

1. **Mock at top level**: Place `vi.mock()` calls outside `describe` blocks
2. **Create mock variables**: Extract mock functions (`mockPush`) for verification
3. **Mock all navigation hooks together**: `useRouter`, `usePathname`, `useSearchParams`
4. **Redirect throws**: Next.js `redirect()` throws - use `expect(() => ...).toThrow()`
5. **Clear mocks**: Use `beforeEach(() => vi.clearAllMocks())`
6. **Real objects preferred**: Use real `Headers`, `URLSearchParams` objects

## Common Pitfalls

❌ **Don't do this**:

```typescript
// Mocking too much
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
}));

// Then in test:
useRouter.mockReturnValue({ push: vi.fn() }); // Won't work!
```

✅ **Do this instead**:

```typescript
// Return the object directly
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Then verify:
expect(mockPush).toHaveBeenCalled();
```

## Related Files

- **Source**: `lib/auth/clear-session.ts`, `components/*/navigation.tsx`
- **Templates**: See `../templates/component.md` for component tests
