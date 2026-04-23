'use client';

/**
 * Tool Call step editor — pick a capability from the admin-side registry.
 *
 * The `capabilities` list is fetched once by the builder shell via
 * `GET /admin/orchestration/capabilities` and passed down to every editor
 * that needs it. We validate the picked slug against the fetched list so
 * a stale local state can&rsquo;t sneak a free-text value past the editor.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { FieldHelp } from '@/components/ui/field-help';

import type {
  EditorProps,
  CapabilityOption,
} from '@/components/admin/orchestration/workflow-builder/block-editors/index';

export interface ToolCallConfig extends Record<string, unknown> {
  capabilitySlug: string;
}

export function ToolCallEditor({
  config,
  onChange,
  capabilities = [],
}: EditorProps<ToolCallConfig>) {
  const selected: CapabilityOption | undefined = capabilities.find(
    (c) => c.slug === config.capabilitySlug
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="tool-capability" className="flex items-center text-xs">
          Capability{' '}
          <FieldHelp title="Capability">
            The registered capability this step invokes. Capabilities are managed under{' '}
            <strong>AI Orchestration → Capabilities</strong>.
          </FieldHelp>
        </Label>

        {capabilities.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs italic">
            No capabilities available. Create one in the Capabilities admin first.
          </p>
        ) : (
          <Select
            value={config.capabilitySlug || undefined}
            onValueChange={(slug) => {
              // Validate against the known list; reject unknown slugs defensively.
              if (capabilities.some((c) => c.slug === slug)) {
                onChange({ capabilitySlug: slug });
              }
            }}
          >
            <SelectTrigger id="tool-capability">
              <SelectValue placeholder="Select a capability…" />
            </SelectTrigger>
            <SelectContent>
              {capabilities.map((capability) => (
                <SelectItem key={capability.id} value={capability.slug}>
                  {capability.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {selected && (
        <div className="bg-muted/40 rounded-md border px-3 py-2 text-xs leading-relaxed">
          <p className="text-muted-foreground mb-1 font-medium">About this capability</p>
          <p>{selected.description || 'No description provided.'}</p>
        </div>
      )}
    </div>
  );
}
