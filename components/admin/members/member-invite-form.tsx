'use client';

/**
 * Invite someone into the org being administered (§111 t-813).
 *
 * Posts to `POST /api/v1/orgs/[id]/invitations`. The API decides what may be
 * invited (an ADMIN cannot invite an OWNER, the install org takes no
 * invitations from here) and the form shows its answer as given. When an
 * invitation is already pending for the email, the form offers to re-send it.
 *
 * When the app lets org admins grant named tiers (t-1123), a MEMBER invitation
 * can carry some: ticks under the role, shown only while the role is Member,
 * and written as the member's grant when they accept.
 *
 * "Send it again" sends what the form shows (t-1125). When the API answers
 * that an invitation is already pending, the role and ticks are set to that
 * invitation's, so a resend left untouched keeps it as it is, and one the
 * admin changed (a tick added, every tick removed, another role) is sent
 * as shown.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle, Send } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormError, SaveError } from '@/components/forms/form-error';
import { OrgRoleHelp } from '@/components/admin/members/org-role-help';
import { TierChecklist, type GrantableTier } from '@/components/admin/members/tier-checklist';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { DEFAULT_ORG_ROLE, isOrgRole, ORG_ROLES } from '@/lib/tenancy/roles';
import { createInviteOrgMemberSchema } from '@/lib/validations/tenancy';
import type { ValidationT } from '@/lib/validations/messages';

// The route's own schema, with the role required because the form always
// has one selected. Built with the form's translator, so its field errors
// read in the viewer's language.
function inviteFormSchemaFor(t: ValidationT) {
  return createInviteOrgMemberSchema(t).extend({ orgRole: z.enum(ORG_ROLES) });
}

type InviteFormData = z.infer<ReturnType<typeof inviteFormSchemaFor>>;

/**
 * Server path → the field that shows its message. Only fields that render
 * `errors.x` are listed; the role select renders none, so its message joins
 * the summary (`.context/ui/form-errors.md`).
 */
const SERVER_FIELDS: Partial<Record<string, keyof InviteFormData>> = {
  name: 'name',
  email: 'email',
};

interface OrgInvitationResponse {
  message: string;
  invitation: { email: string; name: string; orgRole?: string | null; tiers?: string[] };
  emailStatus: 'sent' | 'failed' | 'disabled' | 'pending';
}

export interface MemberInviteFormProps {
  orgId: string;
  /** The tiers an org admin may grant here (t-1123); empty shows no ticks. */
  grantableTiers?: GrantableTier[];
}

export function MemberInviteForm({ orgId, grantableTiers = [] }: MemberInviteFormProps) {
  const t = useTranslations('admin.members');
  const tv = useTranslations('validation');
  const inviteFormSchema = useMemo(() => inviteFormSchemaFor(tv), [tv]);
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OrgInvitationResponse | null>(null);
  // Who the API said already has a pending invitation: "Send it again"
  // re-sends to that name and email, with the role and ticks the form shows.
  const [pending, setPending] = useState<{ name: string; email: string } | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    setError,
    watch,
    reset,
    formState: { errors },
  } = useForm<InviteFormData>({
    resolver: zodResolver(inviteFormSchema),
    mode: 'onTouched',
    defaultValues: { name: '', email: '', orgRole: DEFAULT_ORG_ROLE, tiers: [] },
  });
  const orgRole = watch('orgRole');
  const tiers = watch('tiers') ?? [];
  // Tiers widen a Member only; any other role sends none.
  const offersTiers = grantableTiers.length > 0 && orgRole === DEFAULT_ORG_ROLE;
  // The notice names console access only when the pending invitation carries a
  // tier the form can show: one the app no longer offers is not ticked, and a
  // resend does not keep it.
  const pendingHasAccess = (result?.invitation.tiers ?? []).some((name) =>
    grantableTiers.some((tier) => tier.name === name)
  );
  // One failure for both sends: "Send it again" is a save of the same form.
  const save = useSaveFailure({
    fallback: t('invite.failed'),
    fields: SERVER_FIELDS,
    setError,
    errors,
  });

  const send = async (
    data: Pick<InviteFormData, 'name' | 'email'> & Partial<InviteFormData>,
    resend: boolean
  ) => {
    setSubmitting(true);
    try {
      const response = await apiClient.post<OrgInvitationResponse>(API.ORGS.invitations(orgId), {
        body: data,
        ...(resend ? { params: { resend: 'true' } } : {}),
      });
      setResult(response);
      setPending(
        response.emailStatus === 'pending' ? { name: data.name, email: data.email } : null
      );
      if (response.emailStatus === 'pending') {
        // Show the pending invitation's own role and ticks, so the form is
        // what "Send it again" will send.
        const pendingRole = response.invitation.orgRole;
        setValue('orgRole', pendingRole && isOrgRole(pendingRole) ? pendingRole : DEFAULT_ORG_ROLE);
        const offered = new Set(grantableTiers.map((tier) => tier.name));
        setValue(
          'tiers',
          (response.invitation.tiers ?? []).filter((name) => offered.has(name))
        );
      } else {
        reset();
        router.refresh();
      }
    } catch (err) {
      setResult(null);
      setPending(null);
      save.report(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t('invite.title')}</CardTitle>
        <CardDescription>{t('invite.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          onSubmit={save.submit(
            handleSubmit(
              ({ tiers: picked, ...data }) =>
                send(
                  data.orgRole === DEFAULT_ORG_ROLE && picked && picked.length > 0
                    ? { ...data, tiers: picked }
                    : data,
                  false
                ),
              save.invalid
            )
          )}
          className="space-y-4"
          noValidate
        >
          <div className="grid gap-4 md:grid-cols-[1fr_1fr_12rem_auto] md:items-end">
            <div className="space-y-2">
              <Label htmlFor="invite-name">{t('invite.name')}</Label>
              <Input id="invite-name" autoComplete="off" {...register('name')} />
              <FormError message={errors.name?.message} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-email" className="flex items-center gap-1">
                {t('invite.email')}{' '}
                <FieldHelp title={t('invite.emailHelpTitle')}>
                  <p>{t('invite.emailHelp')}</p>
                  <p className="mt-2">{t('invite.emailHelpExisting')}</p>
                </FieldHelp>
              </Label>
              <Input id="invite-email" type="email" autoComplete="off" {...register('email')} />
              <FormError message={errors.email?.message} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role" className="flex items-center gap-1">
                {t('invite.role')} <OrgRoleHelp />
              </Label>
              <Select
                value={orgRole}
                onValueChange={(value) =>
                  setValue('orgRole', inviteFormSchema.shape.orgRole.parse(value))
                }
              >
                <SelectTrigger id="invite-role">
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
            </div>
            <Button type="submit" disabled={submitting}>
              <Send className="mr-2 h-4 w-4" />
              {submitting ? t('invite.sending') : t('invite.send')}
            </Button>
          </div>

          {offersTiers && (
            <fieldset className="space-y-2">
              <legend className="flex items-center gap-1 text-sm font-medium">
                {t('tiers.label')}{' '}
                <FieldHelp title={t('tiers.helpTitle')}>
                  <p>{t('tiers.help')}</p>
                  <p className="mt-2">{t('tiers.memberOnly')}</p>
                </FieldHelp>
              </legend>
              <TierChecklist
                tiers={grantableTiers}
                value={tiers}
                onChange={(next) => setValue('tiers', next)}
                idPrefix="invite-tier"
                disabled={submitting}
              />
            </fieldset>
          )}

          {/* Under Send, and above "Send it again" when that is offered */}
          <SaveError failure={save.failure} />
        </form>

        {result?.emailStatus === 'pending' && pending && (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span>
              {/* Console access is named only when the pending invitation carries some (t-1123). */}
              {result.invitation.orgRole && isOrgRole(result.invitation.orgRole)
                ? t(pendingHasAccess ? 'invite.pendingAsWithAccess' : 'invite.pendingAs', {
                    email: result.invitation.email,
                    role: t(`roles.${result.invitation.orgRole}`),
                  })
                : t(pendingHasAccess ? 'invite.pendingWithAccess' : 'invite.pending', {
                    email: result.invitation.email,
                  })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => {
                save.clear();
                // The role always, and the ticks exactly as shown while they
                // are (an empty list removes them). With no ticks on offer,
                // or another role, none are sent and the API keeps none.
                const { orgRole: role, tiers: picked } = getValues();
                void send(
                  {
                    ...pending,
                    orgRole: role,
                    ...(grantableTiers.length > 0 && role === DEFAULT_ORG_ROLE
                      ? { tiers: picked ?? [] }
                      : {}),
                  },
                  true
                );
              }}
            >
              {t('invite.sendAgain')}
            </Button>
          </div>
        )}

        {result && result.emailStatus !== 'pending' && (
          <div className="mt-4 space-y-2 text-sm">
            <p className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
              {result.emailStatus === 'sent'
                ? t('invite.sent', { email: result.invitation.email })
                : t('invite.saved', { email: result.invitation.email })}
            </p>
            {result.emailStatus !== 'sent' && (
              <p className="text-muted-foreground">{t('invite.emailNotSent')}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
