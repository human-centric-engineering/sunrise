/**
 * Tenancy validation schemas (§106).
 *
 * The request shapes of the org API. The org vocabulary itself lives in
 * `lib/tenancy/roles.ts`; the invitation's org keys are on
 * `invitationMetadataSchema` in `lib/validations/admin.ts`.
 */
import { z } from 'zod';
import { cuidSchema, slugSchema } from '@/lib/validations/common';
import { ORG_ROLES, ORG_STATUSES } from '@/lib/tenancy/roles';
import { ORG_ID_SHAPE } from '@/lib/tenancy/resolver';

/**
 * `POST /api/v1/orgs/switch` body.
 *
 * `orgId` is a bare non-empty string, not `cuidSchema`: the install org's id
 * is the literal `'install'` (`INSTALL_ORG_ID`), and it is the org most
 * switches name.
 */
export const switchOrgSchema = z.object({
  /** The org to act in from now on. The caller must be a member. */
  orgId: z.string().min(1, 'Org is required').max(200, 'Org id is too long'),
});

export type SwitchOrgInput = z.infer<typeof switchOrgSchema>;

/**
 * An org id as it appears in a URL segment or a body: the install org's
 * literal `'install'` or a cuid. The shape is `ORG_ID_SHAPE` from
 * `lib/tenancy/resolver.ts` — the one the proxy accepts from a resolver — so
 * a value that passes here is one the proxy would carry in a header.
 */
export const orgIdSchema = z.string().regex(ORG_ID_SHAPE, 'Invalid org id');

/** `[id]` segment of the org routes. */
export const orgIdParamSchema = z.object({ id: orgIdSchema });

/** `[id]/members/[userId]` segments. */
export const orgMemberParamsSchema = z.object({ id: orgIdSchema, userId: cuidSchema });

/**
 * `POST /api/v1/admin/orgs` body — the vendor creating a customer.
 *
 * `ownerUserId` names the founding OWNER in the same write, so the count-based
 * bootstrap arm in `membershipForNewUser` (first member of an empty org
 * becomes OWNER) is the fallback rather than the design. Optional because a
 * fork may create the org first and invite its owner into it.
 */
export const createOrgSchema = z.object({
  slug: slugSchema.max(100, 'Slug is too long'),
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
  ownerUserId: cuidSchema.optional(),
});

export type CreateOrgInput = z.infer<typeof createOrgSchema>;

/** One window: a positive whole number of days, or `null` for "keep forever". */
const retentionDays = (label: string, max: number) =>
  z
    .number()
    .int()
    .positive(`${label} must be a positive number of days`)
    .max(max, `${label} must be at most ${max} days`)
    .nullable();

/**
 * The windows an org may name in its slice. `RETENTION_WINDOW_KEYS` in
 * `lib/orchestration/retention.ts` is the same set from the sweep's side, and
 * a test holds the two level.
 */
export const ORG_RETENTION_KEYS = [
  'webhookRetentionDays',
  'webhookDlqRetentionDays',
  'costLogRetentionDays',
  'executionRetentionDays',
  'evaluationRetentionDays',
] as const;

/**
 * The retention windows an org may set for itself (§108 t-713), and the
 * bounds each one is held to — the same bounds the global settings schema
 * applies to its own column, because these values overlay those — with one
 * exception, which is the one sentence here a reader could otherwise
 * disprove. `webhookDlqRetentionDays` has **no** field in the global settings
 * schema and no form control: the column exists and the prune reads it, but
 * nothing writes it. So that bound is not mirroring a global one, and this
 * slice is currently the only way to set that window at all. Filed against the
 * global surface rather than widened here.
 *
 * **Five keys, not the six on `AiOrchestrationSettings`.** The sixth,
 * `auditLogRetentionDays`, prunes `AiAdminAuditLog` — a system model with no
 * `orgId` — which §108 t-711 moved to the system-scoped sweep. Rows nobody
 * owns cannot be kept per owner, so there is nothing for an org to set. The
 * MCP audit log is the same shape and lives on `McpServerConfig`.
 *
 * Per key: **absent** inherits the global window, and an explicit **`null`**
 * carries whatever `null` already means for that column on the global row.
 *
 * For four of the five that is **keep this class forever**. It is not for
 * `webhookDlqRetentionDays`: `pruneWebhookDeliveries` reads a null DLQ window
 * as "use `webhookRetentionDays`" — the fallback that preserved pre-DLQ
 * behaviour for installs that never set the newer column — so an org that
 * nulls it gets its dead-lettered rows pruned on its *webhook* window, not
 * kept. Saying "null keeps it forever" of all five was wrong in the first
 * draft of this file, and there is no way today to express "prune deliveries
 * but never the DLQ" at either level. Changing that would change the global
 * column's meaning, which is not this task's to do.
 *
 * `.strict()` on both objects: an unknown key here is a typo that would
 * otherwise be written and silently ignored for ever. A fork storing its own
 * slice of `Org.settings` owns its own route for it — this one is the
 * platform's `retention` slice and nothing else.
 */
export const orgRetentionSchema = z
  .object({
    webhookRetentionDays: retentionDays('Webhook retention', 365).optional(),
    webhookDlqRetentionDays: retentionDays('Webhook DLQ retention', 365).optional(),
    costLogRetentionDays: retentionDays('Cost log retention', 365).optional(),
    executionRetentionDays: retentionDays('Execution retention', 3650).optional(),
    evaluationRetentionDays: retentionDays('Evaluation retention', 3650).optional(),
  })
  .strict();

/**
 * One org's slice of `Org.settings`. Every key optional, so the stored object
 * says only what the org has chosen to differ on.
 *
 * Deliberately no coherence refine (`costLogRetentionDays >=
 * executionRetentionDays`) even though the global schema carries one: the pair
 * that governs a prune is the **effective** one — this slice overlaid on the
 * global row — so a rule applied to the slice alone would pass a body that is
 * incoherent once inherited, and refuse one that is coherent. The admin route
 * checks the effective pair, and the sweep warns per org when a later change
 * to the global row makes a stored slice incoherent.
 */
export type OrgRetentionSlice = z.infer<typeof orgRetentionSchema>;

/**
 * A jurisdiction code: where a provider processes data (`AiProviderConfig
 * .jurisdiction`), and what an org's provider policy may restrict to (§120
 * t-742). The operator chooses the vocabulary — `EU`, `US`, `UK`, `EU-DE` —
 * so this checks a shape, not a list. Stored upper-cased, so `eu` and `EU`
 * are one code and a match never turns on case.
 */
export const jurisdictionSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z][A-Za-z0-9-]{0,31}$/,
    'Jurisdiction must be a short code of letters, digits and hyphens, starting with a letter (e.g. EU, US, EU-DE)'
  )
  .transform((code) => code.toUpperCase());

/** An org's jurisdiction restriction: `null` means none. */
const jurisdictionList = z
  .array(jurisdictionSchema)
  .min(1, 'Name at least one jurisdiction, or send null for no restriction')
  .max(50, 'At most 50 jurisdictions')
  .transform((codes) => [...new Set(codes)])
  .nullable();

/**
 * One org's provider policy as STORED in `Org.settings.providers` (§120
 * t-742): the provider rows a platform admin has approved it for, by id, and
 * optionally the jurisdictions it is held to.
 *
 * Providers are global (design Q3), so `approved` is a permission over the
 * operator's provider rows — not a list of the org's own providers. `[]`
 * approves nothing, which is where every org but the install org starts.
 *
 * **Row ids, not slugs.** A slug can be renamed, deleted and re-created by a
 * platform admin, a seed or an import; a grant keyed on it would follow the
 * slug to whatever row holds it next. An id cannot move, so a renamed row
 * keeps its grants and a re-created one starts with none.
 *
 * `jurisdictions`, when present, restricts the approved set further: a
 * provider is permitted only if its recorded jurisdiction is one of them, and
 * a provider with none recorded matches no restriction.
 *
 * `.strict()` on read too, deliberately: the read fails closed, and a key it
 * does not know may be a restriction it would otherwise ignore.
 */
export const orgProviderPolicySchema = z
  .object({
    approved: z
      .array(z.string().min(1).max(64))
      .max(200, 'At most 200 providers')
      .transform((ids) => [...new Set(ids)]),
    // Stored without the key when there is no restriction.
    jurisdictions: jurisdictionList.optional(),
  })
  .strict();

export type OrgProviderPolicy = z.infer<typeof orgProviderPolicySchema>;

/**
 * `PUT /api/v1/admin/orgs/[id]/providers` body: the same policy, naming
 * providers by SLUG, which is what an operator knows them by. The route
 * resolves each slug to its row and stores the ids; an unknown slug is a 400.
 * Duplicates are folded on the way in.
 *
 * **`jurisdictions` is required**, as a list or `null`. A PUT replaces the
 * whole policy, so an optional key would let a caller who meant only to add a
 * provider silently lift the org's jurisdiction restriction — a write that
 * widens what an org's data may reach must say so.
 */
export const orgProviderPolicyInputSchema = z
  .object({
    approved: z
      .array(slugSchema.max(50, 'Provider slug must be less than 50 characters'))
      .max(200, 'At most 200 providers')
      .transform((slugs) => [...new Set(slugs)]),
    jurisdictions: jurisdictionList,
  })
  .strict();

export type OrgProviderPolicyInput = z.infer<typeof orgProviderPolicyInputSchema>;

/**
 * The platform-owned slices of `Org.settings` a PATCH may write.
 *
 * `retention: null` removes the slice, so the org inherits every global
 * window again. Omitting `retention` leaves the stored slice alone, and any
 * other key a fork keeps in `settings` is preserved either way — the write
 * replaces this slice rather than merging into unknown JSON.
 */
export const orgSettingsPatchSchema = z
  .object({
    retention: orgRetentionSchema.nullable().optional(),
  })
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, {
    message: 'Settings must name at least one slice',
  });

export type OrgSettingsPatch = z.infer<typeof orgSettingsPatchSchema>;

/**
 * `PATCH /api/v1/admin/orgs/[id]` body — rename, re-slug, suspend, reinstate,
 * or set the org's own retention windows. At least one key; the route refuses
 * an empty object.
 */
export const updateOrgSchema = z
  .object({
    name: z.string().trim().min(1, 'Name cannot be empty').max(200, 'Name is too long').optional(),
    slug: slugSchema.max(100, 'Slug is too long').optional(),
    status: z.enum(ORG_STATUSES).optional(),
    settings: orgSettingsPatchSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field must be provided',
  });

export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;

/** `POST /api/v1/orgs/[id]/members` body — add an existing user. */
export const addOrgMemberSchema = z.object({
  userId: cuidSchema,
  /** Defaults to MEMBER. Refused on the install org, whose roles follow the platform role. */
  role: z.enum(ORG_ROLES).optional(),
});

export type AddOrgMemberInput = z.infer<typeof addOrgMemberSchema>;

/** `PATCH /api/v1/orgs/[id]/members/[userId]` body. */
export const updateOrgMemberSchema = z.object({
  role: z.enum(ORG_ROLES),
});

export type UpdateOrgMemberInput = z.infer<typeof updateOrgMemberSchema>;
