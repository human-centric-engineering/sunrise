/**
 * Admin Waitlist — CSV export (§125 t-976)
 *
 * GET /api/v1/admin/waitlist/export — the org's entries as CSV, with the
 * list page's filters (`list`, `q`, `includeUnconfirmed`, `includeRemoved`,
 * `includeJoined`, `flaggedOnly`). By default only confirmed entries still on
 * the list.
 *
 * A complete copy of a list of strangers leaving the building is a different
 * act from paging it (spec, *Rules carried over*), so: a route of its own, its
 * own limiter key (`export:waitlist:user:<id>`), a UTF-8 BOM so a spreadsheet
 * reads the names right, `Cache-Control: no-store`, a row cap that the
 * filename states when it bites (and the page states beside the button), and
 * logs that carry counts only.
 *
 * Every cell goes through `csvEscape()`, which neutralises a leading `=`, `+`,
 * `-` or `@`: strangers typed these values.
 *
 * Authentication: org admin (org-tier). 404 while the app has no waitlist.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { csvEscape } from '@/lib/api/csv';
import { getRouteLogger } from '@/lib/api/context';
import { validateQueryParams } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { createRateLimitResponse, exportLimiter } from '@/lib/security/rate-limit';
import { isRecord } from '@/lib/utils';
import { WAITLIST_EXPORT_MAX_ROWS, waitlistAdminFilterSchema } from '@/lib/validations/waitlist';
import {
  WAITLIST_ENTRY_SELECT,
  waitlistEntryWhere,
  type AdminWaitlistEntry,
} from '@/lib/waitlist/admin';
import { requireWaitlistConfig, WAITLIST_ADMIN_OWNERSHIP } from '@/lib/waitlist/admin-route';

const BOM = '\uFEFF';

const BASE_COLUMNS: Array<[header: string, cell: (e: AdminWaitlistEntry) => string]> = [
  ['id', (e) => e.id],
  ['email', (e) => e.email],
  ['name', (e) => e.name ?? ''],
  ['list', (e) => e.list],
  ['joined_list_at', (e) => e.createdAt.toISOString()],
  ['confirmed_at', (e) => e.confirmedAt?.toISOString() ?? ''],
  ['consented_at', (e) => e.consentedAt.toISOString()],
  ['consent_version', (e) => e.consentVersion],
  ['source', (e) => e.source],
  ['utm_source', (e) => e.utmSource ?? ''],
  ['utm_medium', (e) => e.utmMedium ?? ''],
  ['utm_campaign', (e) => e.utmCampaign ?? ''],
  ['referrer_host', (e) => e.referrerHost ?? ''],
  ['locale', (e) => e.locale ?? ''],
  ['flagged_reason', (e) => e.flaggedReason ?? ''],
  ['removed_at', (e) => e.removedAt?.toISOString() ?? ''],
  ['resubmitted', (e) => String(e.rejoinRequests)],
  ['invited_at', (e) => e.invitedAt?.toISOString() ?? ''],
  ['signed_up_at', (e) => e.joinedAt?.toISOString() ?? ''],
];

export const GET = withAdminAuth(
  async (request, session) => {
    const config = requireWaitlistConfig();
    const rl = exportLimiter.check(`export:waitlist:user:${session.user.id}`);
    if (!rl.success) return createRateLimitResponse(rl);

    const filter = validateQueryParams(request.nextUrl.searchParams, waitlistAdminFilterSchema);
    const log = await getRouteLogger(request);
    const where = waitlistEntryWhere(config, filter);

    const [entries, total] = await Promise.all([
      prisma.waitlistEntry.findMany({
        where,
        select: WAITLIST_ENTRY_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: WAITLIST_EXPORT_MAX_ROWS,
      }),
      prisma.waitlistEntry.count({ where }),
    ]);

    // Each declared answer is a column, headed by its key (stable across a
    // relabel); an answer the config no longer declares is not exported.
    const header = [...BASE_COLUMNS.map(([h]) => h), ...config.fields.map((f) => f.key)];
    const lines = [header.map(csvEscape).join(',')];
    for (const entry of entries) {
      const details = isRecord(entry.details) ? entry.details : {};
      const answers = config.fields.map((f) => {
        const value = details[f.key];
        return typeof value === 'string' ? value : '';
      });
      lines.push(
        [...BASE_COLUMNS.map(([, cell]) => cell(entry)), ...answers].map(csvEscape).join(',')
      );
    }

    const capped = total > entries.length;
    const date = new Date().toISOString().slice(0, 10);
    const scope = filter.list ?? 'all';
    const filename = capped
      ? `waitlist-${scope}-${date}-first-${entries.length}-of-${total}.csv`
      : `waitlist-${scope}-${date}.csv`;

    // Counts only: this is a list of strangers.
    log.info('Waitlist export', { list: scope, rows: entries.length, total, capped });

    return new Response(BOM + lines.join('\r\n') + '\r\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Waitlist-Export-Rows': String(entries.length),
        'X-Waitlist-Export-Total': String(total),
      },
    });
  },
  { tier: 'org', ownership: WAITLIST_ADMIN_OWNERSHIP }
);
