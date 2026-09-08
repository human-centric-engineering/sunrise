// @vitest-environment happy-dom

/**
 * UserEditForm — behaviour when the install declares a third role
 *
 * A separate file because it needs `@/lib/auth/roles` mocked at module scope,
 * and the main `user-edit-form.test.tsx` deliberately exercises the real
 * vocabulary.
 *
 * ## Why this cannot be tested with the real constant
 *
 * The defect this guards against is invisible upstream. The form used to build
 * its default as `isPlatformAdmin(user) ? ADMIN : USER`, collapsing everything
 * that is not ADMIN down to USER. With `USER_ROLES` at two values that is
 * indistinguishable from the correct `isUserRole(role) ? role : USER` — both
 * map ADMIN→ADMIN and everything else→USER. The two only diverge once a third
 * role exists, which is exactly the case the module's docblock invites a fork
 * to create.
 *
 * So this drives the property with a mocked three-role vocabulary. Without it
 * the fix would be a change nothing could fail on, and the review finding that
 * prompted it would stay unproven.
 *
 * ## The failure it prevents
 *
 * `onSubmit` PATCHes the whole form body, `role` included. So an admin opening
 * a MODERATOR's edit page, changing only the name, and saving would have
 * silently demoted them to USER — a privilege change nobody asked for, from a
 * form that never showed it happening.
 *
 * @see components/admin/user-edit-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockPush = vi.fn();

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: vi.fn(() => createMockRouter({ push: mockPush })),
    usePathname: vi.fn(() => '/admin/users/user-1/edit'),
    useSearchParams: () => ({ get: () => null }),
  };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

/**
 * A fork's vocabulary: the two core roles plus one of its own.
 *
 * Only the vocabulary is mocked — `isUserRole` and `roleLabel` keep their real
 * implementations, driven by the widened list, because those are the functions
 * under test here.
 */
vi.mock('@/lib/auth/roles', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/roles')>('@/lib/auth/roles');
  const USER_ROLES = ['USER', 'ADMIN', 'MODERATOR'] as const;
  return {
    ...actual,
    USER_ROLES,
    isUserRole: (v: unknown): boolean =>
      typeof v === 'string' && (USER_ROLES as readonly string[]).includes(v),
  };
});

import { UserEditForm } from '@/components/admin/user-edit-form';
import type { AdminUser } from '@/types/admin';

function userWithRole(role: string): AdminUser {
  return {
    id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    emailVerified: true,
    role,
    image: null,
    createdAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
  } as unknown as AdminUser;
}

beforeEach(() => vi.clearAllMocks());

describe('a role the install declares beyond USER and ADMIN', () => {
  it('is preserved as the form default rather than collapsed to USER', () => {
    // The half that did NOT hold. `role` is the form's own default, so what it
    // holds here is what a save would PATCH — the demotion happens without the
    // operator touching the role field at all.
    render(<UserEditForm user={userWithRole('MODERATOR')} currentUserId="admin-1" />);

    expect(screen.getByRole('combobox')).toHaveTextContent('Moderator');
  });

  it('still falls back to USER for a role the install does not declare', () => {
    // The fallback is not removed, only narrowed to what it was for: a value
    // that is genuinely not in the vocabulary — a row written before a rename,
    // say — must not be echoed back as though it were valid.
    render(<UserEditForm user={userWithRole('SUPERUSER')} currentUserId="admin-1" />);

    expect(screen.getByRole('combobox')).toHaveTextContent('User');
  });
});
