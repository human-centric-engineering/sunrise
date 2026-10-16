'use client';

/**
 * This organisation's support grants, newest first, with revoke on the open
 * one (§121 t-823).
 *
 * Over `DELETE /api/v1/orgs/[id]/support-grants/[grantId]`. Whoever can open
 * the page may revoke — the org's owners and admins — because ending access is
 * always safe; the API decides and its refusal is shown as worded. The list
 * comes from the server page; a revocation refreshes it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { ClientDate } from '@/components/ui/client-date';
import {
  SupportLevelHelp,
  SUPPORT_GRANT_LEVEL_LABELS,
} from '@/components/admin/support-access/support-level-help';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { SupportGrantLevel } from '@/lib/tenancy/roles';

/** One grant as `GET /api/v1/orgs/[id]/support-grants` returns it. */
export interface SupportGrantRow {
  id: string;
  level: SupportGrantLevel;
  reason: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  grantedBy: { id: string; name: string | null } | null;
  revokedBy: { id: string; name: string | null } | null;
  open: boolean;
}

export interface SupportGrantsTableProps {
  orgId: string;
  grants: SupportGrantRow[];
}

function statusOf(grant: SupportGrantRow): { label: string; when: string } {
  if (grant.open) return { label: 'Open', when: grant.expiresAt };
  if (grant.revokedAt) return { label: 'Revoked', when: grant.revokedAt };
  return { label: 'Expired', when: grant.expiresAt };
}

/** A person named on a grant, or what to say when their account is gone. */
function personName(person: { name: string | null } | null): string {
  if (!person) return 'Deleted account';
  return person.name || 'Unnamed';
}

export function SupportGrantsTable({ orgId, grants }: SupportGrantsTableProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<SupportGrantRow | null>(null);

  const revoke = async (grant: SupportGrantRow) => {
    setRevoking(null);
    setBusy(true);
    setError(null);
    try {
      await apiClient.delete(API.ORGS.supportGrant(orgId, grant.id));
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  Level <SupportLevelHelp />
                </span>
              </TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Granted by</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead>Ends</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                  Support has never been given access to this organisation.
                </TableCell>
              </TableRow>
            ) : (
              grants.map((grant) => {
                const status = statusOf(grant);
                return (
                  <TableRow key={grant.id}>
                    <TableCell>
                      <Badge
                        variant={grant.open ? 'default' : 'outline'}
                        className="px-1.5 py-0 text-[10px]"
                      >
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell>{SUPPORT_GRANT_LEVEL_LABELS[grant.level]}</TableCell>
                    <TableCell className="max-w-xs text-sm break-words whitespace-pre-wrap">
                      {grant.reason}
                    </TableCell>
                    <TableCell>{personName(grant.grantedBy)}</TableCell>
                    <TableCell>
                      <ClientDate date={grant.createdAt} showTime />
                    </TableCell>
                    <TableCell>
                      <ClientDate date={status.when} showTime />
                      {grant.revokedAt && (
                        <span className="text-muted-foreground block text-xs">
                          by {personName(grant.revokedBy)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {grant.open && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRevoking(grant)}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!revoking} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke support access</AlertDialogTitle>
            <AlertDialogDescription>
              Support loses access to this organisation now, including anyone from support who is
              working in it. You can grant access again at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => revoking && void revoke(revoking)}>
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
