'use client';

/**
 * BuilderToolbar — top bar of the workflow builder.
 *
 * Owns the editable workflow name, a "Use Template" dropdown (still
 * stubbed in 5.1b — wires up in 5.1c) and three action buttons:
 * Save / Validate / Execute. Session 5.1b enables Save and Validate;
 * Execute stays disabled until Session 5.2 lands the engine.
 */

import Link from 'next/link';
import { ChevronLeft, CheckCircle2, FileText, Loader2, Play, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logging';

const EXECUTE_TOOLTIP = 'Available in Session 5.2';

export interface BuilderToolbarProps {
  workflowName: string;
  onNameChange: (name: string) => void;
  mode: 'create' | 'edit';
  /** Called when the Validate button is clicked. */
  onValidate: () => void;
  /** Called when the Save button is clicked. */
  onSave: () => void;
  /** True while a save is in flight — Save shows a spinner. */
  saving: boolean;
  /** True when live validation is reporting at least one error — Save outlines in red. */
  hasErrors: boolean;
}

export function BuilderToolbar({
  workflowName,
  onNameChange,
  mode,
  onValidate,
  onSave,
  saving,
  hasErrors,
}: BuilderToolbarProps) {
  return (
    <div
      data-testid="builder-toolbar"
      className="bg-background/95 flex items-center gap-3 border-b px-4 py-2 backdrop-blur"
    >
      <Button asChild variant="ghost" size="sm">
        <Link href="/admin/orchestration/workflows">
          <ChevronLeft className="mr-1 h-4 w-4" />
          Workflows
        </Link>
      </Button>

      <div className="flex-1">
        <Input
          aria-label="Workflow name"
          value={workflowName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Untitled workflow"
          className="max-w-md"
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <FileText className="mr-2 h-4 w-4" />
            Use template
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Templates</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled
            onClick={() => logger.info('template selection stubbed in 5.1b')}
          >
            Template loading arrives in Session 5.1c
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="outline" size="sm" onClick={onValidate}>
        <CheckCircle2 className="mr-2 h-4 w-4" />
        Validate
      </Button>

      <Button variant="outline" size="sm" disabled title={EXECUTE_TOOLTIP}>
        <Play className="mr-2 h-4 w-4" />
        Execute
      </Button>

      <Button
        size="sm"
        onClick={onSave}
        disabled={saving}
        className={cn(hasErrors && 'ring-2 ring-red-500/60 focus-visible:ring-red-500')}
      >
        {saving ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Save className="mr-2 h-4 w-4" />
        )}
        {mode === 'create' ? 'Create workflow' : 'Save changes'}
      </Button>
    </div>
  );
}
