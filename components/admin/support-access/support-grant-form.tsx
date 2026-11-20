'use client';

/**
 * Grant the vendor's support staff access to this organisation (§121 t-823).
 *
 * Posts to `POST /api/v1/orgs/[id]/support-grants`. The API decides: only an
 * owner of the organisation, acting in it, may grant, and the page shows this
 * form to owners only. A new grant replaces the open one, which the form says
 * before it is sent.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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
import { FormError, SaveError } from '@/components/forms/form-error';
import { SupportLevelHelp } from '@/components/admin/support-access/support-level-help';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
import { DEFAULT_SUPPORT_GRANT_LEVEL, SUPPORT_GRANT_LEVELS } from '@/lib/tenancy/roles';
import {
  buildSupportGrantSchema,
  SUPPORT_GRANT_DEFAULT_HOURS,
  SUPPORT_GRANT_MAX_HOURS,
} from '@/lib/validations/tenancy';
import type { ValidationT } from '@/lib/validations/messages';

/** Looks up a duration in `admin.supportAccess`; ICU plurals do the counting. */
export type DurationT = (
  key: 'duration' | 'durationDays',
  values: { hours: number } | { days: number }
) => string;

/** A duration as the form shows it: hours up to a day, whole days beyond. */
export function durationLabel(hours: number, t: DurationT): string {
  if (hours > 24 && hours % 24 === 0) return t('durationDays', { days: hours / 24 });
  return t('duration', { hours });
}

/**
 * The durations offered, in hours: the default and the API's maximum always
 * among them, none past the maximum, each once.
 */
export const SUPPORT_GRANT_DURATIONS: readonly number[] = [
  ...new Set([1, 4, SUPPORT_GRANT_DEFAULT_HOURS, 72, SUPPORT_GRANT_MAX_HOURS]),
]
  .filter((hours) => hours <= SUPPORT_GRANT_MAX_HOURS)
  .sort((a, b) => a - b);

// The route's own schema, with level and duration required because the form
// always has one selected. Unwrapped, not redeclared, so the route's bounds
// hold. Built with the form's translator, so its errors read in the viewer's
// language.
function grantFormSchemaFor(t: ValidationT) {
  const base = buildSupportGrantSchema(t);
  return base.extend({
    level: base.shape.level.unwrap(),
    durationHours: base.shape.durationHours.unwrap(),
  });
}

type GrantFormData = z.infer<ReturnType<typeof grantFormSchemaFor>>;

/**
 * Server path → the field that shows its message. Only the reason renders
 * `errors.x`; the level and duration selects render none, so their messages
 * join the summary (`.context/ui/form-errors.md`).
 */
const SERVER_FIELDS: Partial<Record<string, keyof GrantFormData>> = {
  reason: 'reason',
};

export interface SupportGrantFormProps {
  orgId: string;
  /** An open grant exists, so sending this one replaces it. */
  replacesOpenGrant: boolean;
}

export function SupportGrantForm({ orgId, replacesOpenGrant }: SupportGrantFormProps) {
  const t = useTranslations('admin.supportAccess');
  const tv = useTranslations('validation');
  const grantFormSchema = useMemo(() => grantFormSchemaFor(tv), [tv]);
  const duration = (hours: number) => durationLabel(hours, t);
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    setError,
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
  const save = useSaveFailure({
    fallback: t('form.failed'),
    fields: SERVER_FIELDS,
    setError,
    errors,
  });

  const onSubmit = async (data: GrantFormData) => {
    setSubmitting(true);
    try {
      await apiClient.post(API.ORGS.supportGrants(orgId), { body: data });
      reset();
      router.refresh();
    } catch (err) {
      save.report(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t('form.title')}</CardTitle>
        <CardDescription>{t('form.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          method="post"
          onSubmit={save.submit(handleSubmit(onSubmit, save.invalid))}
          className="space-y-4"
          noValidate
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="grant-level" className="flex items-center gap-1">
                {t('form.level')} <SupportLevelHelp />
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
                      {t(`levels.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="grant-duration" className="flex items-center gap-1">
                {t('form.for')}{' '}
                <FieldHelp title={t('form.durationHelpTitle')}>
                  <p>{t('form.durationHelp')}</p>
                  <p className="mt-2">
                    {t('form.durationHelpMax', { max: duration(SUPPORT_GRANT_MAX_HOURS) })}
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
                  {SUPPORT_GRANT_DURATIONS.map((hours) => (
                    <SelectItem key={hours} value={String(hours)}>
                      {duration(hours)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="grant-reason" className="flex items-center gap-1">
              {t('form.reason')}{' '}
              <FieldHelp title={t('form.reasonHelpTitle')}>
                <p>{t('form.reasonHelp')}</p>
              </FieldHelp>
            </Label>
            <Textarea id="grant-reason" rows={3} {...register('reason')} />
            <FormError message={errors.reason?.message} />
          </div>

          {replacesOpenGrant && (
            <p className="text-muted-foreground text-sm">{t('form.replaces')}</p>
          )}

          <Button type="submit" disabled={submitting}>
            <ShieldCheck className="mr-2 h-4 w-4" />
            {submitting
              ? t('form.granting')
              : replacesOpenGrant
                ? t('form.replace')
                : t('form.grant')}
          </Button>

          <SaveError failure={save.failure} />
        </form>
      </CardContent>
    </Card>
  );
}
