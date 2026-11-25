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
  if (page.closedBy === 'policy') return t('areas.closedByPolicy');
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
  const lower = you.orgRole?.toLowerCase();
  // Own keys only: a role string such as `constructor` is not a label.
  const roleKey =
    lower !== undefined && Object.hasOwn(ORG_ROLE_LABEL_KEYS, lower)
      ? ORG_ROLE_LABEL_KEYS[lower]
      : undefined;
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
          // A holder's list is narrowed to the switches their pages need, so
          // it says nothing of the org's others.
          <p>
            {explainer.audience === 'holder' ? t('you.noNeededSwitchesOn') : t('you.noSwitchesOn')}
          </p>
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

function RoleTable({
  rows,
  t,
}: {
  rows: ReadonlyArray<{ key: string; label: string; description: string; held: boolean }>;
  t: Translate;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-48">{t('roles.colRole')}</TableHead>
          <TableHead>{t('roles.colMeans')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell className="align-top font-medium">
              <span className="flex flex-wrap items-center gap-2">
                {row.label}
                {row.held && <Badge>{t('roles.held')}</Badge>}
              </span>
            </TableCell>
            <TableCell className="text-muted-foreground whitespace-normal">
              {row.description}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The role model as reference tables: the platform roles, the organisation
 * roles and what each may do, then the app's own roles. All of it is the
 * route's (`model` and `roles`), which leaves `model` out for a named-tier
 * holder, who sees only their own tiers. At `single` the org roles carry a
 * note that they are not in force on this install.
 */
function Roles({ explainer }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const roles = explainer.roles;
  const model = explainer.model;
  if (!roles) return null;
  const appRoles = roles.filter((role) => role.kind === 'named-tier');
  const appTable = appRoles.length > 0 && (
    <Section id="named-tier-roles" title={t('roles.appTitle')} intro={t('roles.appIntro')}>
      <RoleTable rows={appRoles} t={t} />
    </Section>
  );
  if (!model) return appTable || null;

  return (
    <>
      <Section id="roles" title={t('roles.platformTitle')} intro={t('roles.platformIntro')}>
        <RoleTable rows={model.platformRoles} t={t} />
      </Section>
      <Section id="org-roles" title={t('roles.orgTitle')} intro={t('roles.orgIntro')}>
        {explainer.tenancy === 'single' && (
          <p role="note" className="text-sm">
            {t('roles.singleTenant')}
          </p>
        )}
        <RoleTable rows={model.orgRoles} t={t} />
      </Section>
      {model.permissions.length > 0 && (
        <Section id="permissions" title={t('roles.matrixTitle')} intro={t('roles.matrixIntro')}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('roles.colPermission')}</TableHead>
                {model.columns.map((column) => (
                  <TableHead key={column.key} className="text-center">
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {model.permissions.map((permission) => (
                <TableRow key={permission.key}>
                  <TableCell className="whitespace-normal">{permission.label}</TableCell>
                  {model.columns.map((column) => (
                    <TableCell key={column.key} className="text-center">
                      {permission.allowed[column.key] ? (
                        <span role="img" aria-label={t('roles.yes')}>
                          ✓
                        </span>
                      ) : (
                        <span
                          role="img"
                          aria-label={t('roles.no')}
                          className="text-muted-foreground"
                        >
                          –
                        </span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {appRoles.length > 0 && (
            <p className="text-muted-foreground text-sm">{t('roles.matrixAppRoles')}</p>
          )}
        </Section>
      )}
      {appTable}
    </>
  );
}

function Areas({ explainer }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const areas = explainer.areas;
  if (!areas) return null;
  return (
    <Section id="areas" title={t('areas.title')} intro={t('areas.intro')}>
      {/* The route sent the section, so say why it lists nothing. */}
      {areas.length === 0 && <p className="text-muted-foreground text-sm">{t('areas.empty')}</p>}
      {areas.map((area) => (
        <div key={area.key} className="space-y-2 rounded-lg border p-4">
          <h3 className="font-medium">{area.label}</h3>
          {area.description && <p className="text-muted-foreground text-sm">{area.description}</p>}
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
      ))}
    </Section>
  );
}

function Switches({ explainer }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const switches = explainer.switches;
  if (!switches || switches.length === 0) return null;
  const showHeld = switches.some((s) => s.held !== null);
  return (
    <Section id="switches" title={t('switches.title')} intro={t('switches.intro')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('switches.colSwitch')}</TableHead>
            <TableHead>{t('switches.colSetBy')}</TableHead>
            <TableHead>{t('switches.colWhenOff')}</TableHead>
            {showHeld && <TableHead>{t('switches.colHere')}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {switches.map((s) => (
            <TableRow key={s.key}>
              <TableCell className="align-top whitespace-normal">
                <span className="font-medium">{s.label}</span>
                {s.description && (
                  <span className="text-muted-foreground block text-xs">{s.description}</span>
                )}
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                {s.setBy === 'org' ? t('switches.setByOrg') : t('switches.setByPlatform')}
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                {s.whenLacking === 'lock'
                  ? t('switches.whenLackingLock')
                  : t('switches.whenLackingHide')}
              </TableCell>
              {showHeld && (
                <TableCell className="align-top whitespace-normal">
                  {s.held !== null && (
                    <Badge variant={s.held ? 'default' : 'outline'}>
                      {s.held ? t('switches.on') : t('switches.off')}
                    </Badge>
                  )}
                  {s.held === false && s.refusal && (
                    <span className="block text-xs">{s.refusal}</span>
                  )}
                  {s.held === false && s.upgradeUrl && (
                    <span className="block text-xs">
                      <GetItLink href={s.upgradeUrl}>{t('switches.getIt')}</GetItLink>
                    </span>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function PlatformOnly({ explainer }: AccessExplainerViewProps) {
  const t = useTranslations('admin.access.page');
  const items = explainer.platformOnly;
  if (!items || items.length === 0) return null;
  return (
    <Section id="platform-only" title={t('platformOnly.title')} intro={t('platformOnly.intro')}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('platformOnly.colArea')}</TableHead>
            <TableHead>{t('platformOnly.colWhy')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.key}>
              <TableCell className="align-top font-medium">
                {item.href ? (
                  <Link href={item.href} className="underline">
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
              </TableCell>
              <TableCell className="text-muted-foreground whitespace-normal">
                {item.reason}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
