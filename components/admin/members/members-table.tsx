'use client';

/**
 * The org's members, with role change and removal (§111 t-813).
 *
 * Over `PATCH` / `DELETE /api/v1/orgs/[id]/members/[userId]`. Every control
 * is offered to whoever can open the page, and the API decides: an ADMIN
 * changing an OWNER, demoting the last OWNER, or touching the install org's
 * members are refused there, and the refusal is shown as the API words it.
 * The roster comes from the server page; a successful change refreshes it.
 *
 * When the app lets org admins grant named tiers (t-1123), a Console access
 * column shows what each MEMBER may use, and opens a dialog to change it.
 * Owners and admins read "All": their role already opens every tier. With no
 * grantable tier the column is not shown at all.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { OrgRoleHelp } from '@/components/admin/members/org-role-help';
import { MemberTiersDialog } from '@/components/admin/members/member-tiers-dialog';
import type { GrantableTier } from '@/components/admin/members/tier-checklist';
import { FieldHelp } from '@/components/ui/field-help';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { useCommittedDialog } from '@/lib/hooks/use-committed-dialog';
import { DEFAULT_ORG_ROLE, isOrgRole, ORG_ROLES, type OrgRole } from '@/lib/tenancy/roles';

export interface OrgMember {
  id: string;
  name: string | null;
  email: string;
  role: OrgRole;
  /** The named tiers the member's grant lists (t-1123); absent or empty for none. */
  tiers?: string[];
  joinedAt: string;
}

export interface MembersTableProps {
  orgId: string;
  members: OrgMember[];
  currentUserId: string | null;
  /** The tiers an org admin may grant here (t-1123); empty hides the column. */
  grantableTiers?: GrantableTier[];
}

export function MembersTable({
  orgId,
  members,
  currentUserId,
  grantableTiers = [],
}: MembersTableProps) {
  const t = useTranslations('admin.members');
  const tShell = useTranslations('admin.shell');
  const format = useFormatter();
  const router = useRouter();
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OrgMember | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [changingTiers, setChangingTiers] = useState<OrgMember | null>(null);
  const showTiers = grantableTiers.length > 0;
  const tierLabel = new Map(grantableTiers.map((tier) => [tier.name, tier.label]));
  // A tier the app no longer offers is shown by its name, not hidden: it is
  // still in the grant, and saving the dialog drops it.
  const tiersOf = (member: OrgMember) =>
    (member.tiers ?? []).map((name) => tierLabel.get(name) ?? name);
  // A role change reports above the table; the remove dialog has its own.
  const listSave = useSaveFailure({
    fallback: t('table.roleChangeFailed'),
    fields: NO_SERVER_FIELDS,
  });
  const removeSave = useSaveFailure({
    fallback: t('table.removeFailed'),
    fields: NO_SERVER_FIELDS,
  });

  const changeRole = async (member: OrgMember, role: string) => {
    if (!isOrgRole(role) || role === member.role) return;
    setBusyUserId(member.id);
    listSave.clear();
    try {
      await apiClient.patch(API.ORGS.member(orgId, member.id), { body: { role } });
      router.refresh();
    } catch (err) {
      listSave.report(err, t('table.roleChangeFailedFor', { who: member.name || member.email }));
    } finally {
      setBusyUserId(null);
    }
  };

  // The dialog stays open on failure, with the refusal above its buttons.
  const remove = async (member: OrgMember) => {
    setBusyUserId(member.id);
    setIsRemoving(true);
    removeSave.clear();
    try {
      await apiClient.delete(API.ORGS.member(orgId, member.id));
      setRemoving(null);
      router.refresh();
    } catch (err) {
      removeSave.report(err);
    } finally {
      setIsRemoving(false);
      setBusyUserId(null);
    }
  };

  // Committed while the removal runs; a failure from one row never shows on the next.
  const removeDialog = useCommittedDialog({
    open: !!removing,
    pending: isRemoving,
    onClose: () => setRemoving(null),
    clear: removeSave.clear,
  });

  return (
    <div className="space-y-3">
      <SaveError failure={listSave.failure} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('table.name')}</TableHead>
              <TableHead>{t('table.email')}</TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  {t('table.role')} <OrgRoleHelp />
                </span>
              </TableHead>
              {showTiers && (
                <TableHead>
                  <span className="flex items-center gap-1">
                    {t('tiers.label')}{' '}
                    <FieldHelp title={t('tiers.helpTitle')}>
                      <p>{t('tiers.help')}</p>
                    </FieldHelp>
                  </span>
                </TableHead>
              )}
              <TableHead>{t('table.joined')}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{tShell('actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={showTiers ? 6 : 5}
                  className="text-muted-foreground py-8 text-center"
                >
                  {t('table.empty')}
                </TableCell>
              </TableRow>
            ) : (
              members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">
                    {member.name || '—'}
                    {member.id === currentUserId && (
                      <span className="text-muted-foreground ml-1 text-xs">{t('table.you')}</span>
                    )}
                  </TableCell>
                  <TableCell>{member.email}</TableCell>
                  <TableCell>
                    <Select
                      value={member.role}
                      disabled={busyUserId === member.id}
                      onValueChange={(role) => void changeRole(member, role)}
                    >
                      <SelectTrigger
                        className="h-8 w-32"
                        aria-label={t('table.roleFor', { who: member.name || member.email })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ORG_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {t(`roles.${role}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  {showTiers && (
                    <TableCell>
                      {member.role === DEFAULT_ORG_ROLE ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 max-w-56 justify-start truncate"
                          disabled={busyUserId === member.id}
                          onClick={() => setChangingTiers(member)}
                          aria-label={t('tiers.edit', { who: member.name || member.email })}
                        >
                          {tiersOf(member).join(', ') || t('tiers.none')}
                        </Button>
                      ) : (
                        <span className="text-muted-foreground text-sm">{t('tiers.all')}</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell>{format.dateTime(new Date(member.joinedAt), 'short')}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busyUserId === member.id}
                      onClick={() => setRemoving(member)}
                      aria-label={t('table.remove', { who: member.name || member.email })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {showTiers && (
        <MemberTiersDialog
          orgId={orgId}
          member={changingTiers}
          grantableTiers={grantableTiers}
          onClose={() => setChangingTiers(null)}
        />
      )}

      <AlertDialog open={!!removing} onOpenChange={removeDialog.onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('table.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.id === currentUserId
                ? t('table.removeSelf')
                : t('table.removeOther', { who: removing?.name || removing?.email || '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={removeSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel {...removeDialog.cancelProps}>{tShell('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              {...removeDialog.actionProps()}
              onClick={(e) =>
                removeDialog.confirm(e, () => {
                  if (removing) void remove(removing);
                })
              }
            >
              {t('table.removeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
