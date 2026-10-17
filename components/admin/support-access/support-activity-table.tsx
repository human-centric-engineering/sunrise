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

import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
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

/** A grant, as a person picking one would recognise it: when, and why. */
function grantLabel(grant: SupportGrantRow | undefined): string {
  if (!grant) return 'An earlier grant';
  const when = new Date(grant.createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const reason = grant.reason.length > 40 ? `${grant.reason.slice(0, 40)}…` : grant.reason;
  return `${when}: ${reason}`;
}

/** The audit action, with entering named in words: it is the row an org looks for first. */
function actionLabel(action: string): string {
  return action === 'support.enter' ? 'Entered the organisation' : action;
}

function actorName(actor: SupportActivityRow['actor']): string {
  if (!actor) return 'Deleted account';
  return actor.name || 'Unnamed';
}

export function SupportActivityTable({ orgId, grants }: SupportActivityTableProps) {
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
        fail('What support did could not be loaded. Please try again.');
        return;
      }
      const body = await parseApiResponse<SupportActivityRow[]>(res);
      if (!isCurrent()) return;
      const meta = body.success ? parsePaginationMeta(body.meta) : null;
      if (!body.success || !Array.isArray(body.data) || !meta) {
        fail('What support did could not be loaded. Please try again.');
        return;
      }
      setEntries(body.data);
      setTotal(meta.total);
    } catch (err) {
      if (!isCurrent()) return;
      logger.error('support activity fetch failed', err);
      fail('What support did could not be loaded. Please try again.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [orgId, grantId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <section className="space-y-3" aria-labelledby="support-activity-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="support-activity-heading" className="text-lg font-semibold">
            What support did
          </h2>
          <p className="text-muted-foreground text-sm">
            When support entered this organisation and what they did while in it, newest first.
          </p>
        </div>
        <Select
          value={grantId}
          onValueChange={(value) => {
            setGrantId(value);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[280px]" aria-label="Grant">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All grants</SelectItem>
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
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Grant</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                  {loading
                    ? 'Loading…'
                    : error
                      ? 'Nothing to show.'
                      : 'Support has not worked in this organisation.'}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <ClientDate date={entry.createdAt} showTime />
                  </TableCell>
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
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label="Next page"
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
