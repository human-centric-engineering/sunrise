/**
 * What each org role may do, for the Members page's role fields (§111 t-813).
 *
 * Describes the rules `lib/tenancy/lifecycle.ts` enforces; it enforces none
 * of them. The page sends the change and shows the API's answer.
 *
 * The words come from the catalogue (§138 t-1074): the Members page is an
 * org admin's, so it reads in their language.
 */

import { useTranslations } from 'next-intl';

import { FieldHelp } from '@/components/ui/field-help';

const strong = (chunks: React.ReactNode) => <strong>{chunks}</strong>;

export function OrgRoleHelp() {
  const t = useTranslations('admin.members.roleHelp');
  return (
    <FieldHelp title={t('title')}>
      <ul className="list-disc space-y-1 pl-4">
        <li>{t.rich('member', { strong })}</li>
        <li>{t.rich('admin', { strong })}</li>
        <li>{t.rich('owner', { strong })}</li>
      </ul>
      <p className="mt-2">{t('rules')}</p>
    </FieldHelp>
  );
}
