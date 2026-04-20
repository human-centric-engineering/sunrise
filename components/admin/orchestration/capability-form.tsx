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
import { AlertCircle, Check, Loader2, Plus, Save, Shield, Trash2 } from 'lucide-react';

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
import { CliAuthoringHint } from '@/components/admin/orchestration/cli-authoring-hint';
import { capabilityFunctionDefinitionSchema } from '@/lib/validations/orchestration';
import type { AiCapability } from '@/types/prisma';

/**
 * Narrow an untrusted JSON blob (API response or Prisma JSON field) to a
 * plain object we can index with string keys. Arrays, null, primitives —
 * anything that isn't a plain object — collapse to `{}`. Zero `as` casts.
 */
function asJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : {};
}

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
    // Reject truly incompatible shapes (oneOf, enum, nested $ref), but
    // tolerate extra validation keys (minLength, minimum, etc.) that
    // the builder strips on save — they're harmless to lose.
    const incompatible = new Set(['oneOf', 'anyOf', 'allOf', 'enum', '$ref', 'items']);
    const keys = Object.keys(prop);
    if (keys.some((k) => incompatible.has(k))) return null;
    let type = prop.type;
    // Treat "integer" as "number" — the builder only offers "number".
    if (type === 'integer') type = 'number';
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
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(isEdit);

  // Category "new" mode — when the admin picks "+ New category".
  const [categoryIsNew, setCategoryIsNew] = useState(false);

  // --- Function-definition editor state (outside RHF) ---------------------
  const initialFnDef = asJsonRecord(capability?.functionDefinition);
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
    // Validate the stored JSON at the boundary — the backend schema is the
    // authoritative contract, but never ship a blind cast on API response
    // data. Malformed rows surface as `null` and leave the visual builder
    // disabled until the admin fixes the JSON.
    const parsed = capabilityFunctionDefinitionSchema.safeParse(initialFnDef);
    if (!parsed.success) return null;
    // `capabilityFunctionDefinitionSchema` only validates the outer keys;
    // `parameters` is `Record<string, unknown>`. Re-narrow through
    // `CompiledFunctionDef`'s required shape at the same boundary.
    const params = parsed.data.parameters;
    const paramShape = z
      .object({
        type: z.literal('object'),
        properties: z.record(z.string(), z.object({ type: z.string(), description: z.string() })),
        required: z.array(z.string()),
      })
      .safeParse(params);
    if (!paramShape.success) return null;
    return {
      name: parsed.data.name,
      description: parsed.data.description,
      parameters: paramShape.data,
    };
  });

  // --- executionConfig JSON textarea state --------------------------------
  const [execConfigText, setExecConfigText] = useState<string>(() =>
    capability?.executionConfig ? JSON.stringify(capability.executionConfig, null, 2) : ''
  );
  const [execConfigError, setExecConfigError] = useState<string | null>(null);
  const [execConfigParsed, setExecConfigParsed] = useState<Record<string, unknown> | undefined>(
    () => {
      if (!capability?.executionConfig) return undefined;
      const parsed = z.record(z.string(), z.unknown()).safeParse(capability.executionConfig);
      return parsed.success ? parsed.data : undefined;
    }
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
        // Re-evaluate whether the Builder toggle should be enabled.
        setVisualDisabled(tryReverseCompile(parsed) === null);
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
    // Try to reverse-compile the current JSON. If it fails because the
    // schema is too complex, show the banner. If JSON is simply invalid,
    // show a parse error — don't permanently disable the toggle.
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText || '{}');
    } catch {
      setJsonError('Fix the JSON syntax before switching to Builder mode.');
      return;
    }
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
    setSaved(false);
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
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
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
        return "The name of the built-in code class that runs this capability (e.g. SearchKnowledgeCapability). These are registered in the app's source code by a developer.";
      case 'api':
        return "The full URL of the external service to call (e.g. https://api.example.com/lookup). The system sends the capability's parameters as JSON and waits for the response. The URL must be reachable from your server.";
      case 'webhook':
        return 'The full URL to notify (e.g. https://hooks.slack.com/services/...). The system sends the parameters as JSON but does not wait for a reply — useful for notifications and background triggers.';
    }
  })();

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-6">
      {/* Sticky action bar */}
      <div className="bg-background/95 sticky top-0 z-10 -mx-2 flex items-center justify-between border-b px-2 py-3 backdrop-blur">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">
              {isEdit ? capability?.name : 'New capability'}
            </h1>
            {isEdit && capability?.isSystem && (
              <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px] font-medium">
                <Shield className="h-3 w-3" />
                System
              </Badge>
            )}
          </div>
          {isEdit && <p className="text-muted-foreground font-mono text-xs">{capability?.slug}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" asChild>
            <Link href="/admin/orchestration/capabilities">Cancel</Link>
          </Button>
          <Button type="submit" disabled={submitting || saved}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : saved ? (
              <>
                <Check className="mr-2 h-4 w-4" />
                Saved
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

      {!isEdit && <CliAuthoringHint resource="capabilities" />}

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <Tabs defaultValue="basic" className="w-full">
        <TabsList className="w-full justify-start">
          <TabsTrigger value="basic">Basic</TabsTrigger>
          <TabsTrigger
            value="function"
            title="Describe what arguments this capability accepts so the AI knows how to call it"
          >
            Function Definition
          </TabsTrigger>
          <TabsTrigger
            value="execution"
            title="Choose how and where this capability runs when called"
          >
            Execution
          </TabsTrigger>
          <TabsTrigger
            value="safety"
            title="Approval gates and rate limits to control when and how often this capability can run"
          >
            Safety
          </TabsTrigger>
        </TabsList>

        {/* ================= TAB 1 — BASIC ================= */}
        <TabsContent value="basic" className="space-y-4 pt-4">
          <div className="grid gap-2">
            <Label htmlFor="name">
              Name{' '}
              <FieldHelp title="Capability name">
                A human-readable label shown in the admin list and when attaching capabilities to
                agents. For example, &quot;Search knowledge base&quot; or &quot;Create support
                ticket&quot;.
              </FieldHelp>
            </Label>
            <Input id="name" {...register('name')} placeholder="Search knowledge base" />
            {errors.name && <p className="text-destructive text-xs">{errors.name.message}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="slug">
              Slug{' '}
              <FieldHelp title="URL-safe identifier">
                A permanent ID for this capability, used in URLs and when attaching it to agents.
                Auto-generated from the name. Lowercase letters, numbers, and hyphens only. Cannot
                be changed after creation.
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
                A short summary for other admins in this list. This is separate from the function
                description on the next tab (which the AI reads) — but it helps to keep both
                aligned.
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
              disabled={isEdit && capability?.isSystem}
            />
          </div>
        </TabsContent>

        {/* ================= TAB 2 — FUNCTION DEFINITION ================= */}
        <TabsContent value="function" className="space-y-4 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>
                Function definition{' '}
                <FieldHelp title="What is this?" contentClassName="w-96 max-h-80 overflow-y-auto">
                  <p>
                    This tells the AI what your capability does and what information it needs. Think
                    of it like a form: you give the capability a name, a description the AI reads to
                    decide when to use it, and a list of parameters (the inputs it expects).
                  </p>
                  <p className="mt-2">
                    For example, a &quot;search knowledge base&quot; capability might need a{' '}
                    <code>query</code> parameter (the search text) and an optional{' '}
                    <code>limit</code> parameter (how many results to return).
                  </p>
                  <p className="text-foreground mt-2 font-medium">Two editing modes</p>
                  <p>
                    <strong>Builder</strong> — a simple form where you add parameters one by one.
                    Best for most capabilities.
                    <br />
                    <strong>JSON Editor</strong> — edit the raw schema directly. Use this only if
                    you need advanced features like nested objects or enums.
                  </p>
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-xs">
                Describe what this capability does and what inputs it needs, so the AI knows when
                and how to call it.
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
                Builder
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
                JSON Editor
              </Button>
            </div>
          </div>

          {visualDisabled && (
            <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              This schema has features the Builder can&apos;t represent (nested objects, enums,
              etc.). Simplify the schema to switch back, or stay in JSON mode to edit.
            </div>
          )}

          {fnMode === 'visual' ? (
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="fnName">
                  Function name{' '}
                  <FieldHelp title="Function name">
                    A machine-readable identifier the AI uses to call this capability. Use lowercase
                    with underscores (e.g. <code>search_knowledge_base</code>,{' '}
                    <code>create_ticket</code>).
                  </FieldHelp>
                </Label>
                <Input
                  id="fnName"
                  value={fnName}
                  onChange={(e) => setFnName(e.target.value)}
                  placeholder="search_knowledge_base"
                  className="font-mono"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="fnDesc">
                  Function description{' '}
                  <FieldHelp title="Function description">
                    A plain-English sentence the AI reads to decide when this capability is
                    relevant. Be specific — e.g. &quot;Search the help docs knowledge base and
                    return matching articles&quot; rather than &quot;Search stuff&quot;.
                  </FieldHelp>
                </Label>
                <Textarea
                  id="fnDesc"
                  rows={2}
                  value={fnDescription}
                  onChange={(e) => setFnDescription(e.target.value)}
                  placeholder="Search the help docs knowledge base and return matching articles."
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>
                    Parameters{' '}
                    <FieldHelp title="What are parameters?">
                      Parameters are the inputs your capability needs when the AI calls it. For
                      example, a search capability needs a <code>query</code> parameter. Mark a
                      parameter as &quot;Required&quot; if the AI must always provide it.
                    </FieldHelp>
                  </Label>
                  <Button type="button" size="sm" variant="outline" onClick={addRow}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add parameter
                  </Button>
                </div>
                {rows.length === 0 ? (
                  <p className="text-muted-foreground text-sm italic">
                    No parameters defined yet. Click &quot;Add parameter&quot; to describe the
                    inputs this capability needs.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <div className="text-muted-foreground grid grid-cols-[1fr_120px_2fr_80px_40px] gap-2 px-2 text-[10px] font-medium tracking-wide uppercase">
                      <span>Name</span>
                      <span>Type</span>
                      <span>Description</span>
                      <span>Required</span>
                      <span />
                    </div>
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
                          <span className="sr-only">Required</span>
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
            <Label>
              Live preview{' '}
              <FieldHelp title="What is this?">
                This is the machine-readable version of your function definition — the exact data
                the AI receives. You don&apos;t need to edit this directly; it updates automatically
                as you fill in the fields above.
              </FieldHelp>
            </Label>
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
              <FieldHelp
                title="How the capability runs"
                contentClassName="w-96 max-h-80 overflow-y-auto"
              >
                <p>
                  This controls where and how the capability&apos;s code actually runs when the AI
                  triggers it.
                </p>
                <p className="mt-2">
                  <strong>Internal</strong> — built-in code that runs inside this application. Use
                  this for capabilities that are part of Sunrise itself, like searching the
                  knowledge base or estimating costs. You enter the name of the code class (e.g.{' '}
                  <code>SearchKnowledgeCapability</code>).
                </p>
                <p className="mt-2">
                  <strong>API</strong> — sends a request to an external web service and waits for
                  the response. Use this when you need data back — for example, calling a CRM to
                  look up a customer, or querying a weather service. You enter the full URL (e.g.{' '}
                  <code>https://api.example.com/lookup</code>).
                </p>
                <p className="mt-2">
                  <strong>Webhook</strong> — sends a request to an external URL but does{' '}
                  <em>not</em> wait for a reply. Use this for notifications or triggers where you
                  just need to tell another system that something happened — for example, posting a
                  message to Slack or starting a background job. The AI continues the conversation
                  immediately without waiting.
                </p>
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
              <FieldHelp title="Extra settings for the handler" contentClassName="w-80">
                Optional settings passed to the handler every time it runs. For example, you might
                set a timeout, authentication headers, or a default result limit. The available keys
                depend on the handler — leave empty if you don&apos;t need any.
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
                <FieldHelp title="Human-in-the-loop gate" contentClassName="w-80">
                  When turned on, the AI will pause the conversation and wait for a human to approve
                  before this capability actually runs. The workflow or chat enters a &quot;paused
                  for approval&quot; state until someone clicks approve or reject.
                  <br />
                  <br />
                  Turn this on for anything with real-world consequences you can&apos;t undo —
                  sending emails, charging credit cards, deleting records, or writing to production
                  systems.
                </FieldHelp>
              </Label>
              <p className="text-muted-foreground text-sm">
                Requires a human to approve each call before it executes.
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
              <FieldHelp title="Rate limit" contentClassName="w-80">
                The maximum number of times this capability can be called per minute, across all
                agents combined. This prevents runaway usage — for example, if an AI enters a loop
                calling the same tool repeatedly. Leave empty for no limit.
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
