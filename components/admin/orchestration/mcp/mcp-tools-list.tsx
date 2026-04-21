'use client';

/**
 * MCP Tools List Component
 *
 * Table of capabilities with MCP enable/disable toggle per row.
 * Allows adding capabilities as MCP tools and toggling their exposure.
 */

import { useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tip } from '@/components/ui/tooltip';
import { API } from '@/lib/api/endpoints';

interface ExposedToolRow {
  id: string;
  capabilityId: string;
  isEnabled: boolean;
  customName: string | null;
  customDescription: string | null;
  rateLimitPerKey: number | null;
  capability: {
    id: string;
    name: string;
    slug: string;
    description: string;
    category: string;
  };
}

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

export function McpToolsList({ initialTools, capabilities }: McpToolsListProps) {
  const [tools, setTools] = useState(initialTools);
  const [selectedCapabilityId, setSelectedCapabilityId] = useState<string>('');
  const [adding, setAdding] = useState(false);

  const exposedCapabilityIds = new Set(tools.map((t) => t.capabilityId));
  const availableCapabilities = capabilities.filter((c) => !exposedCapabilityIds.has(c.id));

  async function handleToggle(toolId: string, isEnabled: boolean) {
    const res = await fetch(API.ADMIN.ORCHESTRATION.mcpToolById(toolId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isEnabled }),
    });
    if (res.ok) {
      setTools((prev) => prev.map((t) => (t.id === toolId ? { ...t, isEnabled } : t)));
    }
  }

  async function handleAdd() {
    if (!selectedCapabilityId) return;
    setAdding(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.MCP_TOOLS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilityId: selectedCapabilityId, isEnabled: false }),
      });
      if (res.ok) {
        const raw: unknown = await res.json();
        const body = raw as Record<string, unknown>;
        if (body?.success === true && typeof body.data === 'object' && body.data !== null) {
          setTools((prev) => [...prev, body.data as ExposedToolRow]);
          setSelectedCapabilityId('');
        }
      }
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(toolId: string) {
    const res = await fetch(API.ADMIN.ORCHESTRATION.mcpToolById(toolId), {
      method: 'DELETE',
    });
    if (res.ok) {
      setTools((prev) => prev.filter((t) => t.id !== toolId));
    }
  }

  return (
    <div className="space-y-4">
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
              <TableHead className="w-[80px]" />
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
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleRemove(tool.id)}
                      className="text-destructive text-xs"
                    >
                      Remove
                    </Button>
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
