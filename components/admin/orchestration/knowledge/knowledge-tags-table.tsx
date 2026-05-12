'use client';

/**
 * Knowledge Tags admin table — list + create + inline edit/delete.
 *
 * Keeps the surface area tight: tags are simple records (slug + name +
 * description), so the management UI doesn't need a separate detail page.
 * Edits happen inline in a small dialog; delete uses the API's
 * `force=true` second-confirmation pattern when the tag is in use.
 */

import { Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Loader2, Pencil, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { ClientDate } from '@/components/ui/client-date';
import type { PaginationMeta } from '@/types/api';
import type { KnowledgeTagListItem } from '@/types/orchestration';

type DialogState =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; tag: KnowledgeTagListItem }
  | { kind: 'delete'; tag: KnowledgeTagListItem; force: boolean };

export interface KnowledgeTagsTableProps {
  initialTags: KnowledgeTagListItem[];
  initialMeta: PaginationMeta;
}

interface TagUsage {
  documents: Array<{
    id: string;
    name: string;
    fileName: string;
    scope: string;
    status: string;
  }>;
  agents: Array<{ id: string; name: string; slug: string; isActive: boolean }>;
}

export function KnowledgeTagsTable({ initialTags }: KnowledgeTagsTableProps): React.ReactElement {
  const router = useRouter();
  const [tags, setTags] = useState<KnowledgeTagListItem[]>(initialTags);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Drill-down state: which tag is expanded, and what data we've loaded.
  // Cached by tag id so re-opening the same row doesn't refetch.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [usageByTag, setUsageByTag] = useState<Record<string, TagUsage>>({});
  const [usageLoading, setUsageLoading] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  async function toggleExpand(tag: KnowledgeTagListItem): Promise<void> {
    if (expandedId === tag.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(tag.id);
    if (usageByTag[tag.id]) return; // already cached
    setUsageLoading(tag.id);
    setUsageError(null);
    try {
      const detail = await apiClient.get<TagUsage>(
        API.ADMIN.ORCHESTRATION.knowledgeTagById(tag.id)
      );
      setUsageByTag((prev) => ({
        ...prev,
        [tag.id]: {
          documents: detail?.documents ?? [],
          agents: detail?.agents ?? [],
        },
      }));
    } catch (err) {
      setUsageError(err instanceof APIClientError ? err.message : 'Failed to load tag usage');
    } finally {
      setUsageLoading(null);
    }
  }

  async function refresh(): Promise<void> {
    try {
      // apiClient unwraps the envelope; type param is the data shape itself.
      const list = await apiClient.get<KnowledgeTagListItem[]>(
        `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?limit=100`
      );
      setTags(Array.isArray(list) ? list : []);
      router.refresh();
    } catch {
      // Non-fatal: keep the old list.
    }
  }

  // When rendered without server-seeded data (e.g. inside the Knowledge → Tags
  // tab, which doesn't pre-fetch), pull the current list on mount.
  useEffect(() => {
    if (initialTags.length === 0) {
      void refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <BulkDeleteUnusedButton tags={tags} onRefresh={() => void refresh()} />
        <Button onClick={() => setDialog({ kind: 'create' })}>New tag</Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead className="text-right">Documents</TableHead>
              <TableHead className="text-right">Agents</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tags.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground py-12 text-center text-sm">
                  No tags yet. Create one above, or run the backfill script to lift legacy
                  knowledge-category strings into tags.
                </TableCell>
              </TableRow>
            ) : (
              tags.map((tag) => {
                const expanded = expandedId === tag.id;
                const usage = usageByTag[tag.id];
                const isLoadingUsage = usageLoading === tag.id;
                return (
                  <Fragment key={tag.id}>
                    <TableRow
                      className="hover:bg-muted/40 cursor-pointer"
                      onClick={() => void toggleExpand(tag)}
                    >
                      <TableCell className="py-2">
                        {expanded ? (
                          <ChevronDown className="text-muted-foreground h-4 w-4" />
                        ) : (
                          <ChevronRight className="text-muted-foreground h-4 w-4" />
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{tag.name}</div>
                        {tag.description ? (
                          <div className="text-muted-foreground line-clamp-1 text-xs">
                            {tag.description}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-xs">
                          {tag.slug}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{tag.documentCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{tag.agentCount}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        <ClientDate date={tag.updatedAt} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDialog({ kind: 'edit', tag });
                            }}
                            aria-label={`Edit ${tag.name}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDialog({ kind: 'delete', tag, force: false });
                            }}
                            aria-label={`Delete ${tag.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    {expanded ? (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={6} className="py-3">
                          <TagUsagePanel
                            loading={isLoadingUsage}
                            error={usageError && expandedId === tag.id ? usageError : null}
                            usage={usage}
                          />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <CreateOrEditDialog
        state={dialog}
        busy={busy}
        error={error}
        onClose={() => {
          setDialog({ kind: 'closed' });
          setError(null);
        }}
        onSubmit={async (payload) => {
          setBusy(true);
          setError(null);
          try {
            if (dialog.kind === 'create') {
              await apiClient.post(API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS, { body: payload });
            } else if (dialog.kind === 'edit') {
              await apiClient.patch(API.ADMIN.ORCHESTRATION.knowledgeTagById(dialog.tag.id), {
                body: payload,
              });
            }
            setDialog({ kind: 'closed' });
            await refresh();
          } catch (err) {
            setError(err instanceof APIClientError ? err.message : 'Failed to save the tag.');
          } finally {
            setBusy(false);
          }
        }}
      />

      <DeleteDialog
        state={dialog}
        busy={busy}
        error={error}
        onClose={() => {
          setDialog({ kind: 'closed' });
          setError(null);
        }}
        onConfirm={async () => {
          if (dialog.kind !== 'delete') return;
          setBusy(true);
          setError(null);
          try {
            const url = dialog.force
              ? `${API.ADMIN.ORCHESTRATION.knowledgeTagById(dialog.tag.id)}?force=true`
              : API.ADMIN.ORCHESTRATION.knowledgeTagById(dialog.tag.id);
            await apiClient.delete(url);
            setDialog({ kind: 'closed' });
            await refresh();
          } catch (err) {
            if (err instanceof APIClientError && err.status === 409 && !dialog.force) {
              setError(err.message);
              setDialog({ ...dialog, force: true });
            } else {
              setError(err instanceof APIClientError ? err.message : 'Failed to delete the tag.');
            }
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

interface DialogCommonProps {
  state: DialogState;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}

function CreateOrEditDialog({
  state,
  busy,
  error,
  onClose,
  onSubmit,
}: DialogCommonProps & {
  onSubmit: (payload: { slug: string; name: string; description?: string }) => Promise<void>;
}): React.ReactElement | null {
  const open = state.kind === 'create' || state.kind === 'edit';
  const existing = state.kind === 'edit' ? state.tag : null;

  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');

  // Reset locals when the dialog opens with a different tag.
  if (state.kind === 'edit' && existing && existing.id !== slugId(slug, name)) {
    // intentionally not re-syncing — once the dialog opens, user edits drive
  }

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit tag' : 'New tag'}</DialogTitle>
          <DialogDescription>
            Slug is the stable cross-environment key. Use lowercase letters, numbers, and hyphens
            only.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tag-slug">Slug</Label>
            <Input
              id="tag-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="e.g. customer-support"
              disabled={busy}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Customer Support"
              disabled={busy}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tag-description">Description (optional)</Label>
            <Textarea
              id="tag-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What kind of documents belong under this tag?"
              disabled={busy}
            />
          </div>
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              void onSubmit({
                slug: slug.trim(),
                name: name.trim(),
                description: description.trim() || undefined,
              });
            }}
            disabled={busy || !slug.trim() || !name.trim()}
          >
            {existing ? 'Save changes' : 'Create tag'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  state,
  busy,
  error,
  onClose,
  onConfirm,
}: DialogCommonProps & { onConfirm: () => Promise<void> }): React.ReactElement | null {
  if (state.kind !== 'delete') return null;
  const { tag, force } = state;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{tag.name}&rdquo;?</DialogTitle>
          <DialogDescription>
            {force
              ? 'This tag is linked to documents and/or agents. Deleting it will detach those links — agents currently scoped to this tag will lose that grant.'
              : 'Cannot be undone. Use only if no agent depends on this tag.'}
          </DialogDescription>
        </DialogHeader>
        {error ? <p className="text-destructive text-sm">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              void onConfirm();
            }}
            disabled={busy}
          >
            {force ? 'Delete anyway' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function slugId(_slug: string, _name: string): string {
  // No-op helper kept for the strict-equality guard above (lint friendly).
  return '';
}

function BulkDeleteUnusedButton({
  tags,
  onRefresh,
}: {
  tags: KnowledgeTagListItem[];
  onRefresh: () => void;
}): React.ReactElement | null {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const unused = tags.filter((t) => t.documentCount === 0 && t.agentCount === 0);
  if (unused.length === 0) {
    return (
      <span className="text-muted-foreground text-xs">
        All tags are in use — nothing to bulk-clean.
      </span>
    );
  }

  async function run(): Promise<void> {
    setBusy(true);
    setErr(null);
    // Serial DELETEs — the route doesn't accept a bulk operation. For ~10s
    // of tags this is fine; if this grows we'd want a `?bulk=` POST.
    try {
      for (const t of unused) {
        await apiClient.delete(API.ADMIN.ORCHESTRATION.knowledgeTagById(t.id));
      }
      setConfirming(false);
      onRefresh();
    } catch (e) {
      setErr(e instanceof APIClientError ? e.message : 'Bulk delete failed');
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
        Delete {unused.length} unused tag{unused.length === 1 ? '' : 's'}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs">
        Delete {unused.length} unused tag{unused.length === 1 ? '' : 's'}?
      </span>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          void run();
        }}
        disabled={busy}
      >
        {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
        Confirm
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
        Cancel
      </Button>
      {err ? <span className="text-destructive text-xs">{err}</span> : null}
    </div>
  );
}

function TagUsagePanel({
  loading,
  error,
  usage,
}: {
  loading: boolean;
  error: string | null;
  usage: TagUsage | undefined;
}): React.ReactElement {
  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading usage…
      </div>
    );
  }
  if (error) {
    return <p className="text-destructive text-xs">{error}</p>;
  }
  if (!usage) return <p className="text-muted-foreground text-xs">No data.</p>;

  const docCount = usage.documents.length;
  const agentCount = usage.agents.length;

  if (docCount === 0 && agentCount === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        Nothing references this tag yet. Apply it to a document (via the document table) or grant it
        to an agent (via the agent form&apos;s Knowledge access section) to put it to work.
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid gap-1">
        <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Documents ({docCount})
        </div>
        {docCount === 0 ? (
          <p className="text-muted-foreground text-xs">No documents tagged.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {usage.documents.map((doc) => (
              <li key={doc.id} className="flex items-center gap-2">
                <Badge variant="outline" className="px-1 text-[10px]">
                  {doc.scope}
                </Badge>
                <span className="truncate">{doc.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid gap-1">
        <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Agents granted this tag ({agentCount})
        </div>
        {agentCount === 0 ? (
          <p className="text-muted-foreground text-xs">
            No agent currently scopes its knowledge access to this tag.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {usage.agents.map((agent) => (
              <li key={agent.id} className="flex items-center gap-2">
                {agent.isActive ? null : (
                  <Badge variant="outline" className="px-1 text-[10px]">
                    inactive
                  </Badge>
                )}
                <Link
                  href={`/admin/orchestration/agents/${agent.id}`}
                  className="truncate hover:underline"
                >
                  {agent.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
