/**
 * Declarative schema for the structured human-approval UI.
 *
 * A workflow author attaches a `ReviewSchema` to a `human_approval` step's
 * config. At pause time the executor surfaces the schema in the trace
 * entry; the admin approval UI consumes it to render a typed
 * "accept / reject / modify per item" form in place of a wall of
 * interpolated step output. The admin's selection state is projected back
 * into the approve request's `approvalPayload`, which downstream
 * `tool_call` steps consume via `argsFrom`.
 *
 * The shape stays small: just what the provider model audit workflow
 * needs to drive a per-section, per-item, per-field UI. Other workflows
 * opt in by declaring their own schemas; the components below are
 * generic.
 */

import { z } from 'zod';

/**
 * How a field value renders, and which input replaces it when the row is
 * being modified. Pure presentation — value coercion happens in the
 * resolver, not in the component.
 *
 * `'sources'` renders an array of {@link ProvenanceItem} values as a row
 * of pills (one per source) with hover-out detail. Use for surfacing the
 * audit trail of an LLM-produced claim — the structured analogue of the
 * free-text `reason` field. Validation falls through to a JSON `<pre>`
 * if the value doesn't shape-validate against the provenance contract.
 */
export const fieldDisplaySchema = z.enum([
  'text',
  'badge',
  'pre',
  'enum',
  'number',
  'boolean',
  'textarea',
  'sources',
]);

export type FieldDisplay = z.infer<typeof fieldDisplaySchema>;

/**
 * One column on a flat item (`fields`) or sub-item row (`subItems.fields`).
 *
 * Editable enum fields resolve their values via:
 *   - `enumValuesFrom` — a static registry key (`'TIER_ROLES'`, etc.)
 *   - `enumValuesByFieldKey` — a sibling column whose value selects which
 *     registry entry to read. Lets a `proposedValue` column scope its
 *     enum to the row's `field` column, which is how audit changes work.
 *   - `enumValues` — an inline literal list, for one-off use.
 *
 * `readonly: true` overrides `editable: true` and hides the input even in
 * Modify mode. Use for identity columns (e.g. `field`, `currentValue`)
 * that anchor the row but should never change.
 */
export const fieldSpecSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  display: fieldDisplaySchema,
  editable: z.boolean().optional(),
  readonly: z.boolean().optional(),
  enumValuesFrom: z.string().min(1).max(64).optional(),
  enumValuesByFieldKey: z.string().min(1).max(64).optional(),
  enumValues: z.array(z.string().min(1).max(128)).min(1).max(64).optional(),
});

export type FieldSpec = z.infer<typeof fieldSpecSchema>;

/** A pill rendered on an item's header — sourced from one of the item's own keys. */
export const badgeSpecSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(40).optional(),
});

export type BadgeSpec = z.infer<typeof badgeSpecSchema>;

/**
 * One section of the review form. The `source` template path resolves to
 * an array of items in the trace; each item is rendered with `fields` (a
 * flat card) OR `subItems` (a parent header + nested rows).
 *
 * `__merge__:path1,path2` as a source concatenates the resolved arrays
 * from each path; this is how the audit workflow combines chat-side and
 * embedding-side deactivation proposals into one section.
 */
export const reviewSectionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-zA-Z][a-zA-Z0-9_]*$/,
        'Section id must be a JS-identifier-style key (used as approvalPayload property)'
      ),
    title: z.string().min(1).max(120),
    description: z.string().max(280).optional(),
    source: z.string().min(1).max(400),
    itemKey: z.string().min(1).max(64),
    itemTitle: z.string().min(1).max(200),
    itemBadges: z.array(badgeSpecSchema).max(8).optional(),
    fields: z.array(fieldSpecSchema).max(40).optional(),
    subItems: z
      .object({
        source: z.string().min(1).max(200),
        itemKey: z.string().min(1).max(64),
        fields: z.array(fieldSpecSchema).min(1).max(40),
      })
      .optional(),
  })
  .refine(
    (s) => s.fields !== undefined || s.subItems !== undefined,
    'Section must declare either fields (flat items) or subItems (nested rows)'
  );

export type ReviewSection = z.infer<typeof reviewSectionSchema>;

/** Top-level. Attached to `human_approval` step config as `reviewSchema`. */
export const reviewSchemaSchema = z.object({
  sections: z.array(reviewSectionSchema).min(1).max(12),
});

export type ReviewSchema = z.infer<typeof reviewSchemaSchema>;
