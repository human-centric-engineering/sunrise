/**
 * The billing page's content (§139 t-1095): the org's plan and its status,
 * the current period, what its plan includes and how much of it is used
 * (t-1097), usage against each limit, the plans it could buy, and the way to
 * the customer portal. Everything comes from one read
 * (`GET /api/v1/orgs/[id]/billing`), handed down by the page.
 *
 * Read-only unless `billing.mayChange`, which the route sets for the org's
 * OWNER acting in it: an ADMIN sees the same page with no buttons, and is
 * told only an owner can change it. The routes behind the buttons refuse
 * anyone else regardless.
 *
 * Not a client component: the buttons are, and nothing else here needs to be.
 */

import { useFormatter, useTranslations } from 'next-intl';

import { BillingActionButton } from '@/components/admin/billing/billing-action-button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { OrgBilling } from '@/lib/billing/org-billing';

type Allowance = NonNullable<OrgBilling['allowances']>[number];

/** {@link OrgBilling} as JSON carries it: dates are ISO strings. */
export type OrgBillingView = Omit<OrgBilling, 'subscription' | 'allowances'> & {
  allowances:
    (Omit<Allowance, 'window'> & { window: { from: string; to: string } | null })[] | null;
  subscription:
    | (Omit<NonNullable<OrgBilling['subscription']>, 'periodStart' | 'periodEnd'> & {
        periodStart: string | null;
        periodEnd: string | null;
      })
    | null;
};

export interface BillingSummaryProps {
  billing: OrgBillingView;
}

export function BillingSummary({ billing }: BillingSummaryProps) {
  const t = useTranslations('admin.billing');
  const format = useFormatter();
  const { subscription, plan } = billing;
  const date = (iso: string) => format.dateTime(new Date(iso), 'long');
  const statusHelp =
    subscription?.status === 'PAST_DUE'
      ? // Manage billing is the owner's, and only when the portal can open.
        !billing.mayChange
        ? t('status.pastDueHelpAdmin')
        : billing.portalAvailable
          ? t('status.pastDueHelp')
          : t('status.pastDueHelpNoPortal')
      : subscription?.status === 'INCOMPLETE'
        ? t('status.incompleteHelp')
        : subscription?.status === 'ENDED'
          ? // Ended but still chargeable or resumable (unpaid, paused).
            subscription.providerManaged
            ? t('status.endedCollectingHelp')
            : t('status.endedHelp')
          : null;

  // A live subscription changes plan in the portal: the checkout route
  // refuses a second one. One still waiting for its first payment is not
  // live there, so the owner can choose again to retry it; one held at
  // another provider has to end there first.
  const elsewhere = subscription?.elsewhere ?? false;
  const awaitingFirstPayment = subscription?.status === 'INCOMPLETE';
  const mayCheckout =
    billing.mayChange && !elsewhere && (!subscription?.providerManaged || awaitingFirstPayment);
  const plansNote = !billing.mayChange
    ? null
    : elsewhere
      ? t('plans.elsewhere')
      : subscription?.providerManaged && !awaitingFirstPayment
        ? t('plans.changeInPortal')
        : null;

  return (
    <div className="space-y-6">
      {!billing.mayChange && <p className="text-muted-foreground text-sm">{t('ownerOnly')}</p>}

      <Card>
        <CardHeader>
          <CardTitle>{t('plan.heading')}</CardTitle>
          {plan ? (
            <CardDescription>
              <span className="text-foreground text-lg font-semibold">
                {plan.label ?? t('plan.unknown', { key: plan.key })}
              </span>
              {plan.description && <span className="block">{plan.description}</span>}
            </CardDescription>
          ) : (
            <CardDescription>{t('plan.none')}</CardDescription>
          )}
        </CardHeader>
        {subscription && (
          <CardContent>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t('status.label')}</dt>
                <dd className="space-y-1">
                  <Badge variant={subscription.status === 'ACTIVE' ? 'default' : 'secondary'}>
                    {t(`status.${subscription.status}`)}
                  </Badge>
                  {statusHelp && <p className="text-muted-foreground">{statusHelp}</p>}
                  {subscription.cancelAtPeriodEnd &&
                    subscription.status !== 'ENDED' &&
                    subscription.periodEnd && (
                      <p>{t('status.endsOn', { date: date(subscription.periodEnd) })}</p>
                    )}
                  {subscription.assignedByHand && (
                    <p className="text-muted-foreground">{t('plan.assigned')}</p>
                  )}
                </dd>
              </div>
              {/* An ended subscription's last period is not the current one. */}
              {subscription.status !== 'ENDED' &&
                subscription.periodStart &&
                subscription.periodEnd && (
                  <div>
                    <dt className="text-muted-foreground">{t('period.label')}</dt>
                    <dd>
                      {t('period.range', {
                        start: date(subscription.periodStart),
                        end: date(subscription.periodEnd),
                      })}
                    </dd>
                  </div>
                )}
            </dl>
          </CardContent>
        )}
      </Card>

      {billing.allowances !== null && billing.allowances.length === 0 ? null : (
        <Card>
          <CardHeader>
            <CardTitle>{t('allowances.heading')}</CardTitle>
            <CardDescription>{t('allowances.intro')}</CardDescription>
          </CardHeader>
          <CardContent>
            {billing.allowances === null ? (
              <p role="alert" className="text-destructive text-sm">
                {t('allowances.loadFailed')}
              </p>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('allowances.item')}</TableHead>
                      <TableHead>{t('allowances.used')}</TableHead>
                      <TableHead>{t('allowances.included')}</TableHead>
                      <TableHead>{t('allowances.status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {billing.allowances.map((item) => {
                      const amount = (n: number) =>
                        item.money
                          ? format.number(n / 100, { style: 'currency', currency: 'USD' })
                          : format.number(n);
                      return (
                        <TableRow key={item.key}>
                          <TableCell>
                            <span className="font-medium">{item.label}</span>
                            <span className="text-muted-foreground block text-xs">
                              {t(`allowances.rule.${item.overage}`)}
                            </span>
                          </TableCell>
                          <TableCell>
                            {item.used === null ? t('allowances.countFailed') : amount(item.used)}
                          </TableCell>
                          <TableCell>{amount(item.allowance)}</TableCell>
                          <TableCell>
                            {item.state === null || item.state === 'within' ? (
                              <span className="text-muted-foreground text-sm">
                                {item.state === null ? '—' : t('allowances.state.within')}
                              </span>
                            ) : (
                              <Badge
                                variant={item.state === 'reached' ? 'destructive' : 'secondary'}
                              >
                                {item.overage === 'soft_cap' &&
                                item.state === 'reached' &&
                                !item.billed
                                  ? t('allowances.state.soft_cap.reachedUnbilled')
                                  : t(`allowances.state.${item.overage}.${item.state}`)}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('usage.heading')}</CardTitle>
          <CardDescription>{t('usage.intro')}</CardDescription>
        </CardHeader>
        <CardContent>
          {billing.usage === null ? (
            <p role="alert" className="text-destructive text-sm">
              {t('usage.loadFailed')}
            </p>
          ) : billing.usage.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('usage.none')}</p>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('usage.meter')}</TableHead>
                    <TableHead>{t('usage.used')}</TableHead>
                    <TableHead>{t('usage.limit')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {billing.usage.map((meter) => (
                    <TableRow key={meter.key}>
                      <TableCell>
                        <span className="font-medium">{meter.label}</span>
                        <span className="text-muted-foreground block text-xs">
                          {meter.period === 'month'
                            ? t('usage.thisMonth')
                            : meter.period === 'standing'
                              ? t('usage.standing')
                              : t('usage.custom')}
                        </span>
                      </TableCell>
                      <TableCell>
                        {meter.countFailed || meter.used === null
                          ? t('usage.countFailed')
                          : format.number(meter.used)}
                      </TableCell>
                      <TableCell>
                        {meter.limit === null ? t('usage.noLimit') : format.number(meter.limit)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('plans.heading')}</CardTitle>
          {plansNote && billing.plans.length > 0 && <CardDescription>{plansNote}</CardDescription>}
        </CardHeader>
        <CardContent>
          {billing.plans.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('plans.none')}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {billing.plans.map((option) => (
                <li key={option.key} className="space-y-2 rounded-md border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{option.label}</span>
                    {option.current && <Badge variant="outline">{t('plans.current')}</Badge>}
                  </div>
                  {option.description && (
                    <p className="text-muted-foreground text-sm">{option.description}</p>
                  )}
                  {mayCheckout && !option.current && (
                    <BillingActionButton
                      orgId={billing.orgId}
                      kind="checkout"
                      planKey={option.key}
                      label={t('plans.choose', { plan: option.label })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* The portal is the owner's: an ADMIN is told so above, with nothing to press here. */}
      {billing.mayChange && (
        <Card>
          <CardHeader>
            <CardTitle>{t('portal.heading')}</CardTitle>
            <CardDescription>{t('portal.intro')}</CardDescription>
          </CardHeader>
          <CardContent>
            {billing.portalAvailable ? (
              <BillingActionButton orgId={billing.orgId} kind="portal" label={t('portal.open')} />
            ) : (
              <p className="text-muted-foreground text-sm">
                {elsewhere || billing.customerElsewhere
                  ? t('portal.elsewhere')
                  : t('portal.notYet')}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
