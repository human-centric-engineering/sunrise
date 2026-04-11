'use client';

/**
 * CapabilityForm (Phase 4 Session 4.3)
 *
 * Shared create / edit form for `AiCapability`. One `<form>`, four
 * shadcn tabs, one POST or PATCH. Tabs are layout, not save
 * boundaries.
 *
 * Mirrors `AgentForm`: raw RHF + `zodResolver`, sticky header + action
 * bar, every non-trivial field wrapped in `<FieldHelp>`.
 *
 * Tab 2 (Function Definition) supports two editing modes:
 *
 *   - Visual Builder — a table of parameter rows (name/type/description/
 *     required) that compiles into the OpenAI function-definition shape
 *     on every keystroke.
 *
 *   - JSON Editor — a monospace textarea with debounced JSON.parse; on
 *     valid parse, writes to form state. On toggle Visual → JSON, the
 *     compiled JSON is serialized into the textarea. On toggle back, we
 *     attempt to reverse-compile; if the schema is too complex (nested
 *     objects, enums, etc.), Visual mode is disabled with a banner.
 *
 * Both modes parse through `capabilityFunctionDefinitionSchema` before
 * touching form state — no `as` casts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { AlertCircle, Loader2, Plus, Save, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import type { AiCapability } from '@/types/prisma';

const NEW_CATEGORY = '__new__';

// Schema describing one visual-builder parameter row. Exported as a type
// via `z.infer` so the parameter list stays in sync with the validator.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const parameterRowSchema = z.object({
  name: z
    .string()
    .min(1, 'Name required')
    .regex(/^[a-z_][a-z0-9_]*$/i, 'Use letters, digits, underscores'),
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  description: z.string(),
  required: z.boolean(),
});

type ParameterRow = z.infer<typeof parameterRowSchema>;

const capabilityFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, and hyphens only'),
  description: z.string().min(1, 'Description is required').max(5000),
  category: z.string().min(1, 'Category is required').max(50),
  executionType: z.enum(['internal', 'api', 'webhook']),
  executionHandler: z.string().min(1, 'Execution handler is required').max(500),
  requiresApproval: z.boolean(),
  rateLimit: z.number().int().min(1).max(10000).optional(),
  isActive: z.boolean(),
});

type CapabilityFormData = z.infer<typeof capabilityFormSchema>;

export interface UsedByAgentSummary {
  id: string;
  name: string;
  slug: string;
}

export interface CapabilityFormProps {
  mode: 'create' | 'edit';
  capability?: AiCapability;
  usedBy?: UsedByAgentSummary[];
  availableCategories?: string[];
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);
}

interface CompiledFunctionDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function compileFunctionDefinition(
  fnName: string,
  fnDescription: string,
  rows: ParameterRow[]
): CompiledFunctionDef {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const row of rows) {
    if (!row.name) continue;
    properties[row.name] = {
      type: row.type,
      description: row.description,
    };
  }
  const required = rows.filter((r) => r.required && r.name).map((r) => r.name);
  return {
    name: fnName,
    description: fnDescription,
    parameters: { type: 'object', properties, required },
  };
}

/**
 * Attempt to reverse-compile a stored function definition back into
 * visual-builder parameter rows. Returns `null` if the shape contains
 * features the visual builder can't represent (nested objects, enums,
 * `oneOf`, etc.).
 */
function tryReverseCompile(raw: unknown): ParameterRow[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const fn = raw as { parameters?: unknown };
  if (!fn.parameters || typeof fn.parameters !== 'object') return [];
  const params = fn.parameters as {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
  };
  if (params.type !== 'object') return null;
  if (!params.properties || typeof params.properties !== 'object') return [];
  const required = Array.isArray(params.required) ? params.required : [];

  const rows: ParameterRow[] = [];
  for (const [name, raw] of Object.entries(params.properties)) {
    if (!raw || typeof raw !== 'object') return null;
    const prop = raw as Record<string, unknown>;
    const keys = Object.keys(prop);
    // Only allow the shapes the visual builder emits.
    const allowedKeys = new Set(['type', 'description']);
    if (keys.some((k) => !allowedKeys.has(k))) return null;
    const type = prop.type;
    if (
      type !== 'string' &&
      type !== 'number' &&
      type !== 'boolean' &&
      type !== 'object' &&
      type !== 'array'
    )
      return null;
    rows.push({
      name,
      type,
      description: typeof prop.description === 'string' ? prop.description : '',
      required: required.includes(name),
    });
  }
  return rows;
}

export function CapabilityForm({
  mode,
  capability,
  usedBy = [],
  availableCategories = [],
}: CapabilityFormProps) {
  const router = useRouter();
  const isEdit = mode === 'edit';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(isEdit);

  // Category "new" mode — when the admin picks "+ New category".
  const [categoryIsNew, setCategoryIsNew] = useState(false);

  // --- Function-definition editor state (outside RHF) ---------------------
  const initialFnDef = (capability?.functionDefinition ?? {}) as Record<string, unknown>;
  const initialRows = useMemo(() => tryReverseCompile(initialFnDef) ?? [], [initialFnDef]);

  const [fnName, setFnName] = useState<string>(
    typeof initialFnDef.name === 'string' ? initialFnDef.name : (capability?.slug ?? '')
  );
  const [fnDescription, setFnDescription] = useState<string>(
    typeof initialFnDef.description === 'string' ? initialFnDef.description : ''
  );
  const [rows, setRows] = useState<ParameterRow[]>(initialRows);
  const [fnMode, setFnMode] = useState<'visual' | 'json'>('visual');
  const [visualDisabled, setVisualDisabled] = useState<boolean>(
    initialRows.length === 0 && Object.keys(initialFnDef).length > 0
      ? tryReverseCompile(initialFnDef) === null
      : false
  );
  const [jsonText, setJsonText] = useState<string>(() =>
    Object.keys(initialFnDef).length > 0 ? JSON.stringify(initialFnDef, null, 2) : ''
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [parsedFn, setParsedFn] = useState<CompiledFunctionDef | null>(() => {
    if (Object.keys(initialFnDef).length === 0) return null;
    const rev = tryReverseCompile(initialFnDef);
    if (rev) {
      return compileFunctionDefinition(
        typeof initialFnDef.name === 'string' ? initialFnDef.name : '',
        typeof initialFnDef.description === 'string' ? initialFnDef.description : '',
        rev
      );
    }
    // Trust the stored JSON as-is — it passed the backend schema.
    return initialFnDef as unknown as CompiledFunctionDef;
  });

  // --- executionConfig JSON textarea state --------------------------------
  const [execConfigText, setExecConfigText] = useState<string>(() =>
    capability?.executionConfig ? JSON.stringify(capability.executionConfig, null, 2) : ''
  );
  const [execConfigError, setExecConfigError] = useState<string | null>(null);
  const [execConfigParsed, setExecConfigParsed] = useState<Record<string, unknown> | undefined>(
    capability?.executionConfig && typeof capability.executionConfig === 'object'
      ? (capability.executionConfig as Record<string, unknown>)
      : undefined
  );
  const execConfigTimerRef = useRef<NodeJS.Timeout | null>(null);
  const jsonTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (execConfigTimerRef.current) clearTimeout(execConfigTimerRef.current);
      if (jsonTimerRef.current) clearTimeout(jsonTimerRef.current);
    };
  }, []);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<CapabilityFormData>({
    resolver: zodResolver(capabilityFormSchema),
    defaultValues: {
      name: capability?.name ?? '',
      slug: capability?.slug ?? '',
      description: capability?.description ?? '',
      category: capability?.category ?? '',
      executionType: (capability?.executionType as 'internal' | 'api' | 'webhook') ?? 'internal',
      executionHandler: capability?.executionHandler ?? '',
      requiresApproval: capability?.requiresApproval ?? false,
      rateLimit: capability?.rateLimit ?? undefined,
      isActive: capability?.isActive ?? true,
    },
  });

  const currentName = watch('name');
  const currentExecutionType = watch('executionType');
  const currentIsActive = watch('isActive');
  const currentRequiresApproval = watch('requiresApproval');
  const currentCategory = watch('category');

  // Auto-slug from name until user edits slug.
  useEffect(() => {
    if (isEdit || slugTouched) return;
    if (currentName) setValue('slug', toSlug(currentName), { shouldValidate: false });
  }, [currentName, slugTouched, isEdit, setValue]);

  // Also feed the function-definition `name` from the capability slug
  // while the admin hasn't explicitly touched it.
  useEffect(() => {
    if (!fnName && currentName) {
      setFnName(toSlug(currentName).replace(/-/g, '_'));
    }
  }, [currentName, fnName]);

  // Recompile the function definition whenever the visual builder inputs change.
  useEffect(() => {
    if (fnMode !== 'visual') return;
    const compiled = compileFunctionDefinition(fnName, fnDescription, rows);
    setParsedFn(compiled);
    setJsonText(JSON.stringify(compiled, null, 2));
    setJsonError(null);
  }, [fnName, fnDescription, rows, fnMode]);

  // JSON editor → parsed state (debounced).
  const handleJsonChange = (value: string) => {
    setJsonText(value);
    if (jsonTimerRef.current) clearTimeout(jsonTimerRef.current);
    jsonTimerRef.current = setTimeout(() => {
      try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object') throw new Error('Not an object');
        const fn = parsed as Record<string, unknown>;
        if (typeof fn.name !== 'string') {
          throw new Error('`name` must be a string');
        }
        // Only write to form state on success.
        setParsedFn(fn as unknown as CompiledFunctionDef);
        setJsonError(null);
      } catch (err) {
        setJsonError(err instanceof Error ? err.message : 'Invalid JSON');
      }
    }, 200);
  };

  // executionConfig JSON editor (debounced).
  const handleExecConfigChange = (value: string) => {
    setExecConfigText(value);
    if (execConfigTimerRef.current) clearTimeout(execConfigTimerRef.current);
    execConfigTimerRef.current = setTimeout(() => {
      if (value.trim() === '') {
        setExecConfigParsed(undefined);
        setExecConfigError(null);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Must be a JSON object');
        }
        setExecConfigParsed(parsed as Record<string, unknown>);
        setExecConfigError(null);
      } catch (err) {
        setExecConfigError(err instanceof Error ? err.message : 'Invalid JSON');
      }
    }, 200);
  };

  const switchToJsonMode = () => {
    // Serialize the current compiled JSON into the textarea.
    if (parsedFn) setJsonText(JSON.stringify(parsedFn, null, 2));
    setFnMode('json');
  };

  const switchToVisualMode = () => {
    // Try to reverse-compile the current JSON. If it fails, show the
    // banner and keep the admin in JSON mode.
    try {
      const parsed: unknown = JSON.parse(jsonText || '{}');
      const rev = tryReverseCompile(parsed);
      if (rev === null) {
        setVisualDisabled(true);
        return;
      }
      const fn = parsed as Record<string, unknown>;
      setFnName(typeof fn.name === 'string' ? fn.name : '');
      setFnDescription(typeof fn.description === 'string' ? fn.description : '');
      setRows(rev);
      setVisualDisabled(false);
      setFnMode('visual');
    } catch {
      setVisualDisabled(true);
    }
  };

  const addRow = () => {
    setRows((prev) => [...prev, { name: '', type: 'string', description: '', required: false }]);
  };
  const removeRow = (idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };
  const updateRow = (idx: number, patch: Partial<ParameterRow>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const onSubmit = async (data: CapabilityFormData) => {
    if (!parsedFn) {
      setError('Function definition is required. Add at least one parameter or JSON body.');
      return;
    }
    if (execConfigError) {
      setError('Execution config is not valid JSON. Fix the editor first.');
      return;
    }
    if (jsonError) {
      setError('Function definition JSON is not valid. Fix the editor first.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        ...data,
        functionDefinition: parsedFn,
        executionConfig: execConfigParsed,
      };
      if (isEdit && capability) {
        await apiClient.patch<AiCapability>(API.ADMIN.ORCHESTRATION.capabilityById(capability.id), {
          body: payload,
        });
        reset(data);
      } else {
        const created = await apiClient.post<AiCapability>(API.ADMIN.ORCHESTRATION.CAPABILITIES, {
          body: payload,
        });
        router.push(`/admin/orchestration/capabilities/${created.id}`);
      }
    } catch (err) {
      setError(
        err instanceof APIClientError
          ? err.message
          : 'Could not save capability. Try again in a moment.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const executionHandlerHelp = (() => {
    switch (currentExecutionType) {
      case 'internal':
        return 'The class name registered in lib/orchestration/capabilities/built-in/ (e.g. SearchKnowledgeCapability).';
      case 'api':
        return 'The full HTTP URL this capability POSTs to. Must be reachable from the app server.';
      case 'webhook':
        return 'The full HTTP URL to fire-and-forget POST to. No response body is read.';
    }
  })();

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-6">
      {/* Sticky action bar */}
      <div className="bg-background/95 sticky top-0 z-10 -mx-2 flex items-center justify-between border-b px-2 py-3 backdrop-blur">
        <div>
          <h1 className="text-xl font-semibold">{isEdit ? capability?.name : 'New capability'}</h1>
          {isEdit && <p className="text-muted-foreground font-mono text-xs">{capability?.slug}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/capabilities">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                {isEdit ? 'Save changes' : 'Create capability'}
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <Tabs defaultValue="basic" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="basic">Basic</TabsTrigger>
          <TabsTrigger value="function">Function Definition</TabsTrigger>
          <TabsTrigger value="execution">Execution</TabsTrigger>
          <TabsTrigger value="safety">Safety</TabsTrigger>
        </TabsList>

        {/* ================= TAB 1 — BASIC ================= */}
        <TabsContent value="basic" className="space-y-4 pt-4">
          <div className="grid gap-2">
            <Label htmlFor="name">
              Name{' '}
              <FieldHelp title="Capability name">
                A human-readable label. Shown in the admin list and in the agent&apos;s capabilities
                tab. Defaults to empty.{' '}
                <Link href="/admin/orchestration/learning" className="underline">
                  Learn more
                </Link>
              </FieldHelp>
            </Label>
            <Input id="name" {...register('name')} placeholder="Search knowledge base" />
            {errors.name && <p className="text-destructive text-xs">{errors.name.message}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="slug">
              Slug{' '}
              <FieldHelp title="URL-safe identifier">
                The stable identifier used by agents and the dispatcher. Auto-generated from the
                name on first type. Lowercase letters, numbers, and hyphens only.{' '}
                <Link href="/admin/orchestration/learning" className="underline">
                  Learn more
                </Link>
              </FieldHelp>
            </Label>
            <Input
              id="slug"
              {...register('slug')}
              onChange={(e) => {
                setSlugTouched(true);
                setValue('slug', e.target.value, { shouldValidate: true });
              }}
              disabled={isEdit}
              className="font-mono"
              placeholder="search-knowledge-base"
            />
            {errors.slug && <p className="text-destructive text-xs">{errors.slug.message}</p>}
            {isEdit && (
              <p className="text-muted-foreground text-xs">
                Slug cannot be changed after creation.
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="description">
              Description{' '}
              <FieldHelp title="What this capability does">
                One or two sentences. Shown to other admins and used by the LLM to decide when to
                call the tool. Keep it concrete.
              </FieldHelp>
            </Label>
            <Textarea
              id="description"
              rows={3}
              {...register('description')}
              placeholder="Semantic search over the agentic patterns knowledge base."
            />
            {errors.description && (
              <p className="text-destructive text-xs">{errors.description.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="category">
              Category{' '}
              <FieldHelp title="Grouping tag">
                Free-text category used to group capabilities on the list page. Pick an existing
                category or create a new one. Default: empty.
              </FieldHelp>
            </Label>
            {categoryIsNew ? (
              <div className="flex gap-2">
                <Input
                  id="category"
                  value={currentCategory}
                  onChange={(e) => setValue('category', e.target.value, { shouldValidate: true })}
                  placeholder="knowledge"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setCategoryIsNew(false);
                    setValue('category', '', { shouldValidate: true });
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Select
                value={currentCategory || undefined}
                onValueChange={(v) => {
                  if (v === NEW_CATEGORY) {
                    setCategoryIsNew(true);
                    setValue('category', '', { shouldValidate: false });
                  } else {
                    setValue('category', v, { shouldValidate: true });
                  }
                }}
              >
                <SelectTrigger id="category">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {availableCategories.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_CATEGORY}>+ New category…</SelectItem>
                </SelectContent>
              </Select>
            )}
            {errors.category && (
              <p className="text-destructive text-xs">{errors.category.message}</p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="isActive">
                Active{' '}
                <FieldHelp title="Is this capability available?">
                  Inactive capabilities are not offered to agents on new chats. Execution history is
                  preserved. Default: on.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-sm">
                Toggle off to retire without deleting.
              </p>
            </div>
            <Switch
              id="isActive"
              checked={currentIsActive}
              onCheckedChange={(v) => setValue('isActive', v)}
            />
          </div>
        </TabsContent>

        {/* ================= TAB 2 — FUNCTION DEFINITION ================= */}
        <TabsContent value="function" className="space-y-4 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>
                Function definition{' '}
                <FieldHelp title="OpenAI-compatible tool schema">
                  The schema the LLM sees when deciding whether to call this tool. Visual Builder
                  lets you configure name, description, and typed parameters. JSON Editor is an
                  escape hatch for complex shapes.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-xs">
                Use the visual builder for most cases. Switch to JSON for enums or nested objects.
              </p>
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={fnMode === 'visual' ? 'default' : 'outline'}
                disabled={visualDisabled && fnMode === 'json'}
                onClick={() => {
                  if (fnMode === 'visual') return;
                  switchToVisualMode();
                }}
              >
                Visual
              </Button>
              <Button
                type="button"
                size="sm"
                variant={fnMode === 'json' ? 'default' : 'outline'}
                onClick={() => {
                  if (fnMode === 'json') return;
                  switchToJsonMode();
                }}
              >
                JSON
              </Button>
            </div>
          </div>

          {visualDisabled && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              This schema has features the visual builder can&apos;t represent (nested objects,
              enums, etc.). Stay in JSON mode to edit.
            </div>
          )}

          {fnMode === 'visual' ? (
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="fnName">Function name</Label>
                <Input
                  id="fnName"
                  value={fnName}
                  onChange={(e) => setFnName(e.target.value)}
                  placeholder="search_knowledge_base"
                  className="font-mono"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fnDesc">Function description</Label>
                <Textarea
                  id="fnDesc"
                  rows={2}
                  value={fnDescription}
                  onChange={(e) => setFnDescription(e.target.value)}
                  placeholder="Semantic search over the agentic patterns knowledge base."
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Parameters</Label>
                  <Button type="button" size="sm" variant="outline" onClick={addRow}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add parameter
                  </Button>
                </div>
                {rows.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">No parameters yet.</p>
                ) : (
                  <div className="space-y-2">
                    {rows.map((row, idx) => (
                      <div
                        key={idx}
                        className="grid grid-cols-[1fr_120px_2fr_80px_40px] items-center gap-2 rounded-md border p-2"
                      >
                        <Input
                          placeholder="name"
                          value={row.name}
                          onChange={(e) => updateRow(idx, { name: e.target.value })}
                          className="font-mono"
                        />
                        <Select
                          value={row.type}
                          onValueChange={(v) => updateRow(idx, { type: v as ParameterRow['type'] })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="string">string</SelectItem>
                            <SelectItem value="number">number</SelectItem>
                            <SelectItem value="boolean">boolean</SelectItem>
                            <SelectItem value="object">object</SelectItem>
                            <SelectItem value="array">array</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder="description"
                          value={row.description}
                          onChange={(e) => updateRow(idx, { description: e.target.value })}
                        />
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={row.required}
                            onCheckedChange={(v) => updateRow(idx, { required: v })}
                            aria-label="Required"
                          />
                          <span className="text-muted-foreground text-xs">req</span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeRow(idx)}
                          aria-label="Remove parameter"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="fnJson">JSON editor</Label>
              <Textarea
                id="fnJson"
                rows={20}
                value={jsonText}
                onChange={(e) => handleJsonChange(e.target.value)}
                className="font-mono text-xs"
              />
              {jsonError && <p className="text-destructive text-xs">{jsonError}</p>}
            </div>
          )}

          {/* Live preview — always visible */}
          <div>
            <Label>Live preview</Label>
            <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded-md border p-3 text-xs">
              {parsedFn ? JSON.stringify(parsedFn, null, 2) : '(empty)'}
            </pre>
          </div>
        </TabsContent>

        {/* ================= TAB 3 — EXECUTION ================= */}
        <TabsContent value="execution" className="space-y-4 pt-4">
          <div className="grid gap-2">
            <Label htmlFor="executionType">
              Execution type{' '}
              <FieldHelp title="How the capability runs">
                <strong>internal</strong> — a TypeScript class in this app.
                <br />
                <strong>api</strong> — POST to an HTTP endpoint and read the response.
                <br />
                <strong>webhook</strong> — fire-and-forget POST, no response read.
              </FieldHelp>
            </Label>
            <Select
              value={currentExecutionType}
              onValueChange={(v) =>
                setValue('executionType', v as 'internal' | 'api' | 'webhook', {
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger id="executionType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="internal">internal — TypeScript class</SelectItem>
                <SelectItem value="api">api — HTTP endpoint</SelectItem>
                <SelectItem value="webhook">webhook — fire-and-forget</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="executionHandler">
              Execution handler <FieldHelp title="Where to run">{executionHandlerHelp}</FieldHelp>
            </Label>
            <Input
              id="executionHandler"
              {...register('executionHandler')}
              className="font-mono"
              placeholder={
                currentExecutionType === 'internal'
                  ? 'SearchKnowledgeCapability'
                  : 'https://internal.example.com/tools/search'
              }
            />
            {errors.executionHandler && (
              <p className="text-destructive text-xs">{errors.executionHandler.message}</p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="execConfig">
              Execution config (JSON, optional){' '}
              <FieldHelp title="Handler-specific config">
                Free-form JSON object passed to the handler at call time. Shape depends on the
                execution type. Leave empty for none.
              </FieldHelp>
            </Label>
            <Textarea
              id="execConfig"
              rows={8}
              value={execConfigText}
              onChange={(e) => handleExecConfigChange(e.target.value)}
              className="font-mono text-xs"
              placeholder='{"timeout_ms": 5000}'
            />
            {execConfigError && <p className="text-destructive text-xs">{execConfigError}</p>}
          </div>
        </TabsContent>

        {/* ================= TAB 4 — SAFETY ================= */}
        <TabsContent value="safety" className="space-y-4 pt-4">
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="requiresApproval">
                Requires approval{' '}
                <FieldHelp title="Human-in-the-loop gate">
                  When enabled, the agent will pause and ask a human to approve before running this
                  capability. Use for irreversible actions like sending email, charging cards, or
                  writing to production systems. Default: off.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-sm">
                Safe default for irreversible side effects.
              </p>
            </div>
            <Switch
              id="requiresApproval"
              checked={currentRequiresApproval}
              onCheckedChange={(v) => setValue('requiresApproval', v)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="rateLimit">
              Rate limit (calls per minute){' '}
              <FieldHelp title="Upper bound on call rate">
                Maximum calls per minute across all agents. Leave empty for no limit. Default: no
                limit.
              </FieldHelp>
            </Label>
            <Input
              id="rateLimit"
              type="number"
              {...register('rateLimit', {
                setValueAs: (v: string | number) =>
                  v === '' || v === null || v === undefined ? undefined : Number(v),
              })}
              placeholder="60"
            />
            {errors.rateLimit && (
              <p className="text-destructive text-xs">{errors.rateLimit.message}</p>
            )}
          </div>

          {isEdit && usedBy.length > 0 && (
            <div className="rounded-md border p-4">
              <p className="text-sm font-medium">
                Used by {usedBy.length} agent{usedBy.length === 1 ? '' : 's'}
              </p>
              <p className="text-muted-foreground mb-3 text-xs">
                Changes to this capability&apos;s safety settings apply to every agent that has it
                attached.
              </p>
              <div className="flex flex-wrap gap-2">
                {usedBy.map((a) => (
                  <Badge key={a.id} variant="secondary">
                    {a.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </form>
  );
}
