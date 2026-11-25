/**
 * What `GET /api/v1/admin/access` returns, checked where the page reads it
 * (§143 t-1091).
 *
 * The shape is `AccessExplainer` in `lib/auth/access-explainer.ts`; this
 * checks it at the boundary rather than casting the response. A field the
 * route adds later is dropped here until the page uses it, and a response
 * that does not match is a load failure, shown as one.
 */
import { z } from 'zod';

import {
  ACCESS_AUDIENCES,
  ACCESS_EXPLAINER_SECTIONS,
  ACCESS_PERMISSION_ROLES,
} from '@/lib/auth/access-explainer-registry';

const audienceSchema = z.enum(ACCESS_AUDIENCES);

const roleSchema = z.object({
  key: z.string(),
  kind: z.enum(['platform', 'support', 'org-role', 'named-tier']),
  label: z.string(),
  description: z.string(),
  held: z.boolean(),
});

const modelRoleSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  held: z.boolean(),
});

const permissionRoleSchema = z.enum(ACCESS_PERMISSION_ROLES);

const modelSchema = z.object({
  platformRoles: z.array(modelRoleSchema),
  orgRoles: z.array(modelRoleSchema),
  columns: z.array(z.object({ key: permissionRoleSchema, label: z.string() })),
  permissions: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      allowed: z.object({
        platform_admin: z.boolean(),
        owner: z.boolean(),
        admin: z.boolean(),
        member: z.boolean(),
      }),
      source: z.enum(['core', 'app']),
    })
  ),
});

const switchSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  whenLacking: z.enum(['hide', 'lock']),
  setBy: z.enum(['platform', 'org']),
  held: z.boolean().nullable(),
  refusal: z.string().nullable(),
  upgradeUrl: z.string().nullable(),
});

const pageSchema = z.object({
  pattern: z.string(),
  href: z.string().nullable(),
  tier: z.string(),
  tierLabel: z.string(),
  requires: z.string().nullable(),
  requiresLabel: z.string().nullable(),
  opens: z.boolean(),
  closedBy: z.enum(['tier', 'switch', 'unread', 'policy']).nullable(),
  locked: z
    .object({
      label: z.string(),
      message: z.string(),
      upgradeUrl: z.string().nullable(),
    })
    .nullable(),
});

const areaSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  source: z.enum(['core', 'app', 'section']),
  pages: z.array(pageSchema),
});

const platformOnlySchema = z.object({
  key: z.string(),
  label: z.string(),
  reason: z.string(),
  href: z.string().nullable(),
});

const youSchema = z.object({
  audience: audienceSchema,
  orgRole: z.string().nullable(),
  tiers: z.union([z.literal('platform'), z.array(z.string())]),
  switchesOn: z.array(z.string()).nullable(),
  switchesUnreadable: z.boolean(),
  supportEntry: z.boolean(),
  tierLabels: z.record(z.string(), z.string()),
  switchLabels: z.record(z.string(), z.string()),
  anySwitches: z.boolean(),
});

export const accessExplainerResponseSchema = z.object({
  audience: audienceSchema,
  tenancy: z.enum(['single', 'multi']),
  sections: z.array(z.enum(ACCESS_EXPLAINER_SECTIONS)),
  you: youSchema.optional(),
  roles: z.array(roleSchema).optional(),
  model: modelSchema.optional(),
  areas: z.array(areaSchema).optional(),
  switches: z.array(switchSchema).optional(),
  platformOnly: z.array(platformOnlySchema).optional(),
  appSections: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      body: z.string(),
    })
  ),
});

/** The explainer, as the page reads it. */
export type AccessExplainerResponse = z.infer<typeof accessExplainerResponseSchema>;
/** One page in an area, as the page reads it. */
export type AccessExplainerPage = z.infer<typeof pageSchema>;
