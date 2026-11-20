'use client';

/**
 * LanguageSwitch — a visitor's choice of interface language (§138 t-1073).
 *
 * Rendered by the public layout for a visitor who has not signed in, and only
 * when there is more than one language to pick. A signed-in user's own choice
 * outranks the visitor cookie this sets, so for them the switch would do
 * nothing; they pick in their settings.
 *
 * The layout builds the options on the server (`localeOptions()`, each
 * language named in itself) and passes them in, which keeps the locale
 * registry and the catalogue out of the browser. Picking one stores it with
 * `PUT /api/v1/locale` and refreshes the page, so the server renders it in the
 * new language. A failed store says so beside the switch and leaves the page
 * as it was.
 */

import { useId, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Languages } from 'lucide-react';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface LanguageSwitchOption {
  /** The canonical tag, as `PUT /api/v1/locale` takes it. */
  tag: string;
  /** The language's name, in that language. */
  name: string;
}

export interface LanguageSwitchProps {
  options: readonly LanguageSwitchOption[];
  /** The locale this page rendered in. */
  current: string;
}

export function LanguageSwitch({ options, current }: LanguageSwitchProps) {
  const t = useTranslations('layout.languageSwitch');
  const router = useRouter();
  const id = useId();
  // The language picked, shown while it is stored and the page refreshes.
  const [pending, setPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // Settles when the refreshed page has rendered, whichever language it came
  // back in (a signed-in user's own choice outranks the cookie this sets).
  const [refreshing, startRefresh] = useTransition();
  const shown = pending !== null && (saving || refreshing) ? pending : current;

  if (options.length < 2) return null;

  const onChange = async (locale: string): Promise<void> => {
    if (locale === current) return;
    setPending(locale);
    setSaving(true);
    setFailed(false);
    try {
      await apiClient.put(API.PUBLIC.LOCALE, { body: { locale } });
      startRefresh(() => router.refresh());
    } catch (error) {
      logger.warn('Could not store the visitor’s language', {
        locale,
        error: error instanceof Error ? error.message : String(error),
      });
      // Back to the language the page is in: nothing changed.
      setPending(null);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-2">
        <Languages className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        <Label htmlFor={id} className="sr-only">
          {t('label')}
        </Label>
        <Select value={shown} onValueChange={(locale) => void onChange(locale)} disabled={saving}>
          <SelectTrigger
            id={id}
            className="h-8 w-auto gap-2 text-sm"
            aria-describedby={failed ? errorId : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.tag} value={option.tag} lang={option.tag}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {failed ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {t('failed')}
        </p>
      ) : null}
    </div>
  );
}
