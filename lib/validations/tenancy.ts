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

/**
 * `PATCH /api/v1/admin/orgs/[id]` body — rename, re-slug, suspend or
 * reinstate. At least one key; the route refuses an empty object.
 */
export const updateOrgSchema = z
  .object({
    name: z.string().trim().min(1, 'Name cannot be empty').max(200, 'Name is too long').optional(),
    slug: slugSchema.max(100, 'Slug is too long').optional(),
    status: z.enum(ORG_STATUSES).optional(),
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
