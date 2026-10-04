'use client';

/**
 * MCP Prompts List Component
 *
 * Table of slash-command templates with create / edit / preview / delete.
 * `name` is immutable post-create (renames break client bookmarks); the
 * edit dialog disables that field with a visible explanation. Template
 * preview renders the placeholders against admin-supplied mock arguments
 * to show what a client will see.
 */

import { useState } from 'react';
import { MessageSquareText, Plus, X } from 'lucide-react';
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
import { Checkbox } from '@/components/ui/checkbox';
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
import { promptRowSchema, type PromptRow, type McpPromptArgumentSpec } from '@/lib/validations/mcp';

interface CreateForm {
  name: string;
  description: string;
  template: string;
  argumentsSpec: McpPromptArgumentSpec[];
  isEnabled: boolean;
}

interface EditForm {
  description: string;
  template: string;
  argumentsSpec: McpPromptArgumentSpec[];
  isEnabled: boolean;
}

const EMPTY_ARG: McpPromptArgumentSpec = { name: '', description: '', required: false };

const EMPTY_CREATE_FORM: CreateForm = {
  name: '',
  description: '',
  template: '',
  argumentsSpec: [],
  isEnabled: true,
};

interface McpPromptsListProps {
  initialPrompts: PromptRow[];
}

/**
 * Mirror of the server-side `renderTemplate` logic in prompt-registry.ts
 * for client-side preview. Keep these in sync — they share the same
 * "only allow-listed names are substituted" invariant.
 */
function previewTemplate(
  template: string,
  args: Record<string, string>,
  allowed: Set<string>
): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (full, rawName: string) => {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) return full;
    return args[name] ?? '';
  });
}

export function McpPromptsList({ initialPrompts }: McpPromptsListProps) {
  const readOnly = useSharedSettingsReadOnly();
  const [prompts, setPrompts] = useState(initialPrompts);
  const [error, setError] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [creating, setCreating] = useState(false);

  // Edit dialog
  const [editingPrompt, setEditingPrompt] = useState<PromptRow | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    description: '',
    template: '',
    argumentsSpec: [],
    isEnabled: true,
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Preview dialog
  const [previewPrompt, setPreviewPrompt] = useState<PromptRow | null>(null);
  const [previewArgs, setPreviewArgs] = useState<Record<string, string>>({});

  async function handleToggle(id: string, isEnabled: boolean): Promise<void> {
    setError(null);
    try {
      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpPromptById(id), { body: { isEnabled } });
      setPrompts((prev) => prev.map((p) => (p.id === id ? { ...p, isEnabled } : p)));
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to toggle prompt.'));
    }
  }

  async function handleCreate(): Promise<void> {
    if (!createForm.name.trim() || !createForm.template.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const raw = await apiClient.post<unknown>(API.ADMIN.ORCHESTRATION.MCP_PROMPTS, {
        body: {
          name: createForm.name.trim(),
          description: createForm.description.trim(),
          template: createForm.template,
          argumentsSpec: createForm.argumentsSpec.filter((a) => a.name.trim() !== ''),
          isEnabled: createForm.isEnabled,
        },
      });
      const data = promptRowSchema.parse(raw);
      setPrompts((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setCreateForm(EMPTY_CREATE_FORM);
      setCreateOpen(false);
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to create prompt.'));
    } finally {
      setCreating(false);
    }
  }

  function openEdit(prompt: PromptRow): void {
    setEditingPrompt(prompt);
    setEditError(null);
    setEditForm({
      description: prompt.description,
      template: prompt.template,
      argumentsSpec: prompt.argumentsSpec,
      isEnabled: prompt.isEnabled,
    });
  }

  async function handleEditSave(): Promise<void> {
    if (!editingPrompt) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const body: Record<string, unknown> = {
        description: editForm.description.trim(),
        template: editForm.template,
        argumentsSpec: editForm.argumentsSpec.filter((a) => a.name.trim() !== ''),
        isEnabled: editForm.isEnabled,
      };
      await apiClient.patch(API.ADMIN.ORCHESTRATION.mcpPromptById(editingPrompt.id), { body });
      setPrompts((prev) =>
        prev.map((p) =>
          p.id === editingPrompt.id
            ? {
                ...p,
                description: body.description as string,
                template: body.template as string,
                argumentsSpec: body.argumentsSpec as McpPromptArgumentSpec[],
                isEnabled: body.isEnabled as boolean,
              }
            : p
        )
      );
      setEditingPrompt(null);
    } catch (err) {
      setEditError(extractErrorMessage(err, 'Failed to update prompt.'));
    } finally {
      setEditSaving(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setError(null);
    try {
      await apiClient.delete(API.ADMIN.ORCHESTRATION.mcpPromptById(id));
      setPrompts((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to remove prompt.'));
    }
  }

  function openPreview(prompt: PromptRow): void {
    setPreviewPrompt(prompt);
    // Seed args with empty strings so the form renders inputs immediately.
    const seed: Record<string, string> = {};
    for (const arg of prompt.argumentsSpec) seed[arg.name] = '';
    setPreviewArgs(seed);
  }

  const isEmpty = prompts.length === 0;

  return (
    <div className="space-y-4">
      {error && <p className="text-destructive text-sm">{error}</p>}

      {/* Create button + dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) setCreateForm(EMPTY_CREATE_FORM);
        }}
      >
        {!readOnly && (
          <DialogTrigger asChild>
            <Button size="sm" data-testid="create-prompt-trigger">
              Create Prompt
            </Button>
          </DialogTrigger>
        )}
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create MCP Prompt</DialogTitle>
          </DialogHeader>
          <PromptFormFields
            form={createForm}
            onChange={setCreateForm}
            includeName
            isNameImmutable={false}
          />
          <DialogFooter>
            <Button
              onClick={() => void handleCreate()}
              disabled={!createForm.name.trim() || !createForm.template.trim() || creating}
              data-testid="create-prompt-submit"
            >
              {creating ? 'Creating...' : 'Create Prompt'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editingPrompt !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditingPrompt(null);
            setEditError(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Prompt: {editingPrompt?.name}</DialogTitle>
          </DialogHeader>
          <div className="bg-muted/50 rounded-md p-2 text-xs">
            <p className="text-muted-foreground">
              <strong className="text-foreground">name</strong> (<code>{editingPrompt?.name}</code>)
              cannot be changed — treat it as an API contract. To evolve behaviour, ship a new
              versioned name (e.g. <code>{editingPrompt?.name}-v2</code>) alongside this one and
              retire the old one when no clients reference it.
            </p>
          </div>
          <PromptFormFields
            form={{ ...editForm, name: editingPrompt?.name ?? '' }}
            onChange={(next) =>
              setEditForm({
                description: next.description,
                template: next.template,
                argumentsSpec: next.argumentsSpec,
                isEnabled: next.isEnabled,
              })
            }
            includeName
            isNameImmutable
          />
          {editError && <p className="text-destructive text-sm">{editError}</p>}
          <DialogFooter>
            <Button
              onClick={() => void handleEditSave()}
              disabled={editSaving}
              data-testid="edit-prompt-save"
            >
              {editSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog
        open={previewPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewPrompt(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Preview: {previewPrompt?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-muted-foreground text-xs">
              Fill in mock argument values to see what a client will receive when this prompt is
              invoked. This preview runs the same substitution rules as the server: only declared
              argument names are interpolated.
            </p>
            {previewPrompt?.argumentsSpec.map((arg) => (
              <div key={arg.name}>
                <Label htmlFor={`preview-arg-${arg.name}`}>
                  {arg.name}
                  {arg.required && <span className="text-destructive ml-1">*</span>}
                </Label>
                <Input
                  id={`preview-arg-${arg.name}`}
                  value={previewArgs[arg.name] ?? ''}
                  onChange={(e) =>
                    setPreviewArgs((prev) => ({ ...prev, [arg.name]: e.target.value }))
                  }
                  placeholder={arg.description}
                />
              </div>
            ))}
            <div>
              <Label>Rendered output</Label>
              <pre
                className="bg-muted rounded-md p-3 text-xs whitespace-pre-wrap"
                data-testid="preview-output"
              >
                {previewPrompt
                  ? previewTemplate(
                      previewPrompt.template,
                      previewArgs,
                      new Set(previewPrompt.argumentsSpec.map((a) => a.name))
                    )
                  : ''}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Empty state */}
      {isEmpty && (
        <Card>
          <CardContent className="py-8">
            <div className="mx-auto max-w-md text-center">
              <MessageSquareText className="text-muted-foreground mx-auto mb-3 h-10 w-10" />
              <h3 className="text-foreground mb-2 text-base font-medium">No prompts yet</h3>
              <p className="text-muted-foreground mb-4 text-sm">
                Prompts are <strong className="text-foreground">slash-command templates</strong>{' '}
                surfaced by MCP clients (e.g. <code>/analyze-pattern</code> in Claude Desktop). End
                users pick them from a menu — they are <em>not</em> auto-invoked by the model.
              </p>
              {!readOnly && (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Create Your First Prompt
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
                  <Tip label="Slash-command identifier shown to end users in their client">
                    <span>Name</span>
                  </Tip>
                </TableHead>
                <TableHead>Description</TableHead>
                <TableHead>
                  <Tip label="Number of declared arguments (required + optional)">
                    <span>Arguments</span>
                  </Tip>
                </TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="w-[200px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {prompts.map((prompt) => (
                <TableRow key={prompt.id}>
                  <TableCell>
                    <code className="text-xs font-medium">{prompt.name}</code>
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-md text-xs">
                    {prompt.description}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{prompt.argumentsSpec.length}</Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={prompt.isEnabled}
                      onCheckedChange={(checked) => void handleToggle(prompt.id, checked)}
                      disabled={readOnly}
                      aria-label={`Enable ${prompt.name}`}
                    />
                  </TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={() => openPreview(prompt)}
                    >
                      Preview
                    </Button>
                    {!readOnly && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => openEdit(prompt)}
                          data-testid={`edit-prompt-${prompt.id}`}
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
                              <AlertDialogTitle>Remove prompt?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Connected clients that have bookmarked{' '}
                                <code className="text-xs">{prompt.name}</code> will get a
                                &quot;prompt not found&quot; error on next invocation. This action
                                cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                onClick={() => void handleRemove(prompt.id)}
                              >
                                Remove
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </>
                    )}
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared form-field block used by Create and Edit dialogs
// ─────────────────────────────────────────────────────────────────────────────

interface PromptFormFieldsProps {
  form: { name: string } & EditForm;
  onChange: (form: { name: string } & EditForm) => void;
  includeName: boolean;
  isNameImmutable: boolean;
}

function PromptFormFields({ form, onChange, includeName, isNameImmutable }: PromptFormFieldsProps) {
  function setField<K extends keyof ({ name: string } & EditForm)>(
    key: K,
    value: ({ name: string } & EditForm)[K]
  ): void {
    onChange({ ...form, [key]: value });
  }

  function updateArg(idx: number, patch: Partial<McpPromptArgumentSpec>): void {
    const next = form.argumentsSpec.map((a, i) => (i === idx ? { ...a, ...patch } : a));
    setField('argumentsSpec', next);
  }

  function removeArg(idx: number): void {
    setField(
      'argumentsSpec',
      form.argumentsSpec.filter((_, i) => i !== idx)
    );
  }

  function addArg(): void {
    if (form.argumentsSpec.length >= 20) return;
    setField('argumentsSpec', [...form.argumentsSpec, { ...EMPTY_ARG }]);
  }

  return (
    <div className="space-y-4">
      {includeName && (
        <div>
          <Label htmlFor="prompt-name">
            Name
            <FieldHelp title="Prompt Name">
              The slash-command identifier. Lowercase letters, digits, underscores, and hyphens
              only. Cannot start with a digit.{' '}
              <strong>Treat as an API contract — immutable after creation.</strong> To evolve
              behaviour, ship a versioned new name (e.g. <code>analyse-pattern-v2</code>) and retire
              the old one when no clients reference it.
            </FieldHelp>
          </Label>
          <Input
            id="prompt-name"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="e.g. analyze-pattern"
            disabled={isNameImmutable}
            data-testid="prompt-name-input"
          />
        </div>
      )}

      <div>
        <Label htmlFor="prompt-description">Description</Label>
        <Textarea
          id="prompt-description"
          rows={2}
          value={form.description}
          onChange={(e) => setField('description', e.target.value)}
          placeholder="What does this prompt do? Shown to end users in their client."
        />
      </div>

      <div>
        <Label htmlFor="prompt-template">
          Template
          <FieldHelp title="Template Syntax">
            Use <code>{'{{argument_name}}'}</code> to insert values from the arguments list. Only
            argument names declared below are interpolated — stray placeholders like{' '}
            <code>{'{{database_url}}'}</code> render literally for safety. Max 10,000 characters;
            max 64 KB after rendering.
          </FieldHelp>
        </Label>
        <Textarea
          id="prompt-template"
          rows={6}
          value={form.template}
          onChange={(e) => setField('template', e.target.value)}
          placeholder={'Analyze pattern #{{pattern_number}} from the knowledge base.'}
          className="font-mono text-xs"
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <Label>Arguments</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addArg}
            disabled={form.argumentsSpec.length >= 20}
            data-testid="add-argument"
          >
            <Plus className="mr-1 h-3 w-3" />
            Add argument
          </Button>
        </div>
        {form.argumentsSpec.length === 0 && (
          <p className="text-muted-foreground text-xs">No arguments — this prompt is static.</p>
        )}
        <div className="space-y-2">
          {form.argumentsSpec.map((arg, idx) => (
            <div
              key={idx}
              className="bg-muted/50 grid grid-cols-[1fr_2fr_auto_auto] items-start gap-2 rounded-md p-2"
            >
              <Input
                placeholder="name"
                value={arg.name}
                onChange={(e) => updateArg(idx, { name: e.target.value })}
                className="text-xs"
                data-testid={`arg-name-${idx}`}
              />
              <Input
                placeholder="description"
                value={arg.description}
                onChange={(e) => updateArg(idx, { description: e.target.value })}
                className="text-xs"
              />
              <label
                htmlFor={`arg-required-${String(idx)}`}
                className="flex items-center gap-1 text-xs"
              >
                <Checkbox
                  id={`arg-required-${String(idx)}`}
                  checked={arg.required}
                  onCheckedChange={(checked) => updateArg(idx, { required: checked })}
                />
                required
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeArg(idx)}
                aria-label="Remove argument"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="prompt-enabled"
          checked={form.isEnabled}
          onCheckedChange={(checked) => setField('isEnabled', checked)}
        />
        <Label htmlFor="prompt-enabled" className="text-sm">
          Enabled (visible to MCP clients)
        </Label>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractErrorMessage(err: unknown, fallback: string): string {
  if (
    err !== null &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    const msg = (err as { message: string }).message;
    if (msg) return msg;
  }
  // ApiClientError shape: { code, message, status }
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: string; message?: string };
    if (e.code === 'PROMPT_CAP_EXCEEDED' && e.message) return e.message;
  }
  return fallback;
}
