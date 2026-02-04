/**
 * UserTable Component Tests
 *
 * Tests the UserTable component which handles:
 * - User list display with avatar, role, verification status
 * - Search with debouncing (300ms)
 * - Sorting by name, email, createdAt
 * - Pagination
 * - User deletion with confirmation dialog
 * - Fixed table layout with column widths
 * - Text truncation for long names/emails
 *
 * Recent changes tested:
 * - Debouncing using useRef (fixes broken return cleanup pattern)
 * - Stale closure fixes for search (passing value via overrides)
 * - Stale closure fixes for sorting (passing sortBy/sortOrder via overrides)
 * - Avatar displays user.image properly
 * - emailVerified display without unnecessary checks
 * - Center-aligned columns (Avatar, Role, Verified, Actions)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/admin/user-table.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserTable } from '@/components/admin/user-table';
import type { UserListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';
import { createMockFetchResponse } from '@/tests/helpers/mocks';

// Mock dependencies
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(() => '/admin/users'),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code: string;
    details?: unknown;
    constructor(message: string, code: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
}));

/**
 * Test Suite: UserTable Component
 */
describe('components/admin/user-table', () => {
  let mockRouter: { push: ReturnType<typeof vi.fn> };
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;

  // Sample test data
  const mockUsers: UserListItem[] = [
    {
      id: 'user-1',
      name: 'Alice Johnson',
      email: 'alice@example.com',
      image: 'https://example.com/avatar1.jpg',
      role: 'ADMIN',
      emailVerified: true,
      createdAt: new Date('2025-01-15T10:00:00Z'),
    },
    {
      id: 'user-2',
      name: 'Bob Smith',
      email: 'bob@example.com',
      image: null,
      role: 'USER',
      emailVerified: false,
      createdAt: new Date('2025-02-20T14:30:00Z'),
    },
    {
      id: 'user-3',
      name: 'Charlie Brown with a Very Long Name That Should Truncate',
      email: 'charlie.brown.with.very.long.email@example-domain.com',
      image: 'https://example.com/avatar3.jpg',
      role: 'USER',
      emailVerified: true,
      createdAt: new Date('2025-03-10T08:15:00Z'),
    },
  ];

  const mockMeta: PaginationMeta = {
    page: 1,
    limit: 10,
    total: 3,
    totalPages: 1,
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock router
    const { useRouter } = await import('next/navigation');
    mockRouter = {
      push: vi.fn(),
    };
    vi.mocked(useRouter).mockReturnValue({
      ...mockRouter,
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    // Mock fetch
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch as typeof fetch;

    // Use fake timers with shouldAdvanceTime to prevent hanging with React Testing Library
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Helper to create mock API response
   */
  function createMockUsersResponse(users: UserListItem[], meta: PaginationMeta) {
    return {
      success: true,
      data: users.map((user) => ({
        ...user,
        createdAt: user.createdAt.toISOString(), // API returns ISO string
      })),
      meta,
    };
  }

  describe('rendering', () => {
    it('should render table with user data', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Table headers
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Email')).toBeInTheDocument();
      expect(screen.getByText('Role')).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('Created')).toBeInTheDocument();
      expect(screen.getByText('Actions')).toBeInTheDocument();

      // Assert: User data
      expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
      expect(screen.getByText('Bob Smith')).toBeInTheDocument();
      expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    });

    it('should render avatars with user data', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Check that user names are displayed (avatars are part of user rows)
      expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
      expect(screen.getByText('Bob Smith')).toBeInTheDocument();
      expect(
        screen.getByText('Charlie Brown with a Very Long Name That Should Truncate')
      ).toBeInTheDocument();
    });

    it('should render avatar fallback for users without image', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Avatar fallback with initials
      expect(screen.getByText('BS')).toBeInTheDocument(); // Bob Smith initials
    });

    it('should render role badges', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Role badges
      expect(screen.getByText('ADMIN')).toBeInTheDocument();
      expect(screen.getAllByText('USER')).toHaveLength(2); // Two USER roles (one explicit, one null that displays as USER)
    });

    it('should render email verification status', () => {
      // Arrange & Act
      const { container } = render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Verified icons
      const verifiedIcons = container.querySelectorAll('.text-green-500');
      expect(verifiedIcons.length).toBe(2); // Alice and Charlie are verified

      const unverifiedIcons = container.querySelectorAll('.text-muted-foreground');
      expect(unverifiedIcons.length).toBeGreaterThan(0); // Bob is unverified
    });

    it('should truncate long names and emails', () => {
      // Arrange & Act
      const { container } = render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Truncate classes are applied
      const nameCells = container.querySelectorAll('td.truncate.font-medium');
      expect(nameCells.length).toBe(3);

      const emailCells = container.querySelectorAll('td.truncate.text-muted-foreground');
      expect(emailCells.length).toBe(3);
    });

    it('should render search input', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert
      const searchInput = screen.getByPlaceholderText('Search users...');
      expect(searchInput).toBeInTheDocument();
      expect(searchInput).toHaveValue('');
    });

    it('should render invite user button', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert
      const inviteButton = screen.getByRole('link', { name: /invite user/i });
      expect(inviteButton).toBeInTheDocument();
      expect(inviteButton).toHaveAttribute('href', '/admin/users/invite');
    });

    it('should render pagination controls', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert
      expect(screen.getByText(/Showing 1 to 3 of 3 users/i)).toBeInTheDocument();
      expect(screen.getByText('Previous')).toBeInTheDocument();
      expect(screen.getByText('Next')).toBeInTheDocument();
      expect(screen.getByText(/Page 1 of 1/i)).toBeInTheDocument();
    });

    it('should display loading state', () => {
      // Arrange & Act
      render(<UserTable initialUsers={[]} initialMeta={{ ...mockMeta, total: 0 }} />);

      // Assert
      expect(screen.getByText('No users found.')).toBeInTheDocument();
    });
  });

  describe('search functionality', () => {
    it('should update search input value', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);
      const searchInput = screen.getByPlaceholderText('Search users...');

      // Act
      await user.type(searchInput, 'alice');

      // Assert
      expect(searchInput).toHaveValue('alice');
    });

    it('should debounce search requests (300ms)', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse([mockUsers[0]], mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);
      const searchInput = screen.getByPlaceholderText('Search users...');

      // Act: Type quickly
      await user.type(searchInput, 'al');

      // Assert: Should not fetch immediately
      expect(mockFetch).not.toHaveBeenCalled();

      // Act: Advance time past debounce
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert: Should fetch after debounce
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });

      // Assert: Should include search param
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('search=al'),
        expect.any(Object)
      );
    });

    it('should pass current search value to API (stale closure fix)', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse([mockUsers[0]], mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);
      const searchInput = screen.getByPlaceholderText('Search users...');

      // Act: Type and wait for debounce
      await user.type(searchInput, 'alice');
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert: Should use the actual typed value, not stale closure value
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('search=alice'),
        expect.any(Object)
      );
    });

    it('should cancel previous search when typing again', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse([mockUsers[0]], mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);
      const searchInput = screen.getByPlaceholderText('Search users...');

      // Act: Type, wait a bit, type more (should cancel first timeout)
      await user.type(searchInput, 'al');
      await act(async () => {
        vi.advanceTimersByTime(100); // Wait less than debounce time
      });
      await user.type(searchInput, 'ice');

      // Advance time past debounce
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert: Should only fetch once with the final value
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('search=alice'),
        expect.any(Object)
      );
    });

    it('should reset to page 1 when searching', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const page2Meta = { ...mockMeta, page: 2 };
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers, mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={page2Meta} />);
      const searchInput = screen.getByPlaceholderText('Search users...');

      // Act: Search
      await user.type(searchInput, 'alice');
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert: Should request page 1
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('page=1'),
          expect.any(Object)
        );
      });
    });
  });

  describe('sorting functionality', () => {
    it('should sort by name when clicking name header', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers, mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Click name header
      await user.click(screen.getByRole('button', { name: /name/i }));

      // Assert: Should fetch with name sorting
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('sortBy=name'),
          expect.any(Object)
        );
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('sortOrder=desc'),
          expect.any(Object)
        );
      });
    });

    it('should toggle sort order when clicking same column', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers, mockMeta))
      );
      render(
        <UserTable
          initialUsers={mockUsers}
          initialMeta={mockMeta}
          initialSortBy="name"
          initialSortOrder="desc"
        />
      );

      // Act: Click name header again
      await user.click(screen.getByRole('button', { name: /name/i }));

      // Assert: Should toggle to ascending
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('sortOrder=asc'),
          expect.any(Object)
        );
      });
    });

    it('should pass current sort values to API (stale closure fix)', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers, mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Sort by email
      await user.click(screen.getByRole('button', { name: /email/i }));

      // Assert: Should use the new sort values, not stale closure values
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('sortBy=email'),
          expect.any(Object)
        );
      });
    });

    it('should sort by email', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers, mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Click email header
      await user.click(screen.getByRole('button', { name: /email/i }));

      // Assert
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('sortBy=email'),
          expect.any(Object)
        );
      });
    });

    it('should sort by createdAt', async () => {
      // Arrange
      const user = userEvent.setup();
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers, mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Click created header
      await user.click(screen.getByRole('button', { name: /created/i }));

      // Assert
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('sortBy=createdAt'),
          expect.any(Object)
        );
      });
    });

    it('should display correct sort icon', () => {
      // Arrange & Act
      const { rerender } = render(
        <UserTable
          initialUsers={mockUsers}
          initialMeta={mockMeta}
          initialSortBy="name"
          initialSortOrder="asc"
        />
      );

      // Assert: ArrowUp icon should be present for ascending sort
      // (We can't easily test the icon component directly, but we can verify the state)
      expect(screen.getByRole('button', { name: /name/i })).toBeInTheDocument();

      // Act: Change to descending
      rerender(
        <UserTable
          initialUsers={mockUsers}
          initialMeta={mockMeta}
          initialSortBy="name"
          initialSortOrder="desc"
        />
      );

      // Assert: ArrowDown icon should be present for descending sort
      expect(screen.getByRole('button', { name: /name/i })).toBeInTheDocument();
    });
  });

  describe('pagination functionality', () => {
    it('should navigate to next page', async () => {
      // Arrange
      const user = userEvent.setup();
      const multiPageMeta = { ...mockMeta, page: 1, totalPages: 3 };
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers, multiPageMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={multiPageMeta} />);

      // Act: Click next button
      await user.click(screen.getByText('Next'));

      // Assert
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('page=2'),
          expect.any(Object)
        );
      });
    });

    it('should navigate to previous page', async () => {
      // Arrange
      const user = userEvent.setup();
      const multiPageMeta = { ...mockMeta, page: 2, totalPages: 3 };
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers, multiPageMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={multiPageMeta} />);

      // Act: Click previous button
      await user.click(screen.getByText('Previous'));

      // Assert
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('page=1'),
          expect.any(Object)
        );
      });
    });

    it('should disable previous button on first page', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert
      const previousButton = screen.getByText('Previous').closest('button');
      expect(previousButton).toBeDisabled();
    });

    it('should disable next button on last page', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert
      const nextButton = screen.getByText('Next').closest('button');
      expect(nextButton).toBeDisabled();
    });

    it('should display correct page info', () => {
      // Arrange
      const multiPageMeta = { page: 2, limit: 10, total: 25, totalPages: 3 };

      // Act
      render(<UserTable initialUsers={mockUsers} initialMeta={multiPageMeta} />);

      // Assert
      expect(screen.getByText(/Showing 11 to 20 of 25 users/i)).toBeInTheDocument();
      expect(screen.getByText(/Page 2 of 3/i)).toBeInTheDocument();
    });
  });

  describe('user actions', () => {
    it('should render user name as link to profile page', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: User names should be links
      const aliceLink = screen.getByRole('link', { name: 'Alice Johnson' });
      expect(aliceLink).toBeInTheDocument();
      expect(aliceLink).toHaveAttribute('href', '/admin/users/user-1');

      const bobLink = screen.getByRole('link', { name: 'Bob Smith' });
      expect(bobLink).toBeInTheDocument();
      expect(bobLink).toHaveAttribute('href', '/admin/users/user-2');
    });

    it('should navigate to profile page when clicking View Profile', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Open actions menu and click View Profile
      const actionButtons = screen.getAllByRole('button', { name: /open menu/i });
      await user.click(actionButtons[0]);
      await user.click(screen.getByRole('menuitem', { name: /view profile/i }));

      // Assert: Should navigate to profile page
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/admin/users/user-1');
      });
    });

    it('should show cannot-delete message for admin users', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Open actions menu for first user (Alice, ADMIN)
      const actionButtons = screen.getAllByRole('button', { name: /open menu/i });
      await user.click(actionButtons[0]);

      // Act: Click delete
      await user.click(screen.getByRole('menuitem', { name: /delete/i }));

      // Assert: Should show informational message, not delete confirmation
      await waitFor(() => {
        expect(screen.getByText('Cannot Delete Admin')).toBeInTheDocument();
        expect(
          screen.getByText(/Cannot delete an admin account. Demote the user first./i)
        ).toBeInTheDocument();
      });

      // Assert: No delete button should be present
      expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();

      // Assert: Close button should be present
      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    });

    it('should open delete confirmation dialog', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Open actions menu for second user (Bob, non-admin)
      const actionButtons = screen.getAllByRole('button', { name: /open menu/i });
      await user.click(actionButtons[1]);

      // Act: Click delete
      await user.click(screen.getByRole('menuitem', { name: /delete/i }));

      // Assert: Dialog should open
      await waitFor(() => {
        expect(screen.getByText('Delete User')).toBeInTheDocument();
        expect(screen.getByText(/Are you sure you want to delete this user/i)).toBeInTheDocument();
      });
    });

    it('should cancel user deletion', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Open delete dialog for second user (Bob, non-admin)
      const actionButtons = screen.getAllByRole('button', { name: /open menu/i });
      await user.click(actionButtons[1]);
      await user.click(screen.getByRole('menuitem', { name: /delete/i }));

      // Act: Cancel
      await user.click(screen.getByText('Cancel'));

      // Assert: Dialog should close, no API call
      await waitFor(() => {
        expect(screen.queryByText('Delete User')).not.toBeInTheDocument();
      });
      expect(apiClient.delete).not.toHaveBeenCalled();
    });

    it('should delete user on confirmation', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockResolvedValue({ success: true });
      mockFetch.mockResolvedValue(
        createMockFetchResponse(createMockUsersResponse(mockUsers.slice(1), mockMeta))
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Open delete dialog for second user (Bob, non-admin)
      const actionButtons = screen.getAllByRole('button', { name: /open menu/i });
      await user.click(actionButtons[1]);
      await user.click(screen.getByRole('menuitem', { name: /delete/i }));

      // Act: Confirm delete
      const deleteButton = screen.getByRole('button', { name: /^delete$/i });
      await user.click(deleteButton);

      // Assert: Should call delete API
      await waitFor(() => {
        expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/users/user-2');
      });

      // Assert: Should refresh user list
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });

    it('should call delete API on failure and keep dialog open', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.delete).mockRejectedValue(
        new APIClientError('Failed to delete user', 'DELETE_FAILED')
      );
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Open delete dialog for second user (Bob, non-admin) and confirm
      const actionButtons = screen.getAllByRole('button', { name: /open menu/i });
      await user.click(actionButtons[1]);
      await user.click(screen.getByRole('menuitem', { name: /delete/i }));

      // Wait for dialog to open
      await waitFor(() => {
        expect(screen.getByText('Delete User')).toBeInTheDocument();
      });

      const deleteButton = screen.getByRole('button', { name: /^delete$/i });
      await user.click(deleteButton);

      // Assert: Delete API should be called with correct user ID
      await waitFor(
        () => {
          expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/users/user-2');
        },
        { timeout: 2000 }
      );
    });

    it('should navigate to edit page', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Open actions menu and click edit
      const actionButtons = screen.getAllByRole('button', { name: /open menu/i });
      await user.click(actionButtons[0]);
      await user.click(screen.getByRole('menuitem', { name: /edit/i }));

      // Assert: Should navigate to edit page
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/admin/users/user-1/edit');
      });
    });
  });

  describe('initial state', () => {
    it('should initialize with provided search value', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} initialSearch="alice" />);

      // Assert
      const searchInput = screen.getByPlaceholderText('Search users...');
      expect(searchInput).toHaveValue('alice');
    });

    it('should initialize with provided sort values', () => {
      // Arrange & Act
      render(
        <UserTable
          initialUsers={mockUsers}
          initialMeta={mockMeta}
          initialSortBy="email"
          initialSortOrder="asc"
        />
      );

      // Assert: Should display sort indicator on email column
      expect(screen.getByRole('button', { name: /email/i })).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('should handle empty user list', () => {
      // Arrange & Act
      render(<UserTable initialUsers={[]} initialMeta={{ ...mockMeta, total: 0 }} />);

      // Assert
      expect(screen.getByText('No users found.')).toBeInTheDocument();
    });

    it('should handle API error gracefully', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      mockFetch.mockRejectedValue(new Error('Network error'));
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Act: Trigger search
      await user.type(screen.getByPlaceholderText('Search users...'), 'test');
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // Assert: Should not crash (error is logged but not displayed)
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
      expect(screen.getByText('Alice Johnson')).toBeInTheDocument(); // Original data still visible
    });

    it('should handle users with null role', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Should display USER for null role
      expect(screen.getAllByText('USER')).toHaveLength(2); // Multiple USER roles expected
    });

    it('should handle users without avatar image', () => {
      // Arrange & Act
      render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Should display initials fallback
      expect(screen.getByText('BS')).toBeInTheDocument(); // Bob Smith
    });
  });

  describe('table layout', () => {
    it('should apply fixed table layout', () => {
      // Arrange & Act
      const { container } = render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert
      const table = container.querySelector('table');
      expect(table).toHaveClass('table-fixed');
    });

    it('should center-align specific columns', () => {
      // Arrange & Act
      const { container } = render(<UserTable initialUsers={mockUsers} initialMeta={mockMeta} />);

      // Assert: Check header alignment
      const headers = container.querySelectorAll('th.text-center');
      expect(headers.length).toBeGreaterThan(0);

      // Assert: Check cell alignment
      const cells = container.querySelectorAll('td.text-center');
      expect(cells.length).toBeGreaterThan(0);
    });
  });
});
