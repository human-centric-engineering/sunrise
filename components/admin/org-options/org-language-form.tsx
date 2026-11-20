'use client';

/**
 * OrgLanguageForm — the language an org's members see by default (§138 t-1074)
 *
 * The org-tier UI for `PUT /api/v1/orgs/[id]/locale`. A member who has not
 * picked a language of their own sees this one; clearing it ("each member's
 * browser language") leaves them to their browser's. The route decides who
 * may set it (the org's OWNER/ADMIN, acting in it, with a browser session)
 * and its refusal shows beside Save.
 *
 * The options come from the server (`localeOptions()`), each language named
 * in itself, so this component never imports the locale registry or the
 * catalogue. After a save the page re-renders, so an admin with no language
 * of their own sees the change at once.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SaveError } from '@/components/forms/form-error';
import type { LanguageOption } from '@/components/settings/language-form';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** The select's value for "no org default". Radix Select has no empty value. */
const FOLLOW_BROWSER = '__browser__';

export interface OrgLanguageFormProps {
  orgId: string;
  /** The org's stored default, `Org.settings.locale`; `null` when it has none. */
  locale: string | null;
  /** The languages the org may pick, from `localeOptions()` on the server. */
  options: LanguageOption[];
}

export function OrgLanguageForm({ orgId, locale, options }: OrgLanguageFormProps) {
  const t = useTranslations('admin.orgOptions.language');
  const router = useRouter();
  const failure = useSaveFailure({ fallback: t('saveFailed'), fields: NO_SERVER_FIELDS });

  // A stored tag the install no longer offers shows as no default, which is
  // what the resolution does with it too. `stored` keeps the tag, so Save
  // stays enabled and saving clears it.
  const initial = locale && options.some((o) => o.tag === locale) ? locale : FOLLOW_BROWSER;
  const [stored, setStored] = useState(locale ?? FOLLOW_BROWSER);
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    failure.clear();
    setSaving(true);
    setSaved(false);
    try {
      await apiClient.put(API.ORGS.locale(orgId), {
        body: { locale: value === FOLLOW_BROWSER ? null : value },
      });
      setStored(value);
      setSaved(true);
      router.refresh();
    } catch (err) {
      failure.report(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="org-locale" className="flex items-center gap-1">
          {t('label')}
          <FieldHelp title={t('helpTitle')}>
            <p>{t('help')}</p>
            <p className="mt-2">{t('helpBrowser')}</p>
          </FieldHelp>
        </Label>
        <Select
          value={value}
          onValueChange={(next) => {
            setSaved(false);
            setValue(next);
          }}
          disabled={saving}
        >
          <SelectTrigger id="org-locale" className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW_BROWSER}>{t('useBrowser')}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option.tag} value={option.tag} lang={option.tag}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || value === stored}>
          {saving ? t('saving') : t('save')}
        </Button>
        {saved && <span className="text-sm text-green-600">{t('saved')}</span>}
      </div>
      <SaveError failure={failure.failure} />
    </div>
  );
}
