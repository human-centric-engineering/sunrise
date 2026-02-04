'use client';

/**
 * Invitation Table Component
 *
 * Data table for managing pending user invitations with search, sorting,
 * pagination, and actions (resend, delete).
 */

import { useState, useCallback, useRef, useEffect } from 'react';
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
  RefreshCw,
  Trash2,
  Clock,
} from 'lucide-react';
import type { InvitationListItem } from '@/types';
import type { PaginationMeta } from '@/types/api';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { ClientDate } from '@/components/ui/client-date';
import { getRoleBadgeVariant } from '@/lib/utils/initials';

interface InvitationTableProps {
  initialInvitations: InvitationListItem[];
  initialMeta: PaginationMeta;
  initialSearch?: string;
  initialSortBy?: 'name' | 'email' | 'invitedAt' | 'expiresAt';
  initialSortOrder?: 'asc' | 'desc';
}

/**
 * Check if expiration is within 24 hours
 */
function isExpiringSoon(expiresAt: Date): boolean {
  const now = new Date();
  const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return expiresAt <= twentyFourHoursFromNow;
}

export function InvitationTable({
  initialInvitations,
  initialMeta,
  initialSearch = '',
  initialSortBy = 'invitedAt',
  initialSortOrder = 'desc',
}: InvitationTableProps) {
  const [invitations, setInvitations] = useState(initialInvitations);
  const [meta, setMeta] = useState(initialMeta);
  const [search, setSearch] = useState(initialSearch);
  const [sortBy, setSortBy] = useState<'name' | 'email' | 'invitedAt' | 'expiresAt'>(initialSortBy);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(initialSortOrder);
  const [isLoading, setIsLoading] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [resendingEmail, setResendingEmail] = useState<string | null>(null);
  const [resendSuccess, setResendSuccess] = useState<string | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const resendSuccessTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up timeouts on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      if (resendSuccessTimeoutRef.current) clearTimeout(resendSuccessTimeoutRef.current);
    };
  }, []);

  /**
   * Fetch invitations with current filters
   */
  const fetchInvitations = useCallback(
    async (
      page = 1,
      overrides?: {
        search?: string;
        sortBy?: 'name' | 'email' | 'invitedAt' | 'expiresAt';
        sortOrder?: 'asc' | 'desc';
      }
    ) => {
      setIsLoading(true);
      try {
        interface InvitationListResponse {
          email: string;
          name: string;
          role: string;
          invitedBy: string;
          invitedByName: string | null;
          invitedAt: string;
          expiresAt: string;
        }

        interface ApiResponse {
          success: boolean;
          data: InvitationListResponse[];
          meta?: PaginationMeta;
        }

        // Build URL with params
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

        const res = await fetch(`${API.ADMIN.INVITATIONS}?${params.toString()}`, {
          credentials: 'same-origin',
        });

        if (!res.ok) {
          throw new Error('Failed to fetch invitations');
        }

        const response = (await res.json()) as ApiResponse;

        if (!response.success) {
          throw new Error('Failed to fetch invitations');
        }

        // Convert string dates to Date objects
        const invitationsWithDates: InvitationListItem[] = response.data.map((inv) => ({
          ...inv,
          invitedAt: new Date(inv.invitedAt),
          expiresAt: new Date(inv.expiresAt),
        }));

        setInvitations(invitationsWithDates);
        if (response.meta) {
          setMeta(response.meta);
        }
      } catch {
        // Error is silently caught — Batch 6 will add proper error state UI
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

      // Set new timeout
      searchTimeoutRef.current = setTimeout(() => {
        void fetchInvitations(1, { search: value });
      }, 300);
    },
    [fetchInvitations]
  );

  /**
   * Handle sorting
   */
  const handleSort = useCallback(
    (column: 'name' | 'email' | 'invitedAt' | 'expiresAt') => {
      const newSortBy = column;
      const newSortOrder = sortBy === column ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'desc';

      setSortBy(newSortBy);
      setSortOrder(newSortOrder);

      void fetchInvitations(1, { sortBy: newSortBy, sortOrder: newSortOrder });
    },
    [sortBy, sortOrder, fetchInvitations]
  );

  /**
   * Handle pagination
   */
  const handlePageChange = useCallback(
    (page: number) => {
      void fetchInvitations(page);
    },
    [fetchInvitations]
  );

  /**
   * Handle invitation deletion
   */
  const handleDelete = useCallback(async () => {
    if (!deleteEmail) return;

    setIsLoading(true);
    setDeleteError(null);
    try {
      await apiClient.delete(API.ADMIN.invitationByEmail(deleteEmail));
      setDeleteEmail(null);
      void fetchInvitations(meta.page);
    } catch (error) {
      if (error instanceof APIClientError) {
        setDeleteError(error.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, [deleteEmail, fetchInvitations, meta.page]);

  /**
   * Handle resend invitation
   */
  const handleResend = useCallback(
    async (invitation: InvitationListItem) => {
      setResendingEmail(invitation.email);
      setResendSuccess(null);
      try {
        // Use the existing invite API with resend=true
        await apiClient.post(`${API.USERS.INVITE}?resend=true`, {
          body: {
            name: invitation.name,
            email: invitation.email,
            role: invitation.role,
          },
        });
        setResendSuccess(invitation.email);
        // Clear success message after 3 seconds
        resendSuccessTimeoutRef.current = setTimeout(() => setResendSuccess(null), 3000);
        // Refresh the list to get updated expiration
        void fetchInvitations(meta.page);
      } catch {
        // Error is silently caught — Batch 6 will add proper error state UI
      } finally {
        setResendingEmail(null);
      }
    },
    [fetchInvitations, meta.page]
  );

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
            placeholder="Search invitations..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Success message */}
      {resendSuccess && (
        <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-600">
          Invitation resent successfully to {resendSuccess}
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[18%]">
                <Button
                  variant="ghost"
                  className="data-[state=open]:bg-accent -ml-4 h-8"
                  onClick={() => handleSort('name')}
                >
                  Name
                  {renderSortIcon('name')}
                </Button>
              </TableHead>
              <TableHead className="w-[22%]">
                <Button
                  variant="ghost"
                  className="data-[state=open]:bg-accent -ml-4 h-8"
                  onClick={() => handleSort('email')}
                >
                  Email
                  {renderSortIcon('email')}
                </Button>
              </TableHead>
              <TableHead className="w-20 text-center">Role</TableHead>
              <TableHead className="w-[15%]">Invited By</TableHead>
              <TableHead className="w-24">
                <Button
                  variant="ghost"
                  className="data-[state=open]:bg-accent -ml-4 h-8"
                  onClick={() => handleSort('invitedAt')}
                >
                  Invited
                  {renderSortIcon('invitedAt')}
                </Button>
              </TableHead>
              <TableHead className="w-28">
                <Button
                  variant="ghost"
                  className="data-[state=open]:bg-accent -ml-4 h-8"
                  onClick={() => handleSort('expiresAt')}
                >
                  Expires
                  {renderSortIcon('expiresAt')}
                </Button>
              </TableHead>
              <TableHead className="w-12 text-center">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && invitations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  Loading...
                </TableCell>
              </TableRow>
            ) : invitations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  No pending invitations.
                </TableCell>
              </TableRow>
            ) : (
              invitations.map((invitation) => (
                <TableRow key={invitation.email}>
                  <TableCell className="truncate font-medium">{invitation.name}</TableCell>
                  <TableCell className="text-muted-foreground truncate">
                    {invitation.email}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={getRoleBadgeVariant(invitation.role)}>
                      {invitation.role || 'USER'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground truncate">
                    {invitation.invitedByName || 'Unknown'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <ClientDate date={invitation.invitedAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <ClientDate
                        date={invitation.expiresAt}
                        className={
                          isExpiringSoon(invitation.expiresAt)
                            ? 'text-orange-500'
                            : 'text-muted-foreground'
                        }
                      />
                      {isExpiringSoon(invitation.expiresAt) && (
                        <Badge variant="outline" className="ml-1 border-orange-300 text-orange-500">
                          <Clock className="mr-1 h-3 w-3" />
                          Soon
                        </Badge>
                      )}
                    </div>
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
                        <DropdownMenuItem
                          onClick={() => void handleResend(invitation)}
                          disabled={resendingEmail === invitation.email}
                        >
                          <RefreshCw
                            className={`mr-2 h-4 w-4 ${resendingEmail === invitation.email ? 'animate-spin' : ''}`}
                          />
                          {resendingEmail === invitation.email ? 'Resending...' : 'Resend'}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => setDeleteEmail(invitation.email)}
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
          {meta.total === 0 ? (
            'No invitations'
          ) : (
            <>
              Showing {(meta.page - 1) * meta.limit + 1} to{' '}
              {Math.min(meta.page * meta.limit, meta.total)} of {meta.total} invitations
            </>
          )}
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
            Page {meta.page} of {meta.totalPages || 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePageChange(meta.page + 1)}
            disabled={meta.page >= (meta.totalPages || 1) || isLoading}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteEmail} onOpenChange={() => setDeleteEmail(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Invitation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the invitation for <strong>{deleteEmail}</strong>?
              This action cannot be undone. The user will no longer be able to accept this
              invitation.
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
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
