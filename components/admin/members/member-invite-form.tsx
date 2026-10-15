'use client';

/**
 * Invite someone into the org being administered (§111 t-813).
 *
 * Posts to `POST /api/v1/orgs/[id]/invitations`. The API decides what may be
 * invited (an ADMIN cannot invite an OWNER, the install org takes no
 * invitations from here) and the form shows its answer as given. When an
 * invitation is already pending for the email, the form offers to re-send it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { FormError } from '@/components/forms/form-error';
import { OrgRoleHelp, ORG_ROLE_LABELS } from '@/components/admin/members/org-role-help';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { DEFAULT_ORG_ROLE, isOrgRole, ORG_ROLES } from '@/lib/tenancy/roles';
import { inviteOrgMemberSchema } from '@/lib/validations/tenancy';

// The route's own schema, with the role required because the form always
// has one selected.
const inviteFormSchema = inviteOrgMemberSchema.extend({ orgRole: z.enum(ORG_ROLES) });

type InviteFormData = z.infer<typeof inviteFormSchema>;

interface OrgInvitationResponse {
  message: string;
  invitation: { email: string; name: string; orgRole?: string | null };
  emailStatus: 'sent' | 'failed' | 'disabled' | 'pending';
}

export interface MemberInviteFormProps {
  orgId: string;
}

export function MemberInviteForm({ orgId }: MemberInviteFormProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OrgInvitationResponse | null>(null);
  // Who the API said already has a pending invitation. "Send it again"
  // re-sends that invitation by name and email, with no role, so the API keeps
  // the role it was issued with rather than taking whatever the field holds.
  const [pending, setPending] = useState<{ name: string; email: string } | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<InviteFormData>({
    resolver: zodResolver(inviteFormSchema),
    mode: 'onTouched',
    defaultValues: { name: '', email: '', orgRole: DEFAULT_ORG_ROLE },
  });
  const orgRole = watch('orgRole');

  const send = async (
    data: Pick<InviteFormData, 'name' | 'email'> & Partial<InviteFormData>,
    resend: boolean
  ) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiClient.post<OrgInvitationResponse>(API.ORGS.invitations(orgId), {
        body: data,
        ...(resend ? { params: { resend: 'true' } } : {}),
      });
      setResult(response);
      setPending(
        response.emailStatus === 'pending' ? { name: data.name, email: data.email } : null
      );
      if (response.emailStatus !== 'pending') {
        reset();
        router.refresh();
      }
    } catch (err) {
      setResult(null);
      setPending(null);
      setError(err instanceof APIClientError ? err.message : 'An unexpected error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Invite a member</CardTitle>
        <CardDescription>
          They get an email with a link to create their account. They appear in the list once they
          accept.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => void handleSubmit((data) => send(data, false))(event)}
          className="grid gap-4 md:grid-cols-[1fr_1fr_12rem_auto] md:items-end"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="invite-name">Name</Label>
            <Input id="invite-name" autoComplete="off" {...register('name')} />
            <FormError message={errors.name?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-email" className="flex items-center gap-1">
              Email{' '}
              <FieldHelp title="Who can be invited">
                <p>
                  Anyone without an account here. The invitation link works for 7 days, and only for
                  this email address.
                </p>
                <p className="mt-2">
                  If the person already has an account, ask a platform admin to add them to this
                  organisation.
                </p>
              </FieldHelp>
            </Label>
            <Input id="invite-email" type="email" autoComplete="off" {...register('email')} />
            <FormError message={errors.email?.message} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="invite-role" className="flex items-center gap-1">
              Role <OrgRoleHelp />
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
                    {ORG_ROLE_LABELS[role]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={submitting}>
            <Send className="mr-2 h-4 w-4" />
            {submitting ? 'Sending…' : 'Send invitation'}
          </Button>
        </form>

        {error && (
          <p role="alert" className="text-destructive mt-4 text-sm">
            {error}
          </p>
        )}

        {result?.emailStatus === 'pending' && pending && (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span>
              An invitation to {result.invitation.email} is already pending
              {result.invitation.orgRole && isOrgRole(result.invitation.orgRole)
                ? ` as ${ORG_ROLE_LABELS[result.invitation.orgRole]}`
                : ''}
              . Sending it again keeps that role.
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => void send(pending, true)}
            >
              Send it again
            </Button>
          </div>
        )}

        {result && result.emailStatus !== 'pending' && (
          <div className="mt-4 space-y-2 text-sm">
            <p className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
              {result.message} ({result.invitation.email})
            </p>
            {result.emailStatus !== 'sent' && (
              <p className="text-muted-foreground">
                The invitation is saved, but the email did not go out. Ask a platform admin to
                re-send it from Users.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
