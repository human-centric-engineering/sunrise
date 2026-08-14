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
import { AlertCircle, Check, Info, Loader2, Plus, Save, Shield, Trash2 } from 'lucide-react';

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
import { jsonEquals } from '@/lib/utils/json-equal';
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

/**
 * Build the form schema for a mode.
 *
 * The only field that differs is `slug`, and it differs because **the slug is
 * not editable or submitted in edit mode** — the input is `disabled` and the
 * PATCH payload omits it. Validating it strictly there judges a stored value
 * the admin cannot change, and refuses the whole save over it, with the error
 * rendered under a disabled field on a tab they may not even be on.
 *
 * Two ways a stored slug fails the create rules: it can be 65–100 chars
 * (creatable before the #509 cap), or it can use a charset the old
 * `^[a-z0-9-]+$` allowed but the new one does not (`my--cap`, `-cap`, `cap-`)
 * — reachable from a backup import, a `registerAppCapability(cap, { slug })`
 * row, or a direct insert, none of which pass through these schemas.
 *
 * So: strict on create, presence-only on edit.
 */
function makeCapabilityFormSchema(mode: 'create' | 'edit') {
  return z
    .object({
      name: z.string().min(1, 'Name is required').max(100),
      // Mirrors `capabilitySlugSchema` on the server — keep the two identical.
      // Underscores are allowed here and nowhere else, because a capability slug
      // is also the LLM tool name (#509).
      slug:
        mode === 'edit'
          ? z.string().min(1, 'Slug is required')
          : z
              .string()
              .min(1, 'Slug is required')
              .max(64, 'Slug must be at most 64 characters')
              .regex(
                /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/,
                'Lowercase letters and numbers, separated by underscores or hyphens'
              ),
      description: z.string().min(1, 'Description is required').max(5000),
      category: z.string().min(1, 'Category is required').max(50),
      executionType: z.enum(['internal', 'api', 'webhook']),
      executionHandler: z.string().min(1, 'Execution handler is required').max(500),
      requiresApproval: z.boolean(),
      approvalTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(3_600_000, 'Must be at most 3,600,000 ms (1 hour)')
        .nullable()
        .optional(),
      rateLimit: z.number().int().min(1).max(10000).optional(),
      isActive: z.boolean(),
    })
    .superRefine((data, ctx) => {
      if (
        (data.executionType === 'api' || data.executionType === 'webhook') &&
        data.executionHandler
      ) {
        try {
          new URL(data.executionHandler);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Must be a valid URL for api and webhook types',
            path: ['executionHandler'],
          });
        }
      }
    });
}

type CapabilityFormData = z.infer<ReturnType<typeof makeCapabilityFormSchema>>;

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

/**
 * Derive a capability slug from a display name.
 *
 * Underscore-separated, unlike slugs elsewhere in the admin: a capability slug
 * is also the tool name advertised to the LLM (#509), and every built-in uses
 * the underscore convention tool names conventionally take
 * (`search_knowledge_base`). Hyphens remain valid — `capabilitySlugSchema`
 * accepts both — this only picks the default.
 */
function toSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s_-]/g, '')
      .replace(/[\s-]+/g, '_')
      .replace(/_+/g, '_')
      // 64, matching the provider tool-name cap the slug now has to satisfy.
      .slice(0, 64)
      // Trim separators at BOTH ends. A leading one is reachable from a
      // display name starting with `_`/`-`, or with punctuation that strips to
      // nothing ("_Internal Ping" → `_internal_ping`), and the slug regex
      // rejects it — invisibly, because the auto-slug effect sets the value
      // with `shouldValidate: false`, so the admin only finds out at submit.
      .replace(/^[_-]+|[_-]+$/g, '')
  );
}

/**
 * What the form holds for a function definition: the validated wire shape,
 * with `parameters` left as stored.
 *
 * Deliberately wider than {@link CompiledFunctionDef}. A stored definition may
 * use `enum`, `items`, nested objects — anything the JSON-Schema subset the
 * providers accept allows — and narrowing it to the visual builder's shape
 * strips those keys, because Zod drops unknown ones. `CompiledFunctionDef` is
 * only the shape the builder *produces*, and it satisfies this type.
 */
type FunctionDefinitionState = z.infer<typeof capabilityFunctionDefinitionSchema>;

interface CompiledFunctionDef {
  name: string;
  description: string;
  parameters: Record<string, unknown> & {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * The stored spec the builder is editing, so a compile can put back what it
 * never showed. Keyed by parameter name; values are the raw property objects.
 */
export interface CompileBaseline {
  /** Everything on `parameters` except `type`/`properties`/`required`. */
  parametersExtras: Record<string, unknown>;
  /** The original per-property objects, by parameter name. */
  properties: Record<string, Record<string, unknown>>;
}

/**
 * Should the stored property's extra keywords survive an edit to this row?
 *
 * Only when the row still describes the same kind of value. `minLength` on a
 * field the admin just switched from string to number is not a constraint, it
 * is nonsense — so a deliberate type change drops the extras, which is the one
 * case where losing them is the admin's own visible choice.
 *
 * `integer` is the exception that makes the rule work: the builder has no such
 * option, so `tryReverseCompile` shows integers as `number`. Treating that as
 * "unchanged" is what stops a save silently widening
 * `pattern_number: integer` to `number` — and it keeps the original `integer`
 * rather than the row's approximation of it.
 */
function keepsStoredKeywords(storedType: unknown, rowType: string): boolean {
  if (storedType === rowType) return true;
  return storedType === 'integer' && rowType === 'number';
}

/**
 * Build the wire shape from the builder's rows, preserving everything in the
 * stored spec that the builder cannot represent.
 *
 * The builder's model is four fields per parameter — name, type, description,
 * required — while a stored spec may carry bounds, formats, enums and nested
 * shapes. Rebuilding each parameter from the row alone therefore deleted
 * whatever had no slot in that model, which is how editing one description
 * used to strip `minimum`/`maximum` off a neighbouring field. Merging over the
 * stored property instead means an edit changes what was edited and nothing
 * else.
 */
function compileFunctionDefinition(
  fnName: string,
  fnDescription: string,
  rows: ParameterRow[],
  baseline: CompileBaseline = { parametersExtras: {}, properties: {} }
): CompiledFunctionDef {
  const properties: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row.name) continue;
    const stored = baseline.properties[row.name];
    properties[row.name] =
      stored && keepsStoredKeywords(stored.type, row.type)
        ? // Stored keywords ride along; the builder owns only these two, and
          // `type` stays as stored so `integer` is not widened to `number`.
          { ...stored, type: stored.type, description: row.description }
        : { type: row.type, description: row.description };
  }
  const required = rows.filter((r) => r.required && r.name).map((r) => r.name);
  return {
    name: fnName,
    description: fnDescription,
    // Keywords on `parameters` itself — `additionalProperties`, `$schema` —
    // are preserved for the same reason as the per-property ones.
    parameters: { ...baseline.parametersExtras, type: 'object', properties, required },
  };
}

/** Pull the compile baseline out of a stored function definition. */
function toCompileBaseline(fnDef: Record<string, unknown>): CompileBaseline {
  const params = asJsonRecord(fnDef.parameters);
  const { type: _type, properties: rawProps, required: _required, ...parametersExtras } = params;
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(asJsonRecord(rawProps))) {
    properties[name] = asJsonRecord(value);
  }
  return { parametersExtras, properties };
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
    // Reject shapes the builder cannot show at all (oneOf, enum, nested $ref,
    // items) — those open in JSON mode. Extra validation keywords
    // (minLength, minimum, format, …) are tolerated here because they no
    // longer have to be lost: `compileFunctionDefinition` merges over the
    // stored property, so they survive an edit to the row's description. The
    // comment that used to sit here called them "harmless to lose", which was
    // never true — losing `minimum`/`maximum` on `pattern_number` widens what
    // the model is allowed to send.
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

/**
 * The function-definition state a mounted form starts from: the stored
 * definition, validated, with its `name` normalised to the slug and nothing
 * else touched. `null` only when there is genuinely nothing to edit.
 *
 * Module-level and pure so `parsedFn` and `jsonText` can be seeded from the
 * SAME value — they were computed separately and disagreed on load.
 */
function initialFunctionState(
  initialFnDef: Record<string, unknown>,
  slugForName: string
): FunctionDefinitionState | null {
  if (Object.keys(initialFnDef).length === 0) return null;
  // A reverse-compilable definition used to be run straight back through
  // `compileFunctionDefinition` here, which is the builder's LOSSY
  // rendering — `tryReverseCompile` tolerates `minimum`/`maxLength`/`format`
  // and maps `integer` to `number`, none of which survive the round trip. So
  // the stored definition was already replaced before the form even
  // rendered, and an untouched Save wrote the degraded copy back: the seeded
  // `get_pattern_detail` lost its 1–999 bounds and had `integer` widened to
  // `number`, letting a model emit 1.5 for a pattern number.
  //
  // `rows` is still seeded from the reverse-compile — the builder UI needs
  // it — but `parsedFn` holds what is stored until the admin actually edits
  // something, at which point the recompile effect takes over and the loss
  // is a choice they made.
  //
  // Validate the stored JSON at the boundary — the backend schema is the
  // authoritative contract, but never ship a blind cast on API response
  // data. Malformed rows surface as `null` and leave the visual builder
  // disabled until the admin fixes the JSON.
  //
  // `parameters` is kept EXACTLY as stored. It used to be re-narrowed
  // through the visual builder's shape
  // (`properties: record(object({ type, description }))`), and Zod strips
  // unknown keys — so `enum`, `items`, `minLength` and every nested schema
  // silently vanished from `parsedFn`, and an untouched Save wrote the
  // stripped copy back. Every seeded capability carries at least one of
  // those. A definition the builder cannot represent also came back `null`,
  // which in JSON mode meant the form refused to save at all, blaming a
  // missing function name.
  //
  // Only `compileFunctionDefinition` — the builder's own output — needs the
  // narrow shape. What the form holds for an arbitrary stored definition is
  // the wider validated one.
  const parsed = capabilityFunctionDefinitionSchema.safeParse(initialFnDef);
  // Spread for the same reason as the JSON path: keep top-level keys the
  // schema doesn't name, since the API accepts them.
  if (parsed.success) {
    // Normalise the NAME to the slug, and only the name. A stored row whose
    // `functionDefinition.name` diverges from its slug is exactly what #509
    // forbids going forward, and the form's Function-name field already
    // claims to mirror the slug — so loading one and leaving the stale name
    // in `parsedFn` made the save fail its own client check, locking the
    // admin out of a row nothing else lets them repair.
    //
    // Repairing one field beats recompiling: everything else in the stored
    // definition is carried through untouched, so an otherwise-unedited save
    // fixes the divergence and changes nothing else.
    return { ...initialFnDef, ...parsed.data, ...(slugForName ? { name: slugForName } : {}) };
  }

  // Not parseable as-is. Before the mount compile was removed, that compile
  // repaired the state and the save went through; without it, `parsedFn`
  // stayed null and the submit guard refused with "Function definition
  // requires at least a function name" — blocking the admin from editing the
  // description, rate limit or active flag either. `parameters` and
  // `description` were optional on create until this release (the documented
  // example omitted `parameters`), so rows in that shape exist.
  //
  // Fill in only what is missing. Anything already stored is kept, so this
  // repairs without inventing.
  // No usable stored name. `slugForName` is known in edit mode and is what
  // the name must be anyway, so seed from it rather than returning null —
  // null left the submit guard refusing with "requires at least a function
  // name" while the read-only field on screen displayed that very name, and
  // blocked the admin from touching the description, rate limit or active
  // flag either. Reachable from a backup import or a direct insert, since
  // the column is required but its contents are not validated on the way in.
  const storedName = typeof initialFnDef.name === 'string' ? initialFnDef.name : '';
  if (!storedName && !slugForName) return null;
  return {
    ...initialFnDef,
    name: slugForName || storedName,
    description: typeof initialFnDef.description === 'string' ? initialFnDef.description : '',
    parameters: asJsonRecord(initialFnDef.parameters),
  };
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

  // Seeded from the SLUG, not the stored `functionDefinition.name`. The two must
  // be equal (#509), and seeding from the stored name meant that on a legacy
  // divergent row the mirror effect changed `fnName` on mount — which
  // re-triggered the recompile the mount-skip exists to prevent, and rewrote
  // the definition on a save the admin had not touched. Precisely the rows the
  // runtime backstop exists for.
  const [fnName, setFnName] = useState<string>(capability?.slug ?? '');
  const [fnDescription, setFnDescription] = useState<string>(
    typeof initialFnDef.description === 'string' ? initialFnDef.description : ''
  );
  const [rows, setRows] = useState<ParameterRow[]>(initialRows);
  // Pre-existing, fixed here because this PR narrowed its escape route: when
  // the stored definition cannot be reverse-compiled, the form used to open in
  // Visual mode anyway, and the recompile effect immediately overwrote
  // `parsedFn` with empty `properties`/`required` — so opening the edit page
  // for a capability with enums or nested objects (the seeded
  // `call_external_api`, for one) and pressing Save silently destroyed its
  // schema, while the banner told the admin to stay in a JSON mode the form
  // was not in. Open in the mode that can actually represent the data.
  const initialVisualDisabled =
    initialRows.length === 0 && Object.keys(initialFnDef).length > 0
      ? tryReverseCompile(initialFnDef) === null
      : false;
  const [fnMode, setFnMode] = useState<'visual' | 'json'>(
    initialVisualDisabled ? 'json' : 'visual'
  );
  const [visualDisabled, setVisualDisabled] = useState<boolean>(initialVisualDisabled);
  // The slug a loaded definition's name is normalised to. Empty on create,
  // where there is no stored row and the mirror effect owns the name.
  const slugForName = capability?.slug ?? '';
  const initialParsedFn = useMemo(
    () => initialFunctionState(initialFnDef, slugForName),
    [initialFnDef, slugForName]
  );

  // Seeded from the SAME normalised value `parsedFn` holds, not the raw stored
  // definition. They diverged for a legacy row opening in JSON mode: the
  // textarea showed the old `functionDefinition.name` while the payload
  // carried the slug, so the preview contradicted the editor — and touching
  // the textarea reverted the normalisation and got the save refused for a
  // field the admin never edited.
  const [jsonText, setJsonText] = useState<string>(() =>
    initialParsedFn ? JSON.stringify(initialParsedFn, null, 2) : ''
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [parsedFn, setParsedFn] = useState<FunctionDefinitionState | null>(() => initialParsedFn);

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

  // --- metadata JSON textarea state ----------------------------------------
  const [metadataText, setMetadataText] = useState<string>(() =>
    capability?.metadata ? JSON.stringify(capability.metadata, null, 2) : ''
  );
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [metadataParsed, setMetadataParsed] = useState<
    Record<string, string | number | boolean | null> | undefined
  >(() => {
    if (!capability?.metadata) return undefined;
    const parsed = z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .safeParse(capability.metadata);
    return parsed.success ? parsed.data : undefined;
  });
  const metadataTimerRef = useRef<NodeJS.Timeout | null>(null);

  const execConfigTimerRef = useRef<NodeJS.Timeout | null>(null);
  const jsonTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (execConfigTimerRef.current) clearTimeout(execConfigTimerRef.current);
      if (jsonTimerRef.current) clearTimeout(jsonTimerRef.current);
      if (metadataTimerRef.current) clearTimeout(metadataTimerRef.current);
    };
  }, []);

  // Mode never changes for a mounted form; memoised so the resolver identity
  // is stable across renders.
  const capabilityFormSchema = useMemo(() => makeCapabilityFormSchema(mode), [mode]);

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
      approvalTimeoutMs: capability?.approvalTimeoutMs ?? null,
      rateLimit: capability?.rateLimit ?? undefined,
      isActive: capability?.isActive ?? true,
    },
  });

  const currentName = watch('name');
  const currentSlug = watch('slug');
  const currentExecutionType = watch('executionType');
  const currentIsActive = watch('isActive');
  const currentRequiresApproval = watch('requiresApproval');
  const currentCategory = watch('category');

  // Auto-slug from name until user edits slug.
  useEffect(() => {
    if (isEdit || slugTouched) return;
    if (currentName) setValue('slug', toSlug(currentName), { shouldValidate: false });
  }, [currentName, slugTouched, isEdit, setValue]);

  // Keep the function-definition `name` equal to the slug — the API rejects
  // any capability where they differ (#509), because dispatch resolves the tool
  // name a model emits AS the slug.
  //
  // This used to derive from the display NAME rather than the slug (despite a
  // comment saying otherwise), which produced `search-web` / `search_web` from
  // the same typing and made every default-valued create diverge.
  useEffect(() => {
    setFnName(currentSlug ?? '');
  }, [currentSlug]);

  // Recompile the function definition whenever the visual builder inputs change
  // — but NOT on mount.
  //
  // The builder is lossy by construction: `compileFunctionDefinition` emits
  // `{ type, description }` per property, while `tryReverseCompile` deliberately
  // tolerates `minimum`, `maxLength`, `format` and maps `integer` → `number`.
  // That is a fair trade once an admin edits a parameter — they are choosing the
  // builder's expressiveness. It is not a fair trade for merely OPENING the
  // page: this effect used to fire on mount and overwrite `parsedFn`, so
  // pressing Save without touching anything rewrote the stored schema. The
  // seeded `get_pattern_detail` lost `minimum`/`maximum` and had `integer`
  // degraded to `number` — which lets a model emit `1.5` for a pattern number.
  //
  // Skipping the first run is what makes an untouched save a no-op. #509 fixed
  // the sibling case (definitions the builder cannot represent at all); this is
  // the one it left behind, and both were only unreachable before because the
  // hyphen-only slug regex blocked submit on every seeded capability.
  // What the builder is editing ON TOP OF. Seeded from the stored definition
  // and refreshed whenever the JSON editor supplies a new one, so a
  // JSON → Builder → save round trip preserves the JSON's extras too.
  const compileBaselineRef = useRef<CompileBaseline>(toCompileBaseline(initialFnDef));

  // Mirrors `jsonText` so `flushPendingJson` can read the latest editor
  // contents synchronously, without depending on a state update.
  const jsonTextRef = useRef<string>(
    initialParsedFn ? JSON.stringify(initialParsedFn, null, 2) : ''
  );

  const skipInitialCompile = useRef(true);
  useEffect(() => {
    // Consume the flag BEFORE the mode guard. It was consumed after, so a form
    // opening in JSON mode (any definition with an `enum`/`items`) returned
    // early with the flag still armed — and then swallowed the first compile
    // after the admin entered Builder mode. "Reset to Builder" emptied the
    // parameters table on screen while the save still carried the original
    // definition: the UI and the payload disagreed, and the button appeared to
    // do nothing.
    const isFirstRun = skipInitialCompile.current;
    skipInitialCompile.current = false;
    if (fnMode !== 'visual') return;
    if (isFirstRun) return;
    const compiled = compileFunctionDefinition(
      fnName,
      fnDescription,
      rows,
      compileBaselineRef.current
    );
    setParsedFn(compiled);
    setJsonText(JSON.stringify(compiled, null, 2));
    setJsonError(null);
  }, [fnName, fnDescription, rows, fnMode]);

  /**
   * Parse the JSON editor's contents into form state, synchronously.
   *
   * Returns the value written, or the error that stopped it, so a caller that
   * needs the result NOW — submit — can use it without waiting for a state
   * update it will not see in the same tick.
   */
  const applyJsonText = (
    value: string
  ): { ok: true; value: FunctionDefinitionState } | { ok: false; message: string } => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object') throw new Error('Not an object');
      // Check the whole shape, not just `name`. `description` and
      // `parameters` are required by the API (#509) — a write replaces the
      // JSON column wholesale, so a partial definition discards the rest —
      // and checking only `name` here meant `{"name": "foo"}` sailed through
      // every client check to come back as a bare 400.
      const shape = capabilityFunctionDefinitionSchema.safeParse(parsed);
      if (!shape.success) {
        throw new Error(
          `A function definition needs "name", "description" and "parameters" (${shape.error.issues
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; ')})`
        );
      }
      // Spread the raw object under the validated fields so top-level keys
      // the schema doesn't name survive. `capabilityFunctionDefinitionSchema`
      // is a plain `z.object` and drops unknown keys, but the server's
      // create/update schemas are `.passthrough()` — so narrowing here would
      // make the client stricter than the API it defers to, silently deleting
      // e.g. `strict: true` from a definition the admin pasted and can still
      // see in the textarea.
      const next = { ...asJsonRecord(parsed), ...shape.data };
      // The JSON the admin just wrote becomes what a later Builder edit
      // merges over — otherwise switching to Builder would strip it again.
      compileBaselineRef.current = toCompileBaseline(next);
      setParsedFn(next);
      setJsonError(null);
      // Re-evaluate whether the Builder toggle should be enabled.
      setVisualDisabled(tryReverseCompile(parsed) === null);
      return { ok: true, value: next };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid JSON';
      setJsonError(message);
      return { ok: false, message };
    }
  };

  /**
   * Run a pending JSON parse NOW instead of waiting out its debounce.
   *
   * Cancelling was the wrong remedy and shipped as one: a switch or a submit
   * inside the 200 ms window threw away edits the admin could still see in the
   * textarea. On submit that was worse than losing them — the save used the
   * previous value, reported "Saved", and then the stale timer wrote the
   * unsaved JSON back into state, leaving the admin looking at edits marked as
   * persisted that never were.
   *
   * Returns `null` when nothing was pending.
   */
  const flushPendingJson = ():
    { ok: true; value: FunctionDefinitionState } | { ok: false; message: string } | null => {
    if (!jsonTimerRef.current) return null;
    clearTimeout(jsonTimerRef.current);
    jsonTimerRef.current = null;
    return applyJsonText(jsonTextRef.current);
  };

  // JSON editor → parsed state (debounced).
  const handleJsonChange = (value: string) => {
    setJsonText(value);
    jsonTextRef.current = value;
    if (jsonTimerRef.current) clearTimeout(jsonTimerRef.current);
    jsonTimerRef.current = setTimeout(() => {
      jsonTimerRef.current = null;
      applyJsonText(value);
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

  // metadata JSON editor (debounced).
  const handleMetadataChange = (value: string) => {
    setMetadataText(value);
    if (metadataTimerRef.current) clearTimeout(metadataTimerRef.current);
    metadataTimerRef.current = setTimeout(() => {
      if (value.trim() === '') {
        setMetadataParsed(undefined);
        setMetadataError(null);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Must be a JSON object');
        }
        const entries = Object.entries(parsed as Record<string, unknown>);
        if (entries.length > 100) {
          throw new Error('Maximum 100 keys allowed');
        }
        for (const [key, val] of entries) {
          if (
            typeof val !== 'string' &&
            typeof val !== 'number' &&
            typeof val !== 'boolean' &&
            val !== null
          ) {
            throw new Error(`Value for "${key}" must be a string, number, boolean, or null`);
          }
        }
        setMetadataParsed(parsed as Record<string, string | number | boolean | null>);
        setMetadataError(null);
      } catch (err) {
        setMetadataError(err instanceof Error ? err.message : 'Invalid JSON');
      }
    }, 200);
  };

  const switchToJsonMode = () => {
    // Land any pending JSON parse BEFORE switching. Cancelling (the first
    // attempt at this) threw away edits still visible in the textarea; leaving
    // it pending let the stale timer land after the builder had recompiled and
    // reset the merge baseline under it. Flushing does neither.
    flushPendingJson();

    // Serialize the current compiled JSON into the textarea.
    if (parsedFn) setJsonText(JSON.stringify(parsedFn, null, 2));
    setFnMode('json');
  };

  const switchToVisualMode = () => {
    // Land any pending JSON parse BEFORE switching. Cancelling (the first
    // attempt at this) threw away edits still visible in the textarea; leaving
    // it pending let the stale timer land after the builder had recompiled and
    // reset the merge baseline under it. Flushing does neither.
    flushPendingJson();

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
    // `fnName` is NOT taken from the JSON. In Builder mode it mirrors the slug
    // (#509), and the field is read-only under a hint that says so — adopting a
    // hand-edited JSON `name` here would display a value the label denies and,
    // in edit mode (slug disabled, name read-only), leave no way to correct it
    // without going back to JSON.
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
    // Land a pending JSON parse first, and use its RESULT — `setParsedFn` will
    // not have taken effect by the next line. Without this, saving inside the
    // 200 ms window persisted the previous definition, said "Saved", and then
    // let the timer write the unsaved JSON back into state.
    const flushed = flushPendingJson();
    if (flushed && !flushed.ok) {
      setError(`Function definition JSON is not valid: ${flushed.message}`);
      return;
    }
    const effectiveFn = flushed?.ok ? flushed.value : parsedFn;

    if (!effectiveFn?.name) {
      setError('Function definition requires at least a function name.');
      return;
    }
    if (execConfigError) {
      setError('Execution config is not valid JSON. Fix the editor first.');
      return;
    }
    // Gate on the FLUSH, not on `jsonError`. That state is a stale closure
    // value here: fixing invalid JSON and saving within the debounce window
    // flushed successfully and cleared the error, but this still read the old
    // one and refused the save with a message the editor contradicted. A
    // pending parse that failed already returned above; only a pre-existing
    // error with nothing pending can still block.
    if (!flushed && jsonError) {
      setError('Function definition JSON is not valid. Fix the editor first.');
      return;
    }
    if (metadataError) {
      setError('Metadata is not valid JSON. Fix the editor first.');
      return;
    }
    // The API refuses a definition whose `name` differs from the slug (#509).
    // Builder mode cannot produce one — the field mirrors the slug — but the
    // JSON editor can, and so can the reverse: authoring JSON and then editing
    // the display name, which regenerates the slug underneath it. Say so here
    // rather than letting a bare 400 come back from the server.
    if (effectiveFn.name !== data.slug) {
      setError(
        `The function name must match the slug. The Function tab says "${effectiveFn.name}", ` +
          `the slug is "${data.slug}" — a capability is looked up by the name the AI emits, ` +
          `so the two cannot differ.`
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      const payload = {
        ...data,
        functionDefinition: effectiveFn,
        executionConfig: execConfigParsed,
        metadata: metadataParsed,
      };
      if (isEdit && capability) {
        // The slug is immutable after creation — the input is disabled in edit
        // mode — so sending it back is at best a no-op. It is dropped because
        // it stopped being harmless: the server caps new slugs at 64, so
        // echoing a longer legacy slug would fail validation and leave the
        // capability uneditable through a field the admin cannot change.
        const { slug: _unusedSlug, functionDefinition, ...operatorOwned } = payload;
        // Same reasoning one field further, but conditionally. On a system row
        // the seeds own `functionDefinition` and the API 403s a write that
        // CHANGES it (#598) — and what this form holds is not the stored value:
        // `initialFunctionState` normalises it on load, forcing `name` to the
        // slug, replacing a non-string `description` with `''` and coercing
        // `parameters`. A stored definition that does not already match that
        // normalisation therefore arrives DIFFERENT from a save that only
        // touched the description, and the 403 names `functionDefinition` —
        // the one field the operator has no way to fix here, leaving the row
        // uneditable.
        //
        // So omit it, but ONLY when the operator did not touch it:
        // `initialParsedFn` is exactly what the form loaded, so an untouched
        // save compares equal to it. A real edit is still sent, and still
        // refused by the API with a message saying why. Omitting it
        // unconditionally would be worse than the bug — it would silently
        // discard a deliberate edit and report "Saved".
        const editPayload =
          capability.isSystem && jsonEquals(functionDefinition, initialParsedFn)
            ? operatorOwned
            : { ...operatorOwned, functionDefinition };
        await apiClient.patch<AiCapability>(API.ADMIN.ORCHESTRATION.capabilityById(capability.id), {
          body: editPayload,
        });
        reset(data);
        // The saved definition becomes the new baseline. Without this, deleting
        // a parameter and re-adding one with the same name and type in the same
        // session silently re-attached the deleted one's keywords.
        compileBaselineRef.current = toCompileBaseline(effectiveFn);
        // Reset non-RHF state to match what was saved
        setMetadataText(metadataParsed ? JSON.stringify(metadataParsed, null, 2) : '');
        setMetadataError(null);
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
                <FieldHelp title="System capability">
                  System capabilities are seeded from code and cannot be deleted or deactivated.
                  Four fields are owned by the seed and are refused if you change them: slug,
                  function definition, execution type and execution handler. Everything else — name,
                  description, category, rate limit, approval and execution config — is yours to
                  edit and is never overwritten by a deployment.
                </FieldHelp>
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

      {isEdit && capability?.isSystem && (
        <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-950/20 dark:text-blue-300">
          <Info className="h-4 w-4 shrink-0" />
          <span>
            This is a system capability, seeded from code. It cannot be deleted or deactivated, and
            changes to its <strong>slug</strong>, <strong>function definition</strong>,{' '}
            <strong>execution type</strong> or <strong>execution handler</strong> are refused — a
            re-seed would overwrite them. Name, description, category, rate limit, approval settings
            and execution config are yours to edit.
          </span>
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
                <p>
                  A permanent ID for this capability, used in URLs, when attaching it to agents, and{' '}
                  <strong>as the tool name the AI calls</strong> — the Function name on the Function
                  tab mirrors it.
                </p>
                <p>
                  Auto-generated from the name. Lowercase letters and numbers, separated by
                  underscores or hyphens; underscores are conventional for tool names. Cannot be
                  changed after creation.
                </p>
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
              placeholder="search_knowledge_base"
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
              rows={5}
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

          <div className="grid gap-2">
            <Label htmlFor="metadata">
              Metadata (JSON, optional){' '}
              <FieldHelp title="Custom key-value data" contentClassName="w-80">
                Arbitrary key-value pairs for tagging or external system references (e.g. external
                IDs, feature flags, notes). Values must be strings, numbers, booleans, or null.
                Maximum 100 keys. Leave empty if not needed.
              </FieldHelp>
            </Label>
            <Textarea
              id="metadata"
              className="font-mono text-sm"
              rows={4}
              placeholder='{ "team": "platform", "priority": "high" }'
              value={metadataText}
              onChange={(e) => handleMetadataChange(e.target.value)}
            />
            {metadataError && <p className="text-destructive text-xs">{metadataError}</p>}
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
            <div className="flex items-start justify-between gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <span>
                This schema has features the Builder can&apos;t represent (nested objects, enums,
                etc.). Simplify the schema to switch back, or stay in JSON mode to edit.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  // Land any pending JSON parse first — this is a mode switch
                  // like the other two, and was the only one still leaving the
                  // timer armed. It would fire after the reset had emptied the
                  // table, restoring the discarded definition into `parsedFn`
                  // and the merge baseline while Builder mode stayed on screen
                  // showing no parameters.
                  flushPendingJson();
                  let parsed: Record<string, unknown> = {};
                  try {
                    parsed = JSON.parse(jsonText || '{}') as Record<string, unknown>;
                  } catch {
                    // Fall through with empty
                  }
                  // `fnName` keeps mirroring the slug — see switchToVisualMode.
                  setFnDescription(
                    typeof parsed.description === 'string' ? parsed.description : ''
                  );
                  setRows([]);
                  setVisualDisabled(false);
                  setFnMode('visual');
                }}
              >
                Reset to Builder
              </Button>
            </div>
          )}

          {fnMode === 'visual' ? (
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="fnName">
                  Function name{' '}
                  <FieldHelp title="Function name">
                    <p>
                      The machine-readable identifier the AI uses to call this capability.{' '}
                      <strong>Always the same as the slug</strong>, so edit it on the Basics tab.
                    </p>
                    <p>
                      It has to match: when a model calls a tool, the platform looks the capability
                      up by the name it emitted. If the two could differ, a capability would be
                      permission-checked as one tool and executed as another.
                    </p>
                  </FieldHelp>
                </Label>
                <Input
                  id="fnName"
                  value={fnName}
                  readOnly
                  aria-describedby="fnName-hint"
                  placeholder="search_knowledge_base"
                  className="bg-muted font-mono"
                />
                <p id="fnName-hint" className="text-muted-foreground text-xs">
                  Mirrors the slug.
                </p>
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
                  rows={4}
                  value={fnDescription}
                  onChange={(e) => setFnDescription(e.target.value)}
                  placeholder="Search the help docs knowledge base and return matching articles."
                  className="min-h-20 resize-y"
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
                  <strong>Internal</strong> — built-in code that runs inside this application.
                  Choose this for capabilities backed by TypeScript classes in the codebase, like
                  searching the knowledge base or estimating costs. You enter the name of the code
                  class (e.g. <code>SearchKnowledgeCapability</code>).
                </p>
                <p className="mt-2">
                  <strong>API</strong> — sends a request to an external web service and waits for
                  the response. Choose this for synchronous calls where you need data back — for
                  example, calling a CRM to look up a customer, or querying a weather service. You
                  enter the full URL (e.g. <code>https://api.example.com/lookup</code>).
                </p>
                <p className="mt-2">
                  <strong>Webhook</strong> — sends a request to an external URL but does{' '}
                  <em>not</em> wait for a reply. Choose this for fire-and-forget notifications where
                  you don&apos;t need a response — for example, posting a message to Slack or
                  starting a background job. The AI continues the conversation immediately.
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

          {currentRequiresApproval && (
            <div className="grid gap-2">
              <Label htmlFor="approvalTimeoutMs">
                Approval timeout (ms){' '}
                <FieldHelp title="How long to wait for approval" contentClassName="w-80">
                  How many milliseconds the system waits for a human to approve or reject this call
                  before falling back to the global default action (deny or allow). Leave blank to
                  use the global default timeout from orchestration settings. Maximum is 3,600,000
                  ms (1 hour).
                </FieldHelp>
              </Label>
              <Input
                id="approvalTimeoutMs"
                type="number"
                {...register('approvalTimeoutMs', {
                  setValueAs: (v: string | number) =>
                    v === '' || v === null || v === undefined ? null : Number(v),
                })}
                placeholder="Use global default"
              />
              {errors.approvalTimeoutMs && (
                <p className="text-destructive text-xs">{errors.approvalTimeoutMs.message}</p>
              )}
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="rateLimit">
              Rate limit (calls per minute){' '}
              <FieldHelp title="Rate limit" contentClassName="w-80">
                The maximum number of times this capability can be called per minute per agent. This
                prevents runaway usage — for example, if an AI enters a loop calling the same tool
                repeatedly. Leave empty for no limit.
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
