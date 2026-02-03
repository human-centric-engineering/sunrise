'use client';

/**
 * User Table Component (Phase 4.4)
 *
 * Data table for managing users with search, sorting, pagination, and actions.
 */

import { useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Search,
  MoreHorizontal,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  User,
  Edit,
  Trash2,
  UserPlus,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import type { UserListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';
import { apiClient, APIClientError } from '@/lib/api/client';
import { ClientDate } from '@/components/ui/client-date';

interface UserTableProps {
  initialUsers: UserListItem[];
  initialMeta: PaginationMeta;
  initialSearch?: string;
  initialSortBy?: string;
  initialSortOrder?: 'asc' | 'desc';
  /** Hide the invite button (when shown in tabs with shared header) */
  hideInviteButton?: boolean;
}

/**
 * Get initials from a name
 */
function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Role badge variant
 */
function getRoleBadgeVariant(role: string | null): 'default' | 'secondary' | 'outline' {
  switch (role) {
    case 'ADMIN':
      return 'default';
    default:
      return 'outline';
  }
}

export function UserTable({
  initialUsers,
  initialMeta,
  initialSearch = '',
  initialSortBy = 'createdAt',
  initialSortOrder = 'desc',
  hideInviteButton = false,
}: UserTableProps) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState(initialSearch);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(initialSortOrder);
  const [isLoading, setIsLoading] = useState(false);
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Fetch users with current filters
   */
  const fetchUsers = useCallback(
    async (
      page = 1,
      overrides?: { search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc' }
    ) => {
      setIsLoading(true);
      try {
        interface UserListResponse {
          id: string;
          name: string;
          email: string;
          image: string | null;
          role: string | null;
          emailVerified: boolean;
          createdAt: string;
        }

        interface ApiResponse {
          success: boolean;
          data: UserListResponse[];
          meta?: PaginationMeta;
        }

        // Build URL with params
        // Use overrides if provided (to avoid stale closure issues), otherwise use state
        const searchValue = overrides?.search !== undefined ? overrides.search : search;
        const sortByValue = overrides?.sortBy !== undefined ? overrides.sortBy : sortBy;
        const sortOrderValue = overrides?.sortOrder !== undefined ? overrides.sortOrder : sortOrder;
        const params = new URLSearchParams({
          page: String(page),
          limit: String(meta.limit),
          sortBy: sortByValue,
          sortOrder: sortOrderValue,
        });
        if (searchValue) params.set('search', searchValue);

        const res = await fetch(`/api/v1/users?${params.toString()}`, {
          credentials: 'same-origin',
        });

        if (!res.ok) {
          throw new Error('Failed to fetch users');
        }

        const response = (await res.json()) as ApiResponse;

        if (!response.success) {
          throw new Error('Failed to fetch users');
        }

        // Convert string dates to Date objects for UserListItem
        const usersWithDates: UserListItem[] = response.data.map((user) => ({
          ...user,
          createdAt: new Date(user.createdAt),
        }));

        setUsers(usersWithDates);
        if (response.meta) {
          setMeta(response.meta);
        }
      } catch (error) {
        if (error instanceof APIClientError) {
          // eslint-disable-next-line no-console -- client component, no structured logger available
          console.error('Failed to fetch users:', error.message);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [meta.limit, search, sortBy, sortOrder]
  );

  /**
   * Handle search input with debouncing
   */
  const handleSearch = useCallback(
    (value: string) => {
      setSearch(value);

      // Clear previous timeout to debounce
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      // Set new timeout - 300ms balances responsiveness with server load
      // Pass value directly to avoid stale closure issue
      searchTimeoutRef.current = setTimeout(() => {
        void fetchUsers(1, { search: value });
      }, 300);
    },
    [fetchUsers]
  );

  /**
   * Handle sorting
   */
  const handleSort = useCallback(
    (column: string) => {
      // Calculate new sort values
      const newSortBy = column;
      const newSortOrder = sortBy === column ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'desc';

      // Update state for UI
      setSortBy(newSortBy);
      setSortOrder(newSortOrder);

      // Pass values directly to avoid stale closure issue
      void fetchUsers(1, { sortBy: newSortBy, sortOrder: newSortOrder });
    },
    [sortBy, sortOrder, fetchUsers]
  );

  /**
   * Handle pagination
   */
  const handlePageChange = useCallback(
    (page: number) => {
      void fetchUsers(page);
    },
    [fetchUsers]
  );

  /**
   * Handle user deletion
   */
  const handleDelete = useCallback(async () => {
    if (!deleteUserId) return;

    setIsLoading(true);
    setDeleteError(null);
    try {
      await apiClient.delete(`/api/v1/users/${deleteUserId}`);
      setDeleteUserId(null);
      void fetchUsers(meta.page);
    } catch (error) {
      if (error instanceof APIClientError) {
        setDeleteError(error.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, [deleteUserId, fetchUsers, meta.page]);

  /**
   * Render sort icon
   */
  const renderSortIcon = (column: string) => {
    if (sortBy !== column) {
      return <ArrowUpDown className="ml-2 h-4 w-4" />;
    }
    return sortOrder === 'asc' ? (
      <ArrowUp className="ml-2 h-4 w-4" />
    ) : (
      <ArrowDown className="ml-2 h-4 w-4" />
    );
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative max-w-sm flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder="Search users..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {!hideInviteButton && (
          <Button asChild>
            <Link href="/admin/users/invite">
              <UserPlus className="mr-2 h-4 w-4" />
              Invite User
            </Link>
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-14 text-center">Avatar</TableHead>
              <TableHead className="w-[20%]">
                <Button
                  variant="ghost"
                  className="data-[state=open]:bg-accent -ml-4 h-8"
                  onClick={() => handleSort('name')}
                >
                  Name
                  {renderSortIcon('name')}
                </Button>
              </TableHead>
              <TableHead className="w-[30%]">
                <Button
                  variant="ghost"
                  className="data-[state=open]:bg-accent -ml-4 h-8"
                  onClick={() => handleSort('email')}
                >
                  Email
                  {renderSortIcon('email')}
                </Button>
              </TableHead>
              <TableHead className="w-24 text-center">Role</TableHead>
              <TableHead className="w-20 text-center">Verified</TableHead>
              <TableHead className="w-28">
                <Button
                  variant="ghost"
                  className="data-[state=open]:bg-accent -ml-4 h-8"
                  onClick={() => handleSort('createdAt')}
                >
                  Created
                  {renderSortIcon('createdAt')}
                </Button>
              </TableHead>
              <TableHead className="w-12 text-center">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : users.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  No users found.
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="text-center">
                    <Avatar className="mx-auto h-8 w-8">
                      <AvatarImage src={user.image || undefined} alt={user.name} />
                      <AvatarFallback className="text-xs">{getInitials(user.name)}</AvatarFallback>
                    </Avatar>
                  </TableCell>
                  <TableCell className="truncate font-medium">
                    <Link href={`/admin/users/${user.id}`} className="hover:underline">
                      {user.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground truncate">{user.email}</TableCell>
                  <TableCell className="text-center">
                    <Badge variant={getRoleBadgeVariant(user.role)}>{user.role || 'USER'}</Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    {user.emailVerified ? (
                      <CheckCircle className="mx-auto h-4 w-4 text-green-500" />
                    ) : (
                      <XCircle className="text-muted-foreground mx-auto h-4 w-4" />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <ClientDate date={user.createdAt} />
                  </TableCell>
                  <TableCell className="text-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                          <span className="sr-only">Open menu</span>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => router.push(`/admin/users/${user.id}`)}>
                          <User className="mr-2 h-4 w-4" />
                          View Profile
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => router.push(`/admin/users/${user.id}/edit`)}
                        >
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => setDeleteUserId(user.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Showing {(meta.page - 1) * meta.limit + 1} to{' '}
          {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} users
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(meta.page - 1)}
            disabled={meta.page <= 1 || isLoading}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <span className="text-sm">
            Page {meta.page} of {meta.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(meta.page + 1)}
            disabled={meta.page >= meta.totalPages || isLoading}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteUserId} onOpenChange={() => setDeleteUserId(null)}>
        <AlertDialogContent>
          {users.find((u) => u.id === deleteUserId)?.role === 'ADMIN' ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Cannot Delete Admin</AlertDialogTitle>
                <AlertDialogDescription>
                  Cannot delete an admin account. Demote the user first.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Close</AlertDialogCancel>
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete User</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete this user? This action cannot be undone. All user
                  data, sessions, and accounts will be permanently deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {deleteError && <p className="text-sm text-red-500">{deleteError}</p>}
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void handleDelete()}
                  className="bg-red-600 hover:bg-red-700"
                  disabled={isLoading}
                >
                  {isLoading ? 'Deleting...' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
