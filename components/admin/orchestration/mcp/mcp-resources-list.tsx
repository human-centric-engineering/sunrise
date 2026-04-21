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
import { resourceRowSchema, type ResourceRow } from '@/lib/validations/mcp';

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
  const [resources, setResources] = useState(initialResources);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    uri: '',
    description: '',
    mimeType: 'application/json',
    resourceType: '',
    isEnabled: false,
  });

  async function handleToggle(resourceId: string, isEnabled: boolean) {
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpResourceById(resourceId), {
        body: { isEnabled },
      });
      setResources((prev) => prev.map((r) => (r.id === resourceId ? { ...r, isEnabled } : r)));
    } catch {
      // silent
    }
  }

  async function handleCreate() {
    if (!form.name.trim() || !form.uri.trim() || !form.resourceType) return;
    setCreating(true);
    try {
      const raw = await apiClient.post<unknown>(API.ADMIN.ORCHESTRATION.MCP_RESOURCES, {
        body: form,
      });
      const data = resourceRowSchema.parse(raw);
      setResources((prev) => [...prev, data]);
      setForm({
        name: '',
        uri: '',
        description: '',
        mimeType: 'application/json',
        resourceType: '',
        isEnabled: false,
      });
      setCreateOpen(false);
    } catch {
      // silent
    } finally {
      setCreating(false);
    }
  }

  async function handleRemove(resourceId: string) {
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.mcpResourceById(resourceId));
      setResources((prev) => prev.filter((r) => r.id !== resourceId));
    } catch {
      // silent
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
      {/* Create Resource Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogTrigger asChild>
          <Button size="sm" data-testid="create-resource-trigger">
            Create Resource
          </Button>
        </DialogTrigger>
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
                  The URI that MCP clients use to access this resource. Must use the{' '}
                  <code className="text-xs">sunrise://</code> scheme (e.g.{' '}
                  <code className="text-xs">sunrise://knowledge/search</code>).
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
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                Create Your First Resource
              </Button>
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
                <TableHead className="w-[80px]" />
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
                      aria-label={`Enable ${resource.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleRemove(resource.id)}
                      className="text-destructive text-xs"
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
