/**
 * A line pointing to the access explainer (§143 t-1091): "Who can open what
 * in this console? See who can do what."
 *
 * On the dashboard each viewer lands on (the overview, the orchestration
 * dashboard, Members) and on a locked page. A fork whose named tier lands on
 * a page of its own puts it there too, so a tier holder finds it from where
 * they arrive. The page opens to every viewer the console admits
 * (`EVERY_VIEWER_ADMIN_PAGES`), so the link never leads to a redirect.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ACCESS_EXPLAINER_PAGE } from '@/lib/auth/admin-tier';
import { cn } from '@/lib/utils';

export function AccessExplainerLink({ className }: { className?: string }) {
  const t = useTranslations('admin.access.page');
  return (
    <p className={cn('text-muted-foreground text-sm', className)}>
      {t('linkText')}{' '}
      <Link href={ACCESS_EXPLAINER_PAGE} className="text-foreground underline">
        {t('linkAction')}
      </Link>
    </p>
  );
}
