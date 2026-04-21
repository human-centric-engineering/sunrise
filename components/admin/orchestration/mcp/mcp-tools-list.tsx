'use client';

/**
 * MCP Tools List Component
 *
 * Table of capabilities with MCP enable/disable toggle per row.
 * Allows adding capabilities as MCP tools, toggling exposure,
 * and inline editing of custom name, description, rate limit, and required scope.
 */

import { useState } from 'react';
import { Pencil } from 'lucide-react';
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
  DialogFooter,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Tip } from '@/components/ui/tooltip';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { exposedToolRowSchema, type ExposedToolRow } from '@/lib/validations/mcp';

interface CapabilityRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
}

interface McpToolsListProps {
  initialTools: ExposedToolRow[];
  capabilities: CapabilityRow[];
}

interface EditForm {
  customName: string;
  customDescription: string;
  rateLimitPerKey: string;
  requiresScope: string;
}

export function McpToolsList({ initialTools, capabilities }: McpToolsListProps) {
  const [tools, setTools] = useState(initialTools);
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string>('');
  const [adding, setAdding] = useState(false);
  const [editingTool, setEditingTool] = useState<ExposedToolRow | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    customName: '',
    customDescription: '',
    rateLimitPerKey: '',
    requiresScope: '',
  });
  const [editSaving, setEditSaving] = useState(false);

  const exposedCapabilityIds = new Set(tools.map((t) => t.capabilityId));
  const availableCapabilities = capabilities.filter((c) => !exposedCapabilityIds.has(c.id));

  async function handleToggle(toolId: string, isEnabled: boolean) {
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpToolById(toolId), {
        body: { isEnabled },
      });
      setTools((prev) => prev.map((t) => (t.id === toolId ? { ...t, isEnabled } : t)));
    } catch {
      // silent
    }
  }

  async function handleAdd() {
    if (!selectedCapabilityId) return;
    setAdding(true);
    try {
      const raw = await apiClient.post<unknown>(API.ADMIN.ORCHESTRATION.MCP_TOOLS, {
        body: { capabilityId: selectedCapabilityId, isEnabled: false },
      });
      const data = exposedToolRowSchema.parse(raw);
      setTools((prev) => [...prev, data]);
      setSelectedCapabilityId('');
    } catch {
      // silent
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(toolId: string) {
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.mcpToolById(toolId));
      setTools((prev) => prev.filter((t) => t.id !== toolId));
    } catch {
      // silent
    }
  }

  function openEdit(tool: ExposedToolRow) {
    setEditingTool(tool);
    setEditForm({
      customName: tool.customName ?? '',
      customDescription: tool.customDescription ?? '',
      rateLimitPerKey: tool.rateLimitPerKey?.toString() ?? '',
      requiresScope: tool.requiresScope ?? '',
    });
  }

  async function handleEditSave() {
    if (!editingTool) return;
    setEditSaving(true);
    try {
      const body: Record<string, unknown> = {};
      const name = editForm.customName.trim();
      const desc = editForm.customDescription.trim();
      const rate = editForm.rateLimitPerKey.trim();
      const scope = editForm.requiresScope.trim();

      body.customName = name || null;
      body.customDescription = desc || null;
      body.rateLimitPerKey = rate ? parseInt(rate, 10) : null;
      body.requiresScope = scope || null;

      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpToolById(editingTool.id), { body });
      setTools((prev) =>
        prev.map((t) =>
          t.id === editingTool.id
            ? {
                ...t,
                customName: name || null,
                customDescription: desc || null,
                rateLimitPerKey: rate ? parseInt(rate, 10) : null,
                requiresScope: scope || null,
              }
            : t
        )
      );
      setEditingTool(null);
    } catch {
      // silent
    } finally {
      setEditSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Edit Tool Dialog */}
      <Dialog
        open={editingTool !== null}
        onOpenChange={(open) => {
          if (!open) setEditingTool(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Tool: {editingTool?.capability.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="edit-custom-name">
                Custom Name
                <FieldHelp title="Custom Tool Name">
                  Override the capability name shown to MCP clients. Must be lowercase with
                  underscores (e.g. <code className="text-xs">search_knowledge</code>). Leave blank
                  to use the default capability slug.
                </FieldHelp>
              </Label>
              <Input
                id="edit-custom-name"
                value={editForm.customName}
                onChange={(e) => setEditForm((f) => ({ ...f, customName: e.target.value }))}
                placeholder={editingTool?.capability.slug ?? ''}
              />
            </div>
            <div>
              <Label htmlFor="edit-custom-desc">
                Custom Description
                <FieldHelp title="Custom Description">
                  Override the tool description shown to MCP clients. Clients use this to decide
                  when to call the tool. Leave blank to use the default capability description.
                </FieldHelp>
              </Label>
              <Textarea
                id="edit-custom-desc"
                value={editForm.customDescription}
                onChange={(e) => setEditForm((f) => ({ ...f, customDescription: e.target.value }))}
                placeholder={editingTool?.capability.description ?? ''}
                rows={3}
              />
            </div>
            <div>
              <Label htmlFor="edit-rate-limit">
                Rate Limit Per Key
                <FieldHelp title="Per-Tool Rate Limit">
                  Maximum calls per minute per API key for this specific tool. Leave blank to use
                  the global server rate limit.
                </FieldHelp>
              </Label>
              <Input
                id="edit-rate-limit"
                type="number"
                min={1}
                max={10000}
                value={editForm.rateLimitPerKey}
                onChange={(e) => setEditForm((f) => ({ ...f, rateLimitPerKey: e.target.value }))}
                placeholder="default"
              />
            </div>
            <div>
              <Label htmlFor="edit-requires-scope">
                Required Scope
                <FieldHelp title="Required Scope">
                  An additional scope the API key must have to call this tool, beyond the standard
                  <code className="text-xs">tools:execute</code> scope. Use for sensitive tools that
                  need extra permission (e.g. <code className="text-xs">admin:write</code>).
                </FieldHelp>
              </Label>
              <Input
                id="edit-requires-scope"
                value={editForm.requiresScope}
                onChange={(e) => setEditForm((f) => ({ ...f, requiresScope: e.target.value }))}
                placeholder="none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => void handleEditSave()} disabled={editSaving}>
              {editSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add capability */}
      {availableCapabilities.length > 0 && (
        <div className="flex items-center gap-3">
          <Select value={selectedCapabilityId} onValueChange={setSelectedCapabilityId}>
            <SelectTrigger className="w-80">
              <SelectValue placeholder="Select a capability to expose..." />
            </SelectTrigger>
            <SelectContent>
              {availableCapabilities.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} ({c.slug})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => void handleAdd()}
            disabled={!selectedCapabilityId || adding}
            size="sm"
          >
            Add Tool
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Tip label="The orchestration capability this tool exposes to MCP clients">
                  <span>Capability</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="URL-safe identifier used in MCP tool calls">
                  <span>Slug</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Capability category (e.g. data, communication, analysis)">
                  <span>Category</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Override the default capability name shown to MCP clients">
                  <span>Custom Name</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Max calls per minute per API key — blank uses the global rate limit">
                  <span>Rate Limit</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Toggle whether MCP clients can discover and call this tool">
                  <span>Enabled</span>
                </Tip>
              </TableHead>
              <TableHead className="w-[120px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tools.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center">
                  <p className="text-muted-foreground mb-1">No tools exposed yet.</p>
                  <p className="text-muted-foreground text-xs">
                    {availableCapabilities.length > 0
                      ? 'Select a capability from the dropdown above and click "Add Tool" to expose it to MCP clients. Tools are disabled by default — toggle them on when ready.'
                      : 'Create capabilities in the Capabilities section first, then return here to expose them to MCP clients.'}
                  </p>
                </TableCell>
              </TableRow>
            ) : (
              tools.map((tool) => (
                <TableRow key={tool.id}>
                  <TableCell className="font-medium">{tool.capability.name}</TableCell>
                  <TableCell>
                    <code className="text-xs">{tool.capability.slug}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{tool.capability.category}</Badge>
                  </TableCell>
                  <TableCell>
                    {tool.customName ? (
                      <code className="text-xs">{tool.customName}</code>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {tool.rateLimitPerKey ? (
                      <span className="text-xs">{tool.rateLimitPerKey}/min</span>
                    ) : (
                      <span className="text-muted-foreground text-xs">default</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={tool.isEnabled}
                      onCheckedChange={(checked) => void handleToggle(tool.id, checked)}
                      aria-label={`Enable ${tool.capability.name}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(tool)}
                        className="text-xs"
                        aria-label={`Edit ${tool.capability.name}`}
                      >
                        <Pencil className="mr-1 h-3 w-3" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRemove(tool.id)}
                        className="text-destructive text-xs"
                      >
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
