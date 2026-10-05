'use client';

/**
 * MCP Resources List Component
 *
 * Table of resource endpoints with enable/disable toggles and inline creation.
 */

import { useState } from 'react';
import { Database, BookOpen, Bot, GitBranch, Puzzle } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSharedSettingsReadOnly } from '@/components/admin/shared-settings-access';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Tip } from '@/components/ui/tooltip';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { resourceRowSchema, type ResourceRow } from '@/lib/validations/mcp';

const EMPTY_RESOURCE_FORM = {
  name: '',
  uri: '',
  description: '',
  mimeType: 'application/json',
  resourceType: '',
  isEnabled: false,
};

interface EditResourceForm {
  name: string;
  description: string;
  mimeType: string;
  handlerConfig: string; // raw JSON text — parsed on save
}

const EMPTY_EDIT_FORM: EditResourceForm = {
  name: '',
  description: '',
  mimeType: 'application/json',
  handlerConfig: '',
};

interface McpResourcesListProps {
  initialResources: ResourceRow[];
}

const RESOURCE_TYPES = [
  {
    value: 'knowledge_search',
    label: 'Knowledge Search',
    icon: BookOpen,
    description: 'Search your knowledge base documents and return relevant chunks',
    exampleUri: 'sunrise://knowledge/search',
  },
  {
    value: 'agent_list',
    label: 'Agent List',
    icon: Bot,
    description: 'List configured AI agents and their capabilities',
    exampleUri: 'sunrise://agents',
  },
  {
    value: 'workflow_list',
    label: 'Workflow List',
    icon: GitBranch,
    description: 'List available workflows and their step configurations',
    exampleUri: 'sunrise://workflows',
  },
  {
    value: 'pattern_detail',
    label: 'Pattern Detail',
    icon: Puzzle,
    description: 'Retrieve details about a specific orchestration pattern',
    exampleUri: 'sunrise://patterns/{id}',
  },
] as const;

export function McpResourcesList({ initialResources }: McpResourcesListProps) {
  const readOnly = useSharedSettingsReadOnly();
  const [resources, setResources] = useState(initialResources);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_RESOURCE_FORM);
  const [error, setError] = useState<string | null>(null);

  // Edit dialog state. `editingResource` doubles as the open/closed indicator.
  const [editingResource, setEditingResource] = useState<ResourceRow | null>(null);
  const [editForm, setEditForm] = useState<EditResourceForm>(EMPTY_EDIT_FORM);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function openEdit(resource: ResourceRow): void {
    setEditingResource(resource);
    setEditError(null);
    setEditForm({
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
      // handlerConfig isn't on the row schema; admins fetch the full record
      // server-side. For v1 the field is a free-form JSON textarea that we
      // start blank so admins don't accidentally clear an existing config —
      // see explanation rendered next to the field in the dialog.
      handlerConfig: '',
    });
  }

  async function handleEditSave(): Promise<void> {
    if (!editingResource) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {};
      const name = editForm.name.trim();
      const description = editForm.description.trim();
      const mimeType = editForm.mimeType.trim();
      const handlerConfigRaw = editForm.handlerConfig.trim();

      if (name && name !== editingResource.name) body.name = name;
      if (description && description !== editingResource.description)
        body.description = description;
      if (mimeType && mimeType !== editingResource.mimeType) body.mimeType = mimeType;

      if (handlerConfigRaw) {
        try {
          body.handlerConfig = JSON.parse(handlerConfigRaw);
        } catch {
          setEditError('handlerConfig must be valid JSON (or leave blank to keep unchanged).');
          setEditSaving(false);
          return;
        }
      }

      if (Object.keys(body).length === 0) {
        // Nothing to save — close cleanly.
        setEditingResource(null);
        setEditSaving(false);
        return;
      }

      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpResourceById(editingResource.id), {
        body,
      });
      setResources((prev) =>
        prev.map((r) =>
          r.id === editingResource.id
            ? {
                ...r,
                ...(body.name !== undefined ? { name: body.name as string } : {}),
                ...(body.description !== undefined
                  ? { description: body.description as string }
                  : {}),
                ...(body.mimeType !== undefined ? { mimeType: body.mimeType as string } : {}),
              }
            : r
        )
      );
      setEditingResource(null);
    } catch {
      setEditError('Failed to update resource.');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleToggle(resourceId: string, isEnabled: boolean) {
    setError(null);
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpResourceById(resourceId), {
        body: { isEnabled },
      });
      setResources((prev) => prev.map((r) => (r.id === resourceId ? { ...r, isEnabled } : r)));
    } catch {
      setError('Failed to toggle resource.');
    }
  }

  async function handleCreate() {
    if (!form.name.trim() || !form.uri.trim() || !form.resourceType) return;
    setCreating(true);
    setError(null);
    try {
      const raw = await apiClient.post<unknown>(API.ADMIN.ORCHESTRATION.MCP_RESOURCES, {
        body: form,
      });
      const data = resourceRowSchema.parse(raw);
      setResources((prev) => [...prev, data]);
      setForm(EMPTY_RESOURCE_FORM);
      setCreateOpen(false);
    } catch {
      setError('Failed to create resource.');
    } finally {
      setCreating(false);
    }
  }

  async function handleRemove(resourceId: string) {
    setError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.mcpResourceById(resourceId));
      setResources((prev) => prev.filter((r) => r.id !== resourceId));
    } catch {
      setError('Failed to remove resource.');
    }
  }

  function selectResourceType(type: string) {
    const preset = RESOURCE_TYPES.find((t) => t.value === type);
    setForm((f) => ({
      ...f,
      resourceType: type,
      uri: f.uri || (preset?.exampleUri ?? ''),
    }));
  }

  const isEmpty = resources.length === 0;

  return (
    <div className="space-y-4">
      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* Edit Resource Dialog */}
      <Dialog
        open={editingResource !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingResource(null);
            setEditError(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Resource: {editingResource?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted/50 rounded-md p-2 text-xs">
              <p className="text-muted-foreground">
                <strong className="text-foreground">URI</strong> (
                <code>{editingResource?.uri}</code>) and{' '}
                <strong className="text-foreground">type</strong> (
                <code>{editingResource?.resourceType}</code>) cannot be changed after creation —
                they shape how the registry routes reads, and changing them mid-life would orphan
                in-flight clients. To rename or re-type, remove this resource and create a new one.
              </p>
            </div>
            <div>
              <Label htmlFor="edit-res-name">Name</Label>
              <Input
                id="edit-res-name"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="edit-res-desc">Description</Label>
              <Textarea
                id="edit-res-desc"
                rows={3}
                value={editForm.description}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="edit-res-mime">
                MIME Type
                <FieldHelp title="MIME Type">
                  IANA media type returned to MCP clients (e.g. <code>application/json</code>,{' '}
                  <code>text/markdown</code>, <code>text/plain</code>). Clients use this to decide
                  how to parse the resource body — get it wrong and the resource may render as raw
                  text or fail to parse.
                </FieldHelp>
              </Label>
              <Input
                id="edit-res-mime"
                value={editForm.mimeType}
                onChange={(e) => setEditForm((f) => ({ ...f, mimeType: e.target.value }))}
              />
            </div>
            <div>
              <Label htmlFor="edit-res-config">
                Handler Config (JSON)
                <FieldHelp title="Handler Config">
                  Optional JSON passed to the resource handler at read time. Leave blank to keep the
                  existing config unchanged. Submit <code>null</code> to clear it.
                </FieldHelp>
              </Label>
              <Textarea
                id="edit-res-config"
                rows={4}
                placeholder='e.g. {"limit": 10}'
                value={editForm.handlerConfig}
                onChange={(e) => setEditForm((f) => ({ ...f, handlerConfig: e.target.value }))}
              />
            </div>
            {editError && <p className="text-destructive text-sm">{editError}</p>}
          </div>
          <DialogFooter>
            <Button
              onClick={() => void handleEditSave()}
              disabled={editSaving}
              data-testid="edit-resource-save"
            >
              {editSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Resource Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setForm(EMPTY_RESOURCE_FORM);
        }}
      >
        {!readOnly && (
          <DialogTrigger asChild>
            <Button size="sm" data-testid="create-resource-trigger">
              Create Resource
            </Button>
          </DialogTrigger>
        )}
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create MCP Resource</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="res-type">
                Resource Type
                <FieldHelp title="Resource Type">
                  The type determines what data this resource serves. Each type maps to a built-in
                  handler that fetches data from your orchestration system.
                </FieldHelp>
              </Label>
              <Select value={form.resourceType} onValueChange={selectResourceType}>
                <SelectTrigger id="res-type">
                  <SelectValue placeholder="Choose what data to expose..." />
                </SelectTrigger>
                <SelectContent>
                  {RESOURCE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      <span className="flex items-center gap-2">
                        <t.icon className="h-3.5 w-3.5" />
                        {t.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.resourceType && (
                <p className="text-muted-foreground mt-1 text-xs" data-testid="resource-type-hint">
                  {RESOURCE_TYPES.find((t) => t.value === form.resourceType)?.description}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="res-name">Name</Label>
              <Input
                id="res-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Knowledge Base Search"
              />
            </div>
            <div>
              <Label htmlFor="res-uri">
                URI
                <FieldHelp title="Resource URI">
                  The URI that MCP clients use to access this resource. Must use the scheme
                  registered for the chosen type — <code className="text-xs">sunrise://</code> for
                  the built-in types (e.g.{' '}
                  <code className="text-xs">sunrise://knowledge/search</code>), or whatever scheme
                  this app registered in <code className="text-xs">lib/app/mcp-resources.ts</code>.
                </FieldHelp>
              </Label>
              <Input
                id="res-uri"
                value={form.uri}
                onChange={(e) => setForm((f) => ({ ...f, uri: e.target.value }))}
                placeholder="sunrise://..."
              />
            </div>
            <div>
              <Label htmlFor="res-desc">Description</Label>
              <Textarea
                id="res-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What data does this resource provide to MCP clients?"
                rows={2}
              />
            </div>
            <div>
              <Label htmlFor="res-mime">MIME Type</Label>
              <Input
                id="res-mime"
                value={form.mimeType}
                onChange={(e) => setForm((f) => ({ ...f, mimeType: e.target.value }))}
                placeholder="application/json"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => void handleCreate()}
              disabled={!form.name.trim() || !form.uri.trim() || !form.resourceType || creating}
            >
              {creating ? 'Creating...' : 'Create Resource'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Empty State */}
      {isEmpty && (
        <Card>
          <CardContent className="py-8">
            <div className="mx-auto max-w-md text-center">
              <Database className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
              <h3 className="text-foreground mb-2 text-base font-medium">
                No resources exposed yet
              </h3>
              <p className="text-muted-foreground mb-4 text-sm">
                Resources are <strong className="text-foreground">read-only data endpoints</strong>{' '}
                that MCP clients can browse. Unlike tools (which execute actions), resources just
                return data — like your knowledge base articles, agent configurations, or workflow
                definitions.
              </p>
              <p className="text-muted-foreground mb-5 text-sm">
                When a client like Claude Desktop connects to your MCP server, it can discover and
                read any enabled resources to get context before making tool calls.
              </p>
              <div className="mb-5 grid gap-2 text-left sm:grid-cols-2">
                {RESOURCE_TYPES.map((t) => (
                  <div
                    key={t.value}
                    className="bg-muted/50 flex items-start gap-2 rounded-md p-2.5"
                  >
                    <t.icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="text-foreground text-xs font-medium">{t.label}</p>
                      <p className="text-muted-foreground text-xs">{t.description}</p>
                    </div>
                  </div>
                ))}
              </div>
              {!readOnly && (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Create Your First Resource
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      {!isEmpty && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <Tip label="Display name shown to MCP clients when browsing resources">
                    <span>Name</span>
                  </Tip>
                </TableHead>
                <TableHead>
                  <Tip label="The sunrise:// address clients use to read this resource">
                    <span>URI</span>
                  </Tip>
                </TableHead>
                <TableHead>
                  <Tip label="What kind of data this resource serves (e.g. knowledge search, agent list)">
                    <span>Type</span>
                  </Tip>
                </TableHead>
                <TableHead>
                  <Tip label="Content type returned to clients (usually application/json)">
                    <span>MIME Type</span>
                  </Tip>
                </TableHead>
                <TableHead>
                  <Tip label="Toggle whether MCP clients can discover and read this resource">
                    <span>Enabled</span>
                  </Tip>
                </TableHead>
                {!readOnly && <TableHead className="w-[80px]" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {resources.map((resource) => (
                <TableRow key={resource.id}>
                  <TableCell>
                    <div>
                      <span className="font-medium">{resource.name}</span>
                      <p className="text-muted-foreground text-xs">{resource.description}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{resource.uri}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{resource.resourceType}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {resource.mimeType}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={resource.isEnabled}
                      onCheckedChange={(checked) => void handleToggle(resource.id, checked)}
                      disabled={readOnly}
                      aria-label={`Enable ${resource.name}`}
                    />
                  </TableCell>
                  {!readOnly && (
                    <TableCell className="space-x-1 whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                        onClick={() => openEdit(resource)}
                        data-testid={`edit-resource-${resource.id}`}
                      >
                        Edit
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="text-destructive text-xs">
                            Remove
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove resource?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will remove the resource from MCP. Connected clients will no
                              longer be able to read it.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => void handleRemove(resource.id)}
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
