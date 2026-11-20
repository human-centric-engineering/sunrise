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
import { useFormatter, useTranslations } from 'next-intl';

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
import { SupportLevelHelp } from '@/components/admin/support-access/support-level-help';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
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

function statusOf(grant: SupportGrantRow): {
  label: 'open' | 'revoked' | 'expired';
  when: string;
} {
  if (grant.open) return { label: 'open', when: grant.expiresAt };
  if (grant.revokedAt) return { label: 'revoked', when: grant.revokedAt };
  return { label: 'expired', when: grant.expiresAt };
}

export function SupportGrantsTable({ orgId, grants }: SupportGrantsTableProps) {
  const t = useTranslations('admin.supportAccess');
  const tShell = useTranslations('admin.shell');
  const format = useFormatter();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  /** A person named on a grant, or what to say when their account is gone. */
  const personName = (person: { name: string | null } | null): string => {
    if (!person) return tShell('deletedAccount');
    return person.name || tShell('unnamed');
  };
  const when = (iso: string) => format.dateTime(new Date(iso), 'dateTime');
  const [revoking, setRevoking] = useState<SupportGrantRow | null>(null);
  // Revoke is the only row action, and it is confirmed in the dialog: its
  // failure shows there, and the dialog stays open.
  const revokeSave = useSaveFailure({
    fallback: t('grants.revokeFailed'),
    fields: NO_SERVER_FIELDS,
  });

  const revoke = async (grant: SupportGrantRow) => {
    setBusy(true);
    revokeSave.clear();
    try {
      await apiClient.delete(API.ORGS.supportGrant(orgId, grant.id));
      setRevoking(null);
      router.refresh();
    } catch (err) {
      revokeSave.report(err);
    } finally {
      setBusy(false);
    }
  };

  // Committed while the revoke runs; a failure from one grant never shows on the next.
  const revokeDialog = useCommittedDialog({
    open: !!revoking,
    pending: busy,
    onClose: () => setRevoking(null),
    clear: revokeSave.clear,
  });

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('grants.status')}</TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  {t('grants.level')} <SupportLevelHelp />
                </span>
              </TableHead>
              <TableHead>{t('grants.reason')}</TableHead>
              <TableHead>{t('grants.grantedBy')}</TableHead>
              <TableHead>{t('grants.granted')}</TableHead>
              <TableHead>{t('grants.ends')}</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">{tShell('actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {grants.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                  {t('grants.empty')}
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
                        {t(`grants.${status.label}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>{t(`levels.${grant.level}`)}</TableCell>
                    <TableCell className="max-w-xs text-sm break-words whitespace-pre-wrap">
                      {grant.reason}
                    </TableCell>
                    <TableCell>{personName(grant.grantedBy)}</TableCell>
                    <TableCell>{when(grant.createdAt)}</TableCell>
                    <TableCell>
                      {when(status.when)}
                      {grant.revokedAt && (
                        <span className="text-muted-foreground block text-xs">
                          {t('grants.revokedBy', { who: personName(grant.revokedBy) })}
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
                          {t('grants.revoke')}
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

      <AlertDialog open={!!revoking} onOpenChange={revokeDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('grants.revokeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('grants.revokeDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={revokeSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...revokeDialog.cancelProps}>{tShell('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              {...revokeDialog.actionProps()}
              onClick={(e) =>
                revokeDialog.confirm(e, () => {
                  if (revoking) void revoke(revoking);
                })
              }
            >
              {t('grants.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
