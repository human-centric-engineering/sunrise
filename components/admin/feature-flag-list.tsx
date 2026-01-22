'use client';

/**
 * Feature Flag List Component (Phase 4.4)
 *
 * Displays feature flags with quick toggle functionality.
 */

import { useState, useCallback, useEffect } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
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
import { Plus, Trash2, Info } from 'lucide-react';
import type { FeatureFlag } from '@/types/prisma';
import { apiClient, APIClientError } from '@/lib/api/client';
import { ClientDate } from '@/components/ui/client-date';

interface FeatureFlagListProps {
  initialFlags: FeatureFlag[];
  onCreateClick: () => void;
  onEditClick: (flag: FeatureFlag) => void;
}

export function FeatureFlagList({
  initialFlags,
  onCreateClick,
  onEditClick,
}: FeatureFlagListProps) {
  const [flags, setFlags] = useState(initialFlags);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync with parent state when initialFlags changes (e.g., after creating a new flag)
  useEffect(() => {
    setFlags(initialFlags);
  }, [initialFlags]);

  /**
   * Toggle a flag's enabled state
   */
  const handleToggle = useCallback(async (flag: FeatureFlag) => {
    setTogglingId(flag.id);
    setError(null);

    try {
      const updatedFlag = await apiClient.patch<FeatureFlag>(
        `/api/v1/admin/feature-flags/${flag.id}`,
        {
          body: { enabled: !flag.enabled },
        }
      );

      setFlags((prev) => prev.map((f) => (f.id === flag.id ? updatedFlag : f)));
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      }
    } finally {
      setTogglingId(null);
    }
  }, []);

  /**
   * Delete a flag
   */
  const handleDelete = useCallback(async () => {
    if (!deleteId) return;

    setIsDeleting(true);
    setError(null);

    try {
      await apiClient.delete(`/api/v1/admin/feature-flags/${deleteId}`);
      setFlags((prev) => prev.filter((f) => f.id !== deleteId));
      setDeleteId(null);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      }
    } finally {
      setIsDeleting(false);
    }
  }, [deleteId]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">
            {flags.length} feature flag{flags.length !== 1 ? 's' : ''}
          </span>
        </div>
        <Button onClick={onCreateClick}>
          <Plus className="mr-2 h-4 w-4" />
          Create Flag
        </Button>
      </div>

      {/* Error message */}
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden md:table-cell">Description</TableHead>
              <TableHead className="text-center">Enabled</TableHead>
              <TableHead className="hidden sm:table-cell">Created</TableHead>
              <TableHead className="w-12">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flags.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Info className="text-muted-foreground h-8 w-8" />
                    <p className="text-muted-foreground">No feature flags yet</p>
                    <Button variant="outline" size="sm" onClick={onCreateClick}>
                      Create your first flag
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              flags.map((flag) => (
                <TableRow key={flag.id}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => onEditClick(flag)}
                        className="w-fit text-left"
                      >
                        <Badge
                          variant="outline"
                          className="hover:bg-accent cursor-pointer font-mono text-xs transition-colors"
                        >
                          {flag.name}
                        </Badge>
                      </button>
                      {flag.description && (
                        <p className="text-muted-foreground line-clamp-1 text-xs md:hidden">
                          {flag.description}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <p className="text-muted-foreground line-clamp-2 text-sm">
                      {flag.description || '-'}
                    </p>
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={flag.enabled}
                      onCheckedChange={() => void handleToggle(flag)}
                      disabled={togglingId === flag.id}
                      aria-label={`Toggle ${flag.name}`}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden sm:table-cell">
                    <ClientDate date={flag.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/20"
                      onClick={() => setDeleteId(flag.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span className="sr-only">Delete {flag.name}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Feature Flag</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this feature flag? This action cannot be undone. Any
              code checking this flag will receive a &quot;false&quot; value.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              className="bg-red-600 hover:bg-red-700"
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
