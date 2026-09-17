/**
 * Tenancy validation schemas (§106).
 *
 * The request shapes of the org API. The org vocabulary itself lives in
 * `lib/tenancy/roles.ts`; the invitation's org keys are on
 * `invitationMetadataSchema` in `lib/validations/admin.ts`.
 */
import { z } from 'zod';

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
