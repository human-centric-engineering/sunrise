/**
 * Maintenance Page Component (Phase 4.4)
 *
 * Displayed when MAINTENANCE_MODE feature flag is enabled.
 * Admins can bypass this page.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Wrench, Clock, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

interface MaintenancePageProps {
  message?: string;
  estimatedDowntime?: string | null;
  isAdmin?: boolean;
}

/**
 * `message` and `estimatedDowntime` are the admin's own text from the flag's
 * metadata and render as given; everything else comes from the catalogue.
 * Synchronous, so it renders on either side (next-intl's hook works in a
 * Server Component that is not async).
 */
export function MaintenancePage({
  message,
  estimatedDowntime,
  isAdmin = false,
}: MaintenancePageProps) {
  const t = useTranslations('maintenance');
  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="pb-4">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/20">
            <Wrench className="h-8 w-8 text-amber-600 dark:text-amber-400" />
          </div>
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription className="text-base">{message ?? t('defaultMessage')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {estimatedDowntime && (
            <div className="text-muted-foreground flex items-center justify-center gap-2 text-sm">
              <Clock className="h-4 w-4" />
              <span>{t('estimatedDowntime', { downtime: estimatedDowntime })}</span>
            </div>
          )}
          {isAdmin && (
            <div className="border-t pt-4">
              <p className="text-muted-foreground mb-3 text-xs">{t('adminBypass')}</p>
              <Link
                href="/admin"
                className="text-primary inline-flex items-center gap-2 text-sm hover:underline"
              >
                {t('goToAdmin')}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
