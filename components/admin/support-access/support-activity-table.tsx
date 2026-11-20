'use client';

/**
 * What support did in this organisation, under each of its grants, newest
 * first (§121 t-825).
 *
 * Over `GET /api/v1/orgs/[id]/support-grants/activity`: one request per page
 * or grant chosen, never one per row. The grants come from the server page,
 * so each action names the grant it was taken under.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { SupportGrantRow } from '@/components/admin/support-access/support-grants-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse } from '@/lib/api/parse-response';
import { logger } from '@/lib/logging';
import { parsePaginationMeta } from '@/lib/validations/common';

/** One action as the activity endpoint returns it. */
export interface SupportActivityRow {
  id: string;
  grantId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  createdAt: string;
  actor: { id: string; name: string | null } | null;
}

export interface SupportActivityTableProps {
  orgId: string;
  grants: SupportGrantRow[];
}

const ALL = 'all';
const LIMIT = 25;

export function SupportActivityTable({ orgId, grants }: SupportActivityTableProps) {
  const t = useTranslations('admin.supportAccess.activity');
  const tShell = useTranslations('admin.shell');
  const format = useFormatter();
  const loadFailed = t('loadFailed');

  /** A grant, as a person picking one would recognise it: when, and why. */
  const grantLabel = (grant: SupportGrantRow | undefined): string => {
    if (!grant) return t('earlierGrant');
    const reason = grant.reason.length > 40 ? `${grant.reason.slice(0, 40)}…` : grant.reason;
    return t('grantLabel', { when: format.dateTime(new Date(grant.createdAt), 'short'), reason });
  };

  /** The audit action, with entering named in words: it is the row an org looks for first. */
  const actionLabel = (action: string): string =>
    action === 'support.enter' ? t('entered') : action;

  const actorName = (actor: SupportActivityRow['actor']): string => {
    if (!actor) return tShell('deletedAccount');
    return actor.name || tShell('unnamed');
  };

  const [grantId, setGrantId] = useState<string>(ALL);
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<SupportActivityRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latestRequest = useRef(0);

  const grantsById = new Map(grants.map((grant) => [grant.id, grant]));

  const load = useCallback(async () => {
    // Only the latest request may write state: an older one resolving late
    // would show one grant's actions under another's name.
    const seq = ++latestRequest.current;
    const isCurrent = () => seq === latestRequest.current;
    const fail = (message: string) => {
      setError(message);
      setEntries([]);
      setTotal(0);
    };
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      if (grantId !== ALL) params.set('grantId', grantId);
      const res = await fetch(`${API.ORGS.supportActivity(orgId)}?${params}`);
      if (!isCurrent()) return;
      if (!res.ok) {
        fail(loadFailed);
        return;
      }
      const body = await parseApiResponse<SupportActivityRow[]>(res);
      if (!isCurrent()) return;
      const meta = body.success ? parsePaginationMeta(body.meta) : null;
      if (!body.success || !Array.isArray(body.data) || !meta) {
        fail(loadFailed);
        return;
      }
      setEntries(body.data);
      setTotal(meta.total);
    } catch (err) {
      if (!isCurrent()) return;
      logger.error('support activity fetch failed', err);
      fail(loadFailed);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [orgId, grantId, page, loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <section className="space-y-3" aria-labelledby="support-activity-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="support-activity-heading" className="text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        <Select
          value={grantId}
          onValueChange={(value) => {
            setGrantId(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[280px]" aria-label={t('grant')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('allGrants')}</SelectItem>
            {grants.map((grant) => (
              <SelectItem key={grant.id} value={grant.id}>
                {grantLabel(grant)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('when')}</TableHead>
              <TableHead>{t('who')}</TableHead>
              <TableHead>{t('action')}</TableHead>
              <TableHead>{t('what')}</TableHead>
              <TableHead>{t('grant')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                  {loading ? tShell('loading') : error ? tShell('nothingToShow') : t('empty')}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{format.dateTime(new Date(entry.createdAt), 'dateTime')}</TableCell>
                  <TableCell>{actorName(entry.actor)}</TableCell>
                  <TableCell className="font-mono text-xs">{actionLabel(entry.action)}</TableCell>
                  <TableCell>
                    <span className="font-medium">{entry.entityName ?? entry.entityId ?? '—'}</span>
                    <span className="text-muted-foreground ml-2 text-xs">{entry.entityType}</span>
                  </TableCell>
                  <TableCell className="text-sm">
                    {grantLabel(grantsById.get(entry.grantId))}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label={tShell('previousPage')}
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm">{t('pageOf', { page, total: totalPages })}</span>
          <Button
            variant="outline"
            size="sm"
            aria-label={tShell('nextPage')}
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </section>
  );
}
