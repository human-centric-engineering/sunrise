'use client';

/**
 * BuilderToolbar — top bar of the workflow builder.
 *
 * Owns the editable workflow name, a "Use Template" dropdown (stub in
 * Session 5.1a — selection is a no-op), and three action buttons:
 * Save / Validate / Execute. All three are disabled in this session;
 * wiring lands in 5.1b.
 */

import Link from 'next/link';
import { ChevronLeft, CheckCircle2, FileText, Play, Save } from 'lucide-react';

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
import { logger } from '@/lib/logging';

const COMING_SOON = 'Available in Session 5.1b';

export interface BuilderToolbarProps {
  workflowName: string;
  onNameChange: (name: string) => void;
  mode: 'create' | 'edit';
}

export function BuilderToolbar({ workflowName, onNameChange, mode }: BuilderToolbarProps) {
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
            onClick={() => logger.info('template selection stubbed in 5.1a')}
          >
            Template loading arrives in Session 5.1c
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="outline" size="sm" disabled title={COMING_SOON}>
        <CheckCircle2 className="mr-2 h-4 w-4" />
        Validate
      </Button>

      <Button variant="outline" size="sm" disabled title={COMING_SOON}>
        <Play className="mr-2 h-4 w-4" />
        Execute
      </Button>

      <Button size="sm" disabled title={COMING_SOON}>
        <Save className="mr-2 h-4 w-4" />
        {mode === 'create' ? 'Create workflow' : 'Save changes'}
      </Button>
    </div>
  );
}
