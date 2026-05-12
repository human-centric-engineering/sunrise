'use client';

/**
 * Knowledge Tags admin table — list + create + inline edit/delete.
 *
 * Keeps the surface area tight: tags are simple records (slug + name +
 * description), so the management UI doesn't need a separate detail page.
 * Edits happen inline in a small dialog; delete uses the API's
 * `force=true` second-confirmation pattern when the tag is in use.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2 } from 'lucide-react';

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

export function KnowledgeTagsTable({ initialTags }: KnowledgeTagsTableProps): React.ReactElement {
  const router = useRouter();
  const [tags, setTags] = useState<KnowledgeTagListItem[]>(initialTags);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const res = await apiClient.get<{ data: KnowledgeTagListItem[] }>(
        `${API.ADMIN.ORCHESTRATION.KNOWLEDGE_TAGS}?limit=200`
      );
      setTags(res.data);
      router.refresh();
    } catch {
      // Non-fatal: keep the old list.
    }
  }

  return (
    <>
      <div className="flex justify-end">
        <Button onClick={() => setDialog({ kind: 'create' })}>New tag</Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
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
                <TableCell colSpan={6} className="text-muted-foreground py-12 text-center text-sm">
                  No tags yet. Create one above, or run the backfill script to lift legacy
                  knowledge-category strings into tags.
                </TableCell>
              </TableRow>
            ) : (
              tags.map((tag) => (
                <TableRow key={tag.id}>
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
                        onClick={() => setDialog({ kind: 'edit', tag })}
                        aria-label={`Edit ${tag.name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDialog({ kind: 'delete', tag, force: false })}
                        aria-label={`Delete ${tag.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
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
