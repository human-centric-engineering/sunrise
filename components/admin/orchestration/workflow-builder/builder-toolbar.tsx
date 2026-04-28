'use client';

/**
 * BuilderToolbar — top bar of the workflow builder.
 *
 * Owns the editable workflow name, a "Use template" dropdown and three
 * action buttons: Save / Validate / Execute.
 */

import Link from 'next/link';
import {
  BookmarkPlus,
  Check,
  ChevronLeft,
  CheckCircle2,
  ClipboardCopy,
  FileText,
  Loader2,
  Play,
  Save,
} from 'lucide-react';

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
import type { TemplateItem } from '@/components/admin/orchestration/workflow-builder/template-types';

const EXECUTE_CREATE_TOOLTIP = 'Save the workflow before executing';

export interface BuilderToolbarProps {
  workflowName: string;
  onNameChange: (name: string) => void;
  mode: 'create' | 'edit';
  /** Called when the Copy JSON button is clicked. */
  onCopyJson: () => void;
  /** Called when the Validate button is clicked. */
  onValidate: () => void;
  /** Called when the Save button is clicked. */
  onSave: () => void;
  /** Called when the Execute button is clicked (edit mode only). */
  onExecute: () => void;
  /** Called when "Save as template" is clicked (edit mode only). */
  onSaveAsTemplate: () => void;
  /** True while save-as-template is in flight. */
  savingAsTemplate: boolean;
  /** True briefly after save-as-template succeeds. */
  savedAsTemplate: boolean;
  /** Called when a template is picked from the dropdown. */
  onTemplateSelect: (template: TemplateItem) => void;
  /** Server-prefetched templates for the dropdown. */
  templates: readonly TemplateItem[];
  /** True when the template dropdown should render its items as disabled (edit mode). */
  templatesDisabled: boolean;
  /** True while a save is in flight — Save shows a spinner. */
  saving: boolean;
  /** True briefly after a successful save — Save shows a checkmark. */
  saved: boolean;
  /** True when live validation is reporting at least one error — Save outlines in red. */
  hasErrors: boolean;
}

export function BuilderToolbar({
  workflowName,
  onNameChange,
  mode,
  onCopyJson,
  onValidate,
  onSave,
  onExecute,
  onSaveAsTemplate,
  savingAsTemplate,
  savedAsTemplate,
  onTemplateSelect,
  templates,
  templatesDisabled,
  saving,
  saved,
  hasErrors,
}: BuilderToolbarProps) {
  const executeDisabled = mode !== 'edit' || hasErrors;
  return (
    <div
      data-testid="builder-toolbar"
      className="bg-background/95 flex flex-wrap items-center gap-2 border-b px-4 py-2 backdrop-blur sm:gap-3"
    >
      <Button asChild variant="ghost" size="sm">
        <Link href="/admin/orchestration/workflows">
          <ChevronLeft className="mr-1 h-4 w-4" />
          Workflows
        </Link>
      </Button>

      <div className="min-w-0 flex-1 basis-48">
        <Input
          aria-label="Workflow name"
          value={workflowName}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Untitled workflow"
          className="max-w-md"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <FileText className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">Use template</span>
              <span className="sm:hidden">Template</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Templates</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {templatesDisabled && (
              <p className="text-muted-foreground px-2 py-1.5 text-xs">
                Templates can only be loaded on a new workflow.
              </p>
            )}
            {templates.map((template) => (
              <DropdownMenuItem
                key={template.slug}
                disabled={templatesDisabled}
                onSelect={(event) => {
                  event.preventDefault();
                  onTemplateSelect(template);
                }}
                className="flex-col items-start gap-0.5"
              >
                <span className="text-sm font-medium">{template.name}</span>
                <span className="text-muted-foreground text-xs">{template.description}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="outline"
          size="sm"
          onClick={onCopyJson}
          title="Copy workflow definition as JSON to clipboard"
        >
          <ClipboardCopy className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">Copy JSON</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={onValidate}
          title="Check for disconnected nodes, missing config, and cycle errors"
        >
          <CheckCircle2 className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">Validate</span>
        </Button>

        {mode === 'edit' && (
          <Button
            variant="outline"
            size="sm"
            onClick={onSaveAsTemplate}
            disabled={savingAsTemplate || savedAsTemplate}
            title="Clone this workflow into a reusable template"
          >
            {savingAsTemplate ? (
              <Loader2 className="h-4 w-4 animate-spin sm:mr-2" />
            ) : savedAsTemplate ? (
              <Check className="h-4 w-4 sm:mr-2" />
            ) : (
              <BookmarkPlus className="h-4 w-4 sm:mr-2" />
            )}
            <span className="hidden sm:inline">
              {savedAsTemplate ? 'Template saved' : 'Save as template'}
            </span>
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={onExecute}
          disabled={executeDisabled}
          title={
            mode !== 'edit'
              ? EXECUTE_CREATE_TOOLTIP
              : hasErrors
                ? 'Fix validation errors before executing'
                : 'Run this workflow now with a test input'
          }
        >
          <Play className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">Execute</span>
        </Button>

        <Button
          size="sm"
          onClick={onSave}
          disabled={saving || saved || hasErrors}
          aria-label={
            hasErrors
              ? 'Save disabled — fix validation errors first (click Validate to see details)'
              : undefined
          }
          title={hasErrors ? 'Fix validation errors before saving' : undefined}
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <span className="hidden sm:inline">Saving…</span>
            </>
          ) : saved ? (
            <>
              <Check className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">Saved</span>
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {mode === 'create' ? 'Create workflow' : 'Save changes'}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
