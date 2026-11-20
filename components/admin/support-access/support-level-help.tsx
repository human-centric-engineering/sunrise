'use client';

/**
 * What each support-grant level lets the vendor's support staff do (§121
 * t-823), for the Support access page.
 *
 * Describes the rules; enforces none of them. Entering under a grant, and
 * refusing writes at read-only, are the guard's (§121 t-824).
 *
 * The Support access page reads its words from the catalogue (§138 t-1074),
 * `admin.supportAccess.levels`. {@link SUPPORT_GRANT_LEVEL_LABELS} is the
 * English for the staff-only screens (the support banner, Organisations),
 * which stay English (owner ruling, §138 planning).
 */

import { useTranslations } from 'next-intl';

import { FieldHelp } from '@/components/ui/field-help';
import type { SupportGrantLevel } from '@/lib/tenancy/roles';

export const SUPPORT_GRANT_LEVEL_LABELS: Record<SupportGrantLevel, string> = {
  ADMIN: 'Admin',
  READ_ONLY: 'Read-only',
};

const strong = (chunks: React.ReactNode) => <strong>{chunks}</strong>;

export function SupportLevelHelp() {
  const t = useTranslations('admin.supportAccess.levelHelp');
  return (
    <FieldHelp title={t('title')}>
      <ul className="list-disc space-y-1 pl-4">
        <li>{t.rich('admin', { strong })}</li>
        <li>{t.rich('readOnly', { strong })}</li>
      </ul>
      <p className="mt-2">{t('privacy')}</p>
    </FieldHelp>
  );
}
