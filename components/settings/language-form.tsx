'use client';

/**
 * Language Form
 *
 * Lets a person pick the language their screens are shown in (§138 t-1073).
 * Saves `User.locale` through `PATCH /api/v1/users/me`; `null` follows the
 * org's default. The page re-renders in the new language once saved.
 *
 * The options come from the server (`localeOptions()`), each language named
 * in itself, so this component never imports the locale registry or the
 * catalogue.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
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
import { useTimeout } from '@/lib/hooks/use-timeout';
import { NO_SERVER_FIELDS, useSaveFailure } from '@/lib/hooks/use-save-failure';

/** The select's value for "no choice of my own". Radix Select has no empty value. */
const FOLLOW_ORG = '__org__';

export interface LanguageOption {
  /** The canonical locale tag. */
  tag: string;
  /** The language's name, in that language. */
  name: string;
}

export interface LanguageFormProps {
  /** The person's stored choice, `User.locale`; `null` follows their org. */
  locale: string | null;
  /** The languages they may pick, from `localeOptions()` on the server. */
  options: LanguageOption[];
}

export function LanguageForm({ locale, options }: LanguageFormProps) {
  const t = useTranslations('account.language');
  const router = useRouter();
  const schedule = useTimeout();
  const save = useSaveFailure({ fallback: t('saveFailed'), fields: NO_SERVER_FIELDS });

  // A stored tag the install no longer offers shows as following the org,
  // which is what the resolution does with it too.
  const initial = locale && options.some((o) => o.tag === locale) ? locale : FOLLOW_ORG;
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSave = async () => {
    try {
      setIsLoading(true);
      save.clear();
      setSuccess(false);

      await apiClient.patch(API.USERS.ME, {
        body: { locale: value === FOLLOW_ORG ? null : value },
      });

      setSaved(value);
      setSuccess(true);
      // Re-render the page in the language just chosen.
      router.refresh();
      schedule(() => setSuccess(false), 3000);
    } catch (err) {
      save.report(err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="locale" className="flex items-center gap-1">
          {t('label')}
          <FieldHelp title={t('helpTitle')}>
            <p>{t('help')}</p>
            <p>{t('helpOrg')}</p>
          </FieldHelp>
        </Label>
        <Select value={value} onValueChange={setValue} disabled={isLoading}>
          <SelectTrigger id="locale" className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW_ORG}>{t('useOrg')}</SelectItem>
            {options.map((option) => (
              <SelectItem key={option.tag} value={option.tag} lang={option.tag}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {success && (
        <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950/50 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4" />
          {t('success')}
        </div>
      )}

      <SaveError failure={save.failure} />

      <Button onClick={() => void handleSave()} disabled={isLoading || value === saved}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('saving')}
          </>
        ) : (
          t('save')
        )}
      </Button>
    </div>
  );
}
