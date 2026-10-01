/**
 * OrgsTable — every org, the vendor's view (§120 t-745)
 *
 * Renders `GET /api/v1/admin/orgs` as a table, each row linking to the org's
 * page. Read-only: rename, suspend and membership stay API-only for now.
 *
 * Server component: no client state, just rendering.
 */

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** One row of `GET /api/v1/admin/orgs`. */
export interface OrgListItem {
  id: string;
  slug: string;
  name: string;
  status: string;
  createdAt: string;
  memberCount: number;
  ownerCount: number;
}

export interface OrgsTableProps {
  orgs: OrgListItem[];
  installOrgId: string;
}

export function OrgsTable({ orgs, installOrgId }: OrgsTableProps) {
  if (orgs.length === 0) {
    return (
      <p className="text-muted-foreground rounded-md border p-6 text-center text-sm">
        No organisations could be loaded.
      </p>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Members</TableHead>
            <TableHead className="text-right">Owners</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orgs.map((org) => (
            <TableRow key={org.id}>
              <TableCell className="font-medium">
                <Link href={`/admin/orgs/${org.id}`} className="hover:underline">
                  {org.name}
                </Link>
                {org.id === installOrgId && (
                  <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[10px]">
                    Install org
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">{org.slug}</TableCell>
              <TableCell>
                <Badge
                  variant={org.status === 'ACTIVE' ? 'outline' : 'destructive'}
                  className="px-1.5 py-0 text-[10px]"
                >
                  {org.status.toLowerCase()}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">{org.memberCount}</TableCell>
              <TableCell className="text-right tabular-nums">
                {org.ownerCount === 0 ? (
                  <span className="text-amber-700 dark:text-amber-400">0</span>
                ) : (
                  org.ownerCount
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {new Date(org.createdAt).toLocaleDateString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
