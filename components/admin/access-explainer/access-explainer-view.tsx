/**
 * The access explainer, as one viewer reads it (§143 t-1091).
 *
 * Renders what `GET /api/v1/admin/access` returned for this viewer and
 * nothing else: the route decides which sections each viewer gets and narrows
 * every list to their slice, so a section missing from the response is a
 * section this viewer does not see. The sections come in the order the
 * response names them, then the app's own.
 *
 * Every word of the page's own is under `admin.access.page` in the catalogue,
 * so a fork rewords it with `overridePlatformMessages()`. Labels, descriptions
 * and reasons inside the response are already in the viewer's language, or as
 * the app registered them.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  AccessExplainerPage,
  AccessExplainerResponse,
} from '@/lib/validations/access-explainer';

export interface AccessExplainerViewProps {
  explainer: AccessExplainerResponse;
  /** The org the viewer entered, named in their panel; `null` outside one. */
  orgName: string | null;
}

type Translate = ReturnType<typeof useTranslations<'admin.access.page'>>;

/** Each org role's catalogue label, keyed by the role in lower case. */
const ORG_ROLE_LABEL_KEYS: Partial<Record<string, 'owner.label' | 'admin.label' | 'member.label'>> =
  {
    owner: 'owner.label',
    admin: 'admin.label',
    member: 'member.label',
  };

/** A link to where an org can get a switch: a path on this site or an https address. */
function GetItLink({ href, children }: { href: string; children: React.ReactNode }) {
  const external = !href.startsWith('/');
  return (
    <a
      href={href}
      className="underline"
      // As the locked page's link: the same tab, whichever kind it is.
      {...(external ? { rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

/** A page's path, linked when it has one and the viewer opens it. */
function PagePath({ page }: { page: AccessExplainerPage }) {
  const path = <code className="text-xs">{page.pattern}</code>;
  if (page.href && page.opens) {
    return (
      <Link href={page.href} className="underline">
        {path}
      </Link>
    );
  }
  return path;
}

/**
 * Why a page is closed to this viewer, in a sentence. The route says which
 * of its tier or its switch keeps them out, so the reason holds whichever
 * sections the app shows this viewer.
 */
function closedReason(page: AccessExplainerPage, t: Translate): string {
  if (page.locked) return page.locked.message;
  const label = page.requiresLabel ?? page.requires;
  if (label !== null && page.closedBy === 'switch') {
    return t('areas.needsSwitch', { switch: label });
  }
  if (label !== null && page.closedBy === 'unread') {
    return t('areas.needsSwitchUnread', { switch: label });
  }
  return t('areas.needsTier', { tier: page.tierLabel });
}

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string;
  title: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`access-${id}`} className="space-y-3">
      <div>
        <h2 id={`access-${id}`} className="text-lg font-semibold">
          {title}
        </h2>
        {intro && <p className="text-muted-foreground text-sm">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

function YourAccess({ explainer, orgName }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const tRoles = useTranslations('admin.access.roles');
  const you = explainer.you;
  if (!you) return null;
  const title = orgName ? t('you.titleIn', { org: orgName }) : t('you.title');

  if (you.tiers === 'platform') {
    return (
      <Section id="your-access" title={title}>
        <p className="text-sm">{t('you.platform')}</p>
      </Section>
    );
  }

  // From the catalogue, as the roles section words it: that section may not
  // be shown to this viewer.
  const roleKey = you.orgRole ? ORG_ROLE_LABEL_KEYS[you.orgRole.toLowerCase()] : undefined;
  const role = roleKey ? tRoles(roleKey) : you.orgRole;
  const closed = (explainer.areas ?? []).flatMap((area) =>
    area.pages.filter((page) => !page.opens)
  );

  return (
    <Section id="your-access" title={title}>
      <div className="space-y-3 rounded-lg border p-4 text-sm">
        {you.supportEntry ? (
          <p>{t('you.supportEntry')}</p>
        ) : (
          role && <p>{t('you.role', { role })}</p>
        )}
        <div>
          <p>{t('you.tiers')}</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {you.tiers.map((tier) => (
              <li key={tier}>
                <Badge variant="secondary">{you.tierLabels[tier] ?? tier}</Badge>
              </li>
            ))}
          </ul>
        </div>
        {you.switchesUnreadable ? (
          <p role="alert" className="text-destructive">
            {t('you.switchesUnreadable')}
          </p>
        ) : you.switchesOn && you.switchesOn.length > 0 ? (
          <div>
            <p>{t('you.switchesOn')}</p>
            <ul className="mt-1 flex flex-wrap gap-2">
              {you.switchesOn.map((key) => (
                <li key={key}>
                  <Badge variant="outline">{you.switchLabels[key] ?? key}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : you.anySwitches ? (
          // Only where there are switches to have: on an install that
          // registers none, "none on" would say nothing.
          <p>{t('you.noSwitchesOn')}</p>
        ) : null}
        {explainer.areas && (
          <div>
            <h3 className="font-medium">{t('you.closedTitle')}</h3>
            {closed.length === 0 ? (
              <p className="text-muted-foreground">{t('you.noneClosed')}</p>
            ) : (
              <ul className="mt-1 space-y-2">
                {closed.map((page) => (
                  <li key={page.pattern}>
                    <PagePath page={page} />
                    <span className="text-muted-foreground">
                      {' — '}
                      {closedReason(page, t)}
                    </span>
                    {page.locked?.upgradeUrl && (
                      <>
                        {' '}
                        <GetItLink href={page.locked.upgradeUrl}>{t('switches.getIt')}</GetItLink>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function Roles({ explainer }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const roles = explainer.roles;
  if (!roles) return null;
  return (
    <Section id="roles" title={t('roles.title')} intro={t('roles.intro')}>
      <ul className="divide-y rounded-lg border">
        {roles.map((role) => (
          <li key={`${role.kind}:${role.key}`} className="space-y-1 p-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">{role.label}</span>
              {role.held && <Badge>{t('roles.held')}</Badge>}
            </div>
            <p className="text-muted-foreground">{role.description}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Areas({ explainer }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const areas = explainer.areas;
  if (!areas) return null;
  return (
    <Section id="areas" title={t('areas.title')} intro={t('areas.intro')}>
      {areas.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('areas.empty')}</p>
      ) : (
        areas.map((area) => (
          <div key={area.key} className="space-y-2 rounded-lg border p-4">
            <h3 className="font-medium">{area.label}</h3>
            {area.description && (
              <p className="text-muted-foreground text-sm">{area.description}</p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('areas.page')}</TableHead>
                  <TableHead>{t('areas.openTo')}</TableHead>
                  <TableHead>{t('areas.needs')}</TableHead>
                  <TableHead>{t('areas.you')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {area.pages.map((page) => (
                  <TableRow key={page.pattern}>
                    <TableCell>
                      <PagePath page={page} />
                    </TableCell>
                    <TableCell>{page.tierLabel}</TableCell>
                    <TableCell>
                      {page.requires ? (page.requiresLabel ?? page.requires) : t('areas.noSwitch')}
                    </TableCell>
                    <TableCell>
                      {page.opens ? (
                        t('areas.opens')
                      ) : (
                        <>
                          {t('areas.closed')}
                          <span className="text-muted-foreground block text-xs">
                            {closedReason(page, t)}
                          </span>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))
      )}
    </Section>
  );
}

function Switches({ explainer }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const switches = explainer.switches;
  if (!switches) return null;
  return (
    <Section id="switches" title={t('switches.title')} intro={t('switches.intro')}>
      {switches.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('switches.empty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {switches.map((s) => (
            <li key={s.key} className="space-y-1 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.label}</span>
                {s.held !== null && (
                  <Badge variant={s.held ? 'default' : 'outline'}>
                    {s.held ? t('switches.on') : t('switches.off')}
                  </Badge>
                )}
              </div>
              {s.description && <p className="text-muted-foreground">{s.description}</p>}
              <p className="text-muted-foreground">
                {s.setBy === 'org' ? t('switches.setByOrg') : t('switches.setByPlatform')}
                {' · '}
                {s.whenLacking === 'lock'
                  ? t('switches.whenLackingLock')
                  : t('switches.whenLackingHide')}
              </p>
              {s.held === false && s.refusal && <p>{s.refusal}</p>}
              {s.held === false && s.upgradeUrl && (
                <GetItLink href={s.upgradeUrl}>{t('switches.getIt')}</GetItLink>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function PlatformOnly({ explainer }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const items = explainer.platformOnly;
  if (!items) return null;
  return (
    <Section id="platform-only" title={t('platformOnly.title')} intro={t('platformOnly.intro')}>
      {items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('platformOnly.empty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((item) => (
            <li key={item.key} className="space-y-1 p-4 text-sm">
              {item.href ? (
                <Link href={item.href} className="font-medium underline">
                  {item.label}
                </Link>
              ) : (
                <span className="font-medium">{item.label}</span>
              )}
              <p className="text-muted-foreground">{item.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const SECTION_VIEWS = {
  'your-access': YourAccess,
  roles: Roles,
  areas: Areas,
  switches: Switches,
  'platform-only': PlatformOnly,
} as const;

export function AccessExplainerView({ explainer, orgName }: AccessExplainerViewProps) {
  return (
    <div className="space-y-8">
      {explainer.sections.map((section) => {
        const View = SECTION_VIEWS[section];
        return <View key={section} explainer={explainer} orgName={orgName} />;
      })}
      {explainer.appSections.map((section) => (
        <Section key={section.key} id={`app-${section.key}`} title={section.title}>
          <p className="text-sm whitespace-pre-line">{section.body}</p>
        </Section>
      ))}
    </div>
  );
}
