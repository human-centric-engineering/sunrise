'use client';

/**
 * Grant the vendor's support staff access to this organisation (§121 t-823).
 *
 * Posts to `POST /api/v1/orgs/[id]/support-grants`. The API decides: only an
 * owner of the organisation, acting in it, may grant, and the page shows this
 * form to owners only. A new grant replaces the open one, which the form says
 * before it is sent.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ShieldCheck } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  SupportLevelHelp,
  SUPPORT_GRANT_LEVEL_LABELS,
} from '@/components/admin/support-access/support-level-help';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { DEFAULT_SUPPORT_GRANT_LEVEL, SUPPORT_GRANT_LEVELS } from '@/lib/tenancy/roles';
import {
  createSupportGrantSchema,
  SUPPORT_GRANT_DEFAULT_HOURS,
  SUPPORT_GRANT_MAX_HOURS,
} from '@/lib/validations/tenancy';

/** A duration as the form shows it: hours up to a day, whole days beyond. */
export function durationLabel(hours: number): string {
  if (hours > 24 && hours % 24 === 0) return `${hours / 24} days`;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/**
 * The durations offered, in hours: the default and the API's maximum always
 * among them, none past the maximum, each once.
 */
export const SUPPORT_GRANT_DURATIONS: readonly { hours: number; label: string }[] = [
  ...new Set([1, 4, SUPPORT_GRANT_DEFAULT_HOURS, 72, SUPPORT_GRANT_MAX_HOURS]),
]
  .filter((hours) => hours <= SUPPORT_GRANT_MAX_HOURS)
  .sort((a, b) => a - b)
  .map((hours) => ({ hours, label: durationLabel(hours) }));

// The route's own schema, with level and duration required because the form
// always has one selected. Unwrapped, not redeclared, so the route's bounds hold.
const grantFormSchema = createSupportGrantSchema.extend({
  level: createSupportGrantSchema.shape.level.unwrap(),
  durationHours: createSupportGrantSchema.shape.durationHours.unwrap(),
});

type GrantFormData = z.infer<typeof grantFormSchema>;

export interface SupportGrantFormProps {
  orgId: string;
  /** An open grant exists, so sending this one replaces it. */
  replacesOpenGrant: boolean;
}

export function SupportGrantForm({ orgId, replacesOpenGrant }: SupportGrantFormProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<GrantFormData>({
    resolver: zodResolver(grantFormSchema),
    mode: 'onTouched',
    defaultValues: {
      level: DEFAULT_SUPPORT_GRANT_LEVEL,
      reason: '',
      durationHours: SUPPORT_GRANT_DEFAULT_HOURS,
    },
  });
  const level = watch('level');
  const durationHours = watch('durationHours');

  const onSubmit = async (data: GrantFormData) => {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post(API.ORGS.supportGrants(orgId), { body: data });
      reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof APIClientError ? err.message : 'An unexpected error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Grant support access</CardTitle>
        <CardDescription>
          Let the platform&apos;s support staff into this organisation for a limited time, to help
          with a problem. Any of them can enter until the grant ends or you revoke it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          className="space-y-4"
          noValidate
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="grant-level" className="flex items-center gap-1">
                Access level <SupportLevelHelp />
              </Label>
              <Select
                value={level}
                onValueChange={(value) =>
                  setValue('level', grantFormSchema.shape.level.parse(value))
                }
              >
                <SelectTrigger id="grant-level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORT_GRANT_LEVELS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {SUPPORT_GRANT_LEVEL_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="grant-duration" className="flex items-center gap-1">
                For{' '}
                <FieldHelp title="How long access lasts">
                  <p>
                    Support can enter until this time runs out. Nothing needs doing when it ends:
                    access stops on its own.
                  </p>
                  <p className="mt-2">
                    The longest grant is {durationLabel(SUPPORT_GRANT_MAX_HOURS)}. If support needs
                    longer, grant again with a new reason.
                  </p>
                </FieldHelp>
              </Label>
              <Select
                value={String(durationHours)}
                onValueChange={(value) => setValue('durationHours', Number(value))}
              >
                <SelectTrigger id="grant-duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORT_GRANT_DURATIONS.map((option) => (
                    <SelectItem key={option.hours} value={String(option.hours)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="grant-reason" className="flex items-center gap-1">
              Reason{' '}
              <FieldHelp title="Why support needs access">
                <p>
                  Say what support is helping with, for example a ticket number or the agent that is
                  not working. Support sees this when they enter, and it stays on the record of this
                  grant.
                </p>
              </FieldHelp>
            </Label>
            <Textarea id="grant-reason" rows={3} {...register('reason')} />
            <FormError message={errors.reason?.message} />
          </div>

          {replacesOpenGrant && (
            <p className="text-muted-foreground text-sm">
              Support already has access. Granting again ends the current grant and starts this one.
            </p>
          )}

          <Button type="submit" disabled={submitting}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            {submitting ? 'Granting…' : replacesOpenGrant ? 'Replace grant' : 'Grant access'}
          </Button>

          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
