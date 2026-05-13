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
import { createKnowledgeTagSchema } from '@/lib/validations/orchestration';
import type { PaginationMeta } from '@/types/api';
import type { KnowledgeTagListItem } from '@/types/orchestration';

/**
 * Mirror of the slug regex from `createKnowledgeTagSchema`. Used to derive a
 * suggested slug from the operator's tag name while the slug field is still
 * pristine — same shape the server will accept, so the auto-derived value
 * never needs an editing round-trip.
 */
function slugifyTagName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

interface FieldErrors {
  slug?: string;
  name?: string;
  description?: string;
}

/**
 * Map a `ValidationError` response's `details` (the zod issue map from
 * `handleAPIError`) onto our flat field-error shape. Server returns each
 * field as `{ path: [string[]] }` where the value is a list of messages —
 * we surface the first one.
 */
function detailsToFieldErrors(details: unknown): FieldErrors {
  const out: FieldErrors = {};
  if (!details || typeof details !== 'object') return out;
  const rec = details as Record<string, unknown>;
  for (const key of ['slug', 'name', 'description'] as const) {
    const v = rec[key];
    if (Array.isArray(v) && typeof v[0] === 'string') out[key] = v[0];
  }
  return out;
}

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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

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
        // Re-mount when transitioning between tags (or between create/edit/closed)
        // so the inner `useState` initialisers re-evaluate against the new
        // `existing` tag and pre-populate the form. Without this key, React
        // keeps the mounted instance and the initialisers run only on first
        // mount — when the dialog was still in its `closed` state and
        // `existing` was null — so editing an existing tag opens to blanks.
        key={dialog.kind === 'edit' ? `edit-${dialog.tag.id}` : dialog.kind}
        state={dialog}
        busy={busy}
        error={error}
        fieldErrors={fieldErrors}
        onClearFieldError={(key) => setFieldErrors((prev) => ({ ...prev, [key]: undefined }))}
        onClose={() => {
          setDialog({ kind: 'closed' });
          setError(null);
          setFieldErrors({});
        }}
        onSubmit={async (payload) => {
          setBusy(true);
          setError(null);
          setFieldErrors({});
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
            // Server-side validation errors arrive with per-field `details`
            // (the zod issue map from `handleAPIError`). Surface those under
            // the matching inputs; fall back to a top-level message for
            // anything that isn't a field-shaped error (e.g. unique-conflict
            // on slug, network errors).
            if (err instanceof APIClientError) {
              const fields = detailsToFieldErrors(err.details);
              if (Object.keys(fields).length > 0) {
                setFieldErrors(fields);
                // Suppress the generic top-level "Validation failed" since
                // the field-level messages tell the operator exactly what
                // to fix.
                setError(null);
              } else {
                setError(err.message);
              }
            } else {
              setError('Failed to save the tag.');
            }
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
  fieldErrors,
  onClearFieldError,
  onClose,
  onSubmit,
}: DialogCommonProps & {
  fieldErrors: FieldErrors;
  /** Clear a single field error — fires on edit so the operator gets immediate feedback. */
  onClearFieldError: (key: keyof FieldErrors) => void;
  onSubmit: (payload: { slug: string; name: string; description?: string }) => Promise<void>;
}): React.ReactElement | null {
  const open = state.kind === 'create' || state.kind === 'edit';
  const existing = state.kind === 'edit' ? state.tag : null;

  // Initialisers run on mount; the parent remounts this component via a
  // tag-scoped `key` whenever the dialog transitions to a different tag,
  // so `existing` here is always the tag being edited (or null for create).
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  // When the operator hasn't typed in the slug field yet, auto-derive it from
  // the name. Once they edit slug manually, we stop overwriting it so a hand-
  // crafted slug isn't clobbered by further name keystrokes. Editing an
  // existing tag starts "dirty" so we never overwrite the persisted slug.
  const [slugDirty, setSlugDirty] = useState(existing !== null);
  const [localErrors, setLocalErrors] = useState<FieldErrors>({});

  if (!open) return null;

  const errs: FieldErrors = { ...fieldErrors, ...localErrors };

  function handleSubmit(): void {
    const payload = {
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
    };
    // Client-side validation against the same schema the server uses, so
    // operators see field-level feedback before the network round-trip.
    const parsed = createKnowledgeTagSchema.safeParse(payload);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (key === 'slug' || key === 'name' || key === 'description') {
          if (!next[key]) next[key] = issue.message;
        }
      }
      setLocalErrors(next);
      return;
    }
    setLocalErrors({});
    void onSubmit(payload);
  }

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
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => {
                const next = e.target.value;
                setName(next);
                onClearFieldError('name');
                setLocalErrors((p) => ({ ...p, name: undefined }));
                if (!slugDirty) {
                  setSlug(slugifyTagName(next));
                  onClearFieldError('slug');
                  setLocalErrors((p) => ({ ...p, slug: undefined }));
                }
              }}
              placeholder="e.g. Customer Support"
              disabled={busy}
              aria-invalid={errs.name ? true : undefined}
              aria-describedby={errs.name ? 'tag-name-error' : undefined}
            />
            {errs.name ? (
              <p id="tag-name-error" className="text-destructive text-xs">
                {errs.name}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Human-readable label shown wherever this tag appears.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tag-slug">Slug</Label>
            <Input
              id="tag-slug"
              value={slug}
              onChange={(e) => {
                setSlugDirty(true);
                setSlug(e.target.value);
                onClearFieldError('slug');
                setLocalErrors((p) => ({ ...p, slug: undefined }));
              }}
              placeholder="e.g. customer-support"
              disabled={busy}
              aria-invalid={errs.slug ? true : undefined}
              aria-describedby={errs.slug ? 'tag-slug-error' : 'tag-slug-help'}
            />
            {errs.slug ? (
              <p id="tag-slug-error" className="text-destructive text-xs">
                {errs.slug}
              </p>
            ) : (
              <p id="tag-slug-help" className="text-muted-foreground text-xs">
                Lowercase letters, numbers, and hyphens only. Auto-derived from the name until you
                edit it.
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tag-description">Description (optional)</Label>
            <Textarea
              id="tag-description"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                onClearFieldError('description');
                setLocalErrors((p) => ({ ...p, description: undefined }));
              }}
              rows={3}
              placeholder="What kind of documents belong under this tag?"
              disabled={busy}
              aria-invalid={errs.description ? true : undefined}
              aria-describedby={errs.description ? 'tag-description-error' : undefined}
            />
            {errs.description ? (
              <p id="tag-description-error" className="text-destructive text-xs">
                {errs.description}
              </p>
            ) : null}
          </div>
          {error ? <p className="text-destructive text-sm">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={busy}>
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
