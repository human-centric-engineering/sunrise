'use client';

/**
 * Change which parts of the console a MEMBER can use (t-1123).
 *
 * Over `PUT /api/v1/orgs/[id]/members/[userId]/tiers`. The ticks start at the
 * member's current grant; Save sends the whole list, and an empty one takes
 * their access away. The API decides what may be granted and says why it
 * refuses, which shows above the buttons. A successful save refreshes the
 * roster, which closes the dialog with it.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SaveError } from '@/components/forms/form-error';
import { TierChecklist, type GrantableTier } from '@/components/admin/members/tier-checklist';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

export interface MemberTiersDialogProps {
  orgId: string;
  /** The member being changed, or `null` when the dialog is closed. */
  member: { id: string; name: string | null; email: string; tiers?: string[] } | null;
  grantableTiers: GrantableTier[];
  onClose: () => void;
}

export function MemberTiersDialog({
  orgId,
  member,
  grantableTiers,
  onClose,
}: MemberTiersDialogProps) {
  const t = useTranslations('admin.members.tiers');
  const tShell = useTranslations('admin.shell');
  const router = useRouter();
  const [value, setValue] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const save = useSaveFailure({ fallback: t('saveFailed'), fields: NO_SERVER_FIELDS });
  const { clear } = save;

  // Each opening starts from that member's grant, with no earlier failure.
  useEffect(() => {
    if (member) {
      setValue(member.tiers ?? []);
      clear();
    }
  }, [member, clear]);

  const who = member ? member.name || member.email : '';

  const submit = async () => {
    if (!member) return;
    setSaving(true);
    save.clear();
    try {
      await apiClient.put(API.ORGS.memberTiers(orgId, member.id), { body: { tiers: value } });
      onClose();
      router.refresh();
    } catch (err) {
      save.report(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!member}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('dialogTitle', { who })}</DialogTitle>
          <DialogDescription>{t('dialogDescription', { who })}</DialogDescription>
        </DialogHeader>
        <TierChecklist
          tiers={grantableTiers}
          value={value}
          onChange={setValue}
          idPrefix={`member-tiers-${member?.id ?? 'none'}`}
          disabled={saving}
        />
        <SaveError failure={save.failure} />
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            {tShell('cancel')}
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
