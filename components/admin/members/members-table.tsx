'use client';

/**
 * The org's members, with role change and removal (§111 t-813).
 *
 * Over `PATCH` / `DELETE /api/v1/orgs/[id]/members/[userId]`. Every control
 * is offered to whoever can open the page, and the API decides: an ADMIN
 * changing an OWNER, demoting the last OWNER, or touching the install org's
 * members are refused there, and the refusal is shown as the API words it.
 * The roster comes from the server page; a successful change refreshes it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { ClientDate } from '@/components/ui/client-date';
import { OrgRoleHelp, ORG_ROLE_LABELS } from '@/components/admin/members/org-role-help';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';
import { isOrgRole, ORG_ROLES, type OrgRole } from '@/lib/tenancy/roles';

export interface OrgMember {
  id: string;
  name: string | null;
  email: string;
  role: OrgRole;
  joinedAt: string;
}

export interface MembersTableProps {
  orgId: string;
  members: OrgMember[];
  currentUserId: string | null;
}

export function MembersTable({ orgId, members, currentUserId }: MembersTableProps) {
  const router = useRouter();
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OrgMember | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  // A role change reports above the table; the remove dialog has its own.
  const listSave = useSaveFailure({
    fallback: 'Could not change the role. Try again.',
    fields: NO_SERVER_FIELDS,
  });
  const removeSave = useSaveFailure({
    fallback: 'Could not remove the member. Try again.',
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
      listSave.report(err, `Couldn't change the role of "${member.name || member.email}"`);
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

  return (
    <div className="space-y-3">
      <SaveError failure={listSave.failure} />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>
                <span className="flex items-center gap-1">
                  Role <OrgRoleHelp />
                </span>
              </TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                  No members yet.
                </TableCell>
              </TableRow>
            ) : (
              members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">
                    {member.name || '—'}
                    {member.id === currentUserId && (
                      <span className="text-muted-foreground ml-1 text-xs">(you)</span>
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
                        aria-label={`Role for ${member.name || member.email}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ORG_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {ORG_ROLE_LABELS[role]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <ClientDate date={member.joinedAt} />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busyUserId === member.id}
                      onClick={() => {
                        removeSave.clear();
                        setRemoving(member);
                      }}
                      aria-label={`Remove ${member.name || member.email}`}
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

      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          // Committed while the removal is in flight: a late failure must land here.
          if (!open && isRemoving) return;
          if (!open) {
            setRemoving(null);
            removeSave.clear();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.id === currentUserId
                ? 'You will lose access to this organisation, including this page, and be signed out of it. Your account and your access to other organisations are not affected.'
                : `${removing?.name || removing?.email} will lose access to this organisation and be signed out of it. Their account and their access to other organisations are not affected.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <SaveError failure={removeSave.failure} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRemoving}
              onClick={(e) => {
                // Closes only on success, so a failure stays readable here.
                e.preventDefault();
                if (removing) void remove(removing);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
